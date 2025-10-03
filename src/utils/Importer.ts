import { format, subMonths } from 'date-fns';
import type { ImportTransaction } from './ActualApi.js';
import type { Account as MonMonAccount, Transaction as MonMonTransaction } from 'moneymoney';
import { getTransactions } from 'moneymoney';
import { AccountMap } from './AccountMap.js';
import ActualApi from './ActualApi.js';
import type { ActualBudgetConfig, Config } from './config.js';
import Logger from './Logger.js';
import PayeeTransformer from './PayeeTransformer.js';
import { DATE_FORMAT } from './shared.js';
class Importer {
    public constructor(
        private config: Config,
        private budgetConfig: ActualBudgetConfig,
        private actualApi: ActualApi,
        private logger: Logger,
        private accountMap: AccountMap,
        private payeeTransformer?: PayeeTransformer
    ) {}
    private readonly patternCache = new Map<string, RegExp>();
    public async importTransactions({
        accountRefs,
        from,
        to: toDate,
        isDryRun = false,
    }: {
        accountRefs?: Array<string>;
        from?: Date;
        to?: Date;
        isDryRun?: boolean;
    }) {
        const importDate = this.calculateImportDate(from);
        const monMonTransactions = await this.fetchAndFilterTransactions(importDate, toDate);
        if (monMonTransactions.length === 0) {
            this.logger.info(`No transactions found in MoneyMoney since ${format(importDate, DATE_FORMAT)}.`);
            return;
        }
        const monMonTransactionMap = this.groupTransactionsByAccount(monMonTransactions);
        const accountMapping = this.accountMap.getMap(accountRefs);
        const { totalAdded, totalUpdated } = await this.processAllAccounts(
            accountMapping,
            monMonTransactionMap,
            importDate,
            toDate,
            isDryRun
        );
        if (totalAdded > 0 || totalUpdated > 0) {
            this.logger.info(`Import complete: ${totalAdded} added, ${totalUpdated} updated across all accounts`);
        } else {
            this.logger.info('No new transactions to import.');
        }
    }
    private calculateImportDate(from?: Date): Date {
        const fromDate = from ?? subMonths(new Date(), 1);
        const earliestImportDate = this.budgetConfig.earliestImportDate
            ? new Date(this.budgetConfig.earliestImportDate)
            : null;
        return earliestImportDate && earliestImportDate > fromDate ? earliestImportDate : fromDate;
    }
    private async fetchAndFilterTransactions(importDate: Date, toDate?: Date): Promise<MonMonTransaction[]> {
        let monMonTransactions: MonMonTransaction[];
        try {
            monMonTransactions = await getTransactions({ from: importDate, to: toDate });
        } catch (error) {
            if (error && typeof error === 'object' && 'name' in error && error.name === 'DatabaseLockedError') {
                this.logger.error('MoneyMoney database is locked. Please unlock MoneyMoney and try again.');
                throw error;
            }
            throw error;
        }
        monMonTransactions = this.sortTransactions(monMonTransactions);
        // Apply filters
        if (!this.config.import.importUncheckedTransactions) {
            monMonTransactions = monMonTransactions.filter((t) => t.booked);
        }
        const ignorePatterns = this.config.import.ignorePatterns;
        if (ignorePatterns?.payeePatterns) {
            monMonTransactions = monMonTransactions.filter(
                (t) => !this.matchesPattern(t.name, ignorePatterns.payeePatterns)
            );
        }
        if (ignorePatterns?.commentPatterns) {
            monMonTransactions = monMonTransactions.filter(
                (t) => !this.matchesPattern(t.comment, ignorePatterns.commentPatterns)
            );
        }
        if (ignorePatterns?.purposePatterns) {
            monMonTransactions = monMonTransactions.filter(
                (t) => !this.matchesPattern(t.purpose, ignorePatterns.purposePatterns)
            );
        }
        return monMonTransactions;
    }
    private groupTransactionsByAccount(transactions: MonMonTransaction[]): Record<string, MonMonTransaction[]> {
        return transactions.reduce(
            (acc, transaction) => {
                (acc[transaction.accountUuid] ??= []).push(transaction);
                return acc;
            },
            {} as Record<string, MonMonTransaction[]>
        );
    }
    private async processAllAccounts(
        accountMapping: Map<MonMonAccount, Awaited<ReturnType<ActualApi['getAccounts']>>[number]>,
        monMonTransactionMap: Record<string, MonMonTransaction[]>,
        importDate: Date,
        toDate: Date | undefined,
        isDryRun: boolean
    ): Promise<{ totalAdded: number; totalUpdated: number }> {
        let totalAdded = 0;
        let totalUpdated = 0;
        for (const [monMonAccount, actualAccount] of accountMapping) {
            const accountTransactions = monMonTransactionMap[monMonAccount.uuid] ?? [];
            const result = await this.processAccountTransactions(
                monMonAccount,
                actualAccount,
                accountTransactions,
                importDate,
                toDate,
                isDryRun
            );
            if (result) {
                totalAdded += result.added;
                totalUpdated += result.updated;
            }
        }
        return { totalAdded, totalUpdated };
    }
    private async processAccountTransactions(
        monMonAccount: MonMonAccount,
        actualAccount: { id: string; name: string },
        accountTransactions: MonMonTransaction[],
        importDate: Date,
        toDate: Date | undefined,
        isDryRun: boolean
    ): Promise<{ added: number; updated: number } | null> {
        // Convert transactions with individual error handling
        const createTransactions = await this.convertTransactionsWithErrorHandling(
            accountTransactions,
            actualAccount.id
        );
        const existingActualTransactions = await this.actualApi.getTransactions(actualAccount.id, {
            from: importDate,
            to: toDate ?? undefined,
        });
        // Add starting balance if needed
        this.addStartingBalanceIfNeeded(
            monMonAccount,
            actualAccount.id,
            accountTransactions,
            importDate,
            existingActualTransactions,
            createTransactions
        );
        // Filter out existing transactions
        const existingIds = new Set(
            existingActualTransactions.map((t) => t.imported_id).filter((id): id is string => Boolean(id))
        );
        const filteredTransactions = createTransactions.filter((t) => {
            const id = t.imported_id;
            if (!id) {
                this.logger.warn(`Transaction missing imported_id, will be skipped: ${JSON.stringify(t)}`);
            }
            return id && !existingIds.has(id);
        });
        if (filteredTransactions.length === 0) {
            this.logger.debug(`No new transactions found for Actual account '${actualAccount.name}'. Skipping...`);
            return null;
        }
        // Handle payee transformation
        await this.handlePayeeTransformation(filteredTransactions, isDryRun);
        // Import transactions
        if (isDryRun) {
            this.logger.info(
                `DRY RUN - Would import ${filteredTransactions.length} transactions to '${actualAccount.name}'`
            );
            return { added: filteredTransactions.length, updated: 0 };
        } else {
            const result = await this.actualApi.importTransactions(actualAccount.id, filteredTransactions);
            if (result.errors && result.errors.length > 0) {
                this.logger.error(
                    `Import errors: ${result.errors.length} errors occurred`,
                    [
                        ...result.errors.slice(0, 5).map((err: unknown) => String(err)),
                        result.errors.length > 5 ? `... and ${result.errors.length - 5} more errors` : '',
                    ].filter(Boolean)
                );
            }
            this.logger.info(`Import successful: ${result.added.length} added, ${result.updated.length} updated`);
            return { added: result.added.length, updated: result.updated.length };
        }
    }
    private sortTransactions(transactions: MonMonTransaction[]) {
        return [...transactions].sort((left, right) => {
            const leftTime = this.getTransactionTime(left.valueDate);
            const rightTime = this.getTransactionTime(right.valueDate);
            if (leftTime < rightTime) {
                return -1;
            }
            if (leftTime > rightTime) {
                return 1;
            }
            const leftId = left.id === undefined || left.id === null ? '' : String(left.id);
            const rightId = right.id === undefined || right.id === null ? '' : String(right.id);
            return leftId.localeCompare(rightId);
        });
    }
    private getTransactionTime(valueDate: MonMonTransaction['valueDate']) {
        if (!(valueDate instanceof Date)) {
            return Number.POSITIVE_INFINITY;
        }
        const time = valueDate.getTime();
        if (Number.isNaN(time)) {
            return Number.POSITIVE_INFINITY;
        }
        return time;
    }
    private async convertToActualTransaction(
        transaction: MonMonTransaction,
        accountId: string
    ): Promise<ImportTransaction> {
        this.assertValidTransaction(transaction);
        return {
            account: accountId,
            date: format(transaction.valueDate, DATE_FORMAT),
            amount: Math.round(transaction.amount * 100),
            imported_id: this.getIdForMoneyMoneyTransaction(transaction),
            imported_payee: transaction.name,
            cleared: this.config.import.synchronizeClearedStatus ? transaction.booked : undefined,
            notes: transaction.purpose,
            payee_name: transaction.name,
        };
    }
    private assertValidTransaction(transaction: MonMonTransaction): void {
        const issues: string[] = [];
        const hasValidDate = transaction.valueDate instanceof Date && !Number.isNaN(transaction.valueDate.getTime());
        if (!hasValidDate) {
            issues.push('valueDate is missing or invalid');
        }
        if (
            typeof transaction.amount !== 'number' ||
            Number.isNaN(transaction.amount) ||
            !Number.isFinite(transaction.amount)
        ) {
            issues.push('amount is missing or invalid');
        }
        const transactionName = transaction.name;
        if (typeof transactionName !== 'string' || transactionName.trim().length === 0) {
            issues.push('name is missing or invalid');
        }
        if (!transaction.id) {
            issues.push('id is missing');
        }
        if (!transaction.accountUuid) {
            issues.push('accountUuid is missing');
        }
        if (issues.length === 0) {
            return;
        }
        const transactionId = transaction.id ?? '(missing)';
        const accountUuid = transaction.accountUuid ?? '(missing)';
        const message = `MoneyMoney returned a malformed transaction (id: ${transactionId}, account: ${accountUuid}). ${issues.join(
            '; '
        )}.`;
        this.logger.error(message, [
            `Transaction ID: ${transactionId}`,
            `MoneyMoney account UUID: ${accountUuid}`,
            'Export a fresh transactions report from MoneyMoney or repair the database before retrying.',
        ]);
        throw new Error(message);
    }
    private getIdForMoneyMoneyTransaction(transaction: MonMonTransaction) {
        return `${transaction.accountUuid}-${transaction.id}`;
    }
    private getStartingBalanceForAccount(account: MonMonAccount, transactions: MonMonTransaction[]) {
        // Use the first (earliest) balance entry, not the last
        const firstBalanceRow = account.balance[0];
        const monMonAccountBalance = firstBalanceRow?.[0];
        if (monMonAccountBalance === undefined) {
            this.logger.warn(
                `MoneyMoney account '${account.uuid}' is missing a balance entry. Assuming a starting balance of 0.`,
                ['Check the account configuration or refresh balances in MoneyMoney before re-running the import.']
            );
            return 0;
        }
        const netChange = transactions.reduce(
            (acc, transaction) => acc + (transaction.booked ? transaction.amount : 0),
            0
        );
        const startingBalance = Math.round((monMonAccountBalance - netChange) * 100);
        return startingBalance;
    }
    private matchesPattern(value: string | undefined, patterns?: string[]) {
        if (!value || !patterns?.length) return false;
        return patterns.some((pattern) => {
            const regex =
                this.patternCache.get(pattern) ||
                (() => {
                    // Escape all regex special characters except * which we want to convert to .*
                    const escapedPattern = pattern
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape all regex special chars
                        .replace(/\\\*/g, '.*'); // Convert escaped * back to .*
                    // Anchor the pattern to match the entire string
                    return new RegExp(`^${escapedPattern}$`, 'i');
                })();
            this.patternCache.set(pattern, regex);
            return regex.test(value);
        });
    }
    private async convertTransactionsWithErrorHandling(
        accountTransactions: MonMonTransaction[],
        accountId: string
    ): Promise<ImportTransaction[]> {
        const createTransactions: ImportTransaction[] = [];
        const conversionErrors: string[] = [];
        for (const transaction of accountTransactions) {
            try {
                const converted = await this.convertToActualTransaction(transaction, accountId);
                createTransactions.push(converted);
            } catch (error) {
                const errorMessage = `Failed to convert transaction ${transaction.id}: ${error instanceof Error ? error.message : String(error)}`;
                conversionErrors.push(errorMessage);
                this.logger.warn(errorMessage, [
                    `Transaction ID: ${transaction.id}`,
                    `Account UUID: ${transaction.accountUuid}`,
                    'This transaction will be skipped from the import.',
                ]);
            }
        }
        if (conversionErrors.length > 0) {
            this.logger.warn(
                `Skipped ${conversionErrors.length} invalid transactions during conversion`,
                conversionErrors
            );
        }
        return createTransactions;
    }

    private addStartingBalanceIfNeeded(
        monMonAccount: MonMonAccount,
        accountId: string,
        accountTransactions: MonMonTransaction[],
        importDate: Date,
        existingActualTransactions: Array<{ imported_id?: string }>,
        createTransactions: ImportTransaction[]
    ): void {
        if (existingActualTransactions.length === 0 && createTransactions.length > 0) {
            const firstTransaction = accountTransactions[0];
            const startDate = firstTransaction?.valueDate ?? importDate;
            const startTransaction: ImportTransaction = {
                account: accountId,
                date: format(startDate, DATE_FORMAT),
                amount: this.getStartingBalanceForAccount(monMonAccount, accountTransactions),
                imported_id: `${monMonAccount.uuid}-start`,
                cleared: true,
                notes: 'Starting balance',
                imported_payee: 'Starting balance',
            };
            createTransactions.push(startTransaction);
        }
    }

    private async handlePayeeTransformation(
        filteredTransactions: ImportTransaction[],
        isDryRun: boolean
    ): Promise<void> {
        if (this.payeeTransformer && this.config.payeeTransformation?.enabled && !isDryRun) {
            try {
                const uniquePayees = Array.from(
                    new Set(filteredTransactions.map((t) => String(t.imported_payee ?? '')))
                );
                const transformedPayees = await this.payeeTransformer.transformPayees(uniquePayees);
                if (transformedPayees) {
                    filteredTransactions.forEach((t) => {
                        const original = t.imported_payee as string;
                        const transformed = transformedPayees[original];
                        t.payee_name = transformed && transformed.toLowerCase() !== 'unknown' ? transformed : original;
                    });
                } else {
                    filteredTransactions.forEach((t) => {
                        t.payee_name = t.imported_payee;
                    });
                }
            } catch (error) {
                this.logger.warn(
                    'Payee transformation failed, using original payees',
                    error instanceof Error ? error.message : String(error)
                );
                filteredTransactions.forEach((t) => {
                    t.payee_name = t.imported_payee;
                });
            }
        } else {
            filteredTransactions.forEach((t) => {
                t.payee_name = t.imported_payee;
            });
        }
    }
}
export default Importer;
