import { format, subMonths } from 'date-fns';
import type { CreateTransaction } from '@actual-app/api';
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
        const fromDate = from ?? subMonths(new Date(), 1);
        const earliestImportDate = this.budgetConfig.earliestImportDate
            ? new Date(this.budgetConfig.earliestImportDate)
            : null;
        const importDate = earliestImportDate && earliestImportDate > fromDate ? earliestImportDate : fromDate;

        let monMonTransactions = await getTransactions({ from: importDate, to: toDate });
        monMonTransactions = this.sortTransactions(monMonTransactions);

        if (monMonTransactions.length === 0) {
            this.logger.info(`No transactions found in MoneyMoney since ${format(importDate, DATE_FORMAT)}.`);
            return;
        }

        // Simple filtering
        if (!this.config.import.importUncheckedTransactions) {
            monMonTransactions = monMonTransactions.filter((t) => t.booked);
        }
        if (this.config.import.ignorePatterns?.payeePatterns) {
            monMonTransactions = monMonTransactions.filter(
                (t) => !this.matchesPattern(t.name, this.config.import.ignorePatterns!.payeePatterns)
            );
        }

        const monMonTransactionMap = monMonTransactions.reduce(
            (acc, transaction) => {
                (acc[transaction.accountUuid] ??= []).push(transaction);
                return acc;
            },
            {} as Record<string, MonMonTransaction[]>
        );

        const accountMapping = this.accountMap.getMap(accountRefs);
        let hasNewTransactions = false;

        for (const [monMonAccount, actualAccount] of accountMapping) {
            const accountTransactions = monMonTransactionMap[monMonAccount.uuid] ?? [];
            const processed = await this.processAccountTransactions(
                monMonAccount,
                actualAccount,
                accountTransactions,
                importDate,
                toDate,
                isDryRun
            );
            if (processed) hasNewTransactions = true;
        }

        if (!hasNewTransactions) {
            this.logger.info('No new transactions to import.');
        }
    }

    private async processAccountTransactions(
        monMonAccount: MonMonAccount,
        actualAccount: { id: string; name: string },
        accountTransactions: MonMonTransaction[],
        importDate: Date,
        toDate: Date | undefined,
        isDryRun: boolean
    ): Promise<boolean> {
        const createTransactions: CreateTransaction[] = await Promise.all(
            accountTransactions.map((t) => this.convertToActualTransaction(t))
        );

        const existingActualTransactions = await this.actualApi.getTransactions(actualAccount.id, {
            from: importDate,
            to: toDate ?? undefined,
        });

        // Add starting balance if needed
        if (existingActualTransactions.length === 0 && createTransactions.length > 0) {
            const firstTransaction = accountTransactions[0];
            const startDate = firstTransaction?.valueDate ?? importDate;
            const startTransaction: CreateTransaction = {
                date: format(startDate, DATE_FORMAT),
                amount: this.getStartingBalanceForAccount(monMonAccount, accountTransactions),
                imported_id: `${monMonAccount.uuid}-start`,
                cleared: true,
                notes: 'Starting balance',
                imported_payee: 'Starting balance',
            };
            createTransactions.push(startTransaction);
        }

        // Filter out existing transactions
        const existingIds = new Set(
            existingActualTransactions.map((t) => t.imported_id).filter((id): id is string => Boolean(id))
        );

        const filteredTransactions = createTransactions.filter((t) => {
            const id = t.imported_id;
            return id && !existingIds.has(id);
        });

        if (filteredTransactions.length === 0) {
            this.logger.debug(`No new transactions found for Actual account '${actualAccount.name}'. Skipping...`);
            return false;
        }

        // Handle payee transformation
        if (this.payeeTransformer && !isDryRun) {
            const uniquePayees = Array.from(new Set(filteredTransactions.map((t) => String(t.imported_payee ?? ''))));
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
        } else {
            filteredTransactions.forEach((t) => {
                t.payee_name = t.imported_payee;
            });
        }

        // Import transactions
        if (isDryRun) {
            this.logger.info(
                `DRY RUN - Would import ${filteredTransactions.length} transactions to '${actualAccount.name}'`
            );
        } else {
            const result = await this.actualApi.importTransactions(actualAccount.id, filteredTransactions);

            if (result.errors && result.errors.length > 0) {
                this.logger.error(`Import errors: ${result.errors.length} errors occurred`);
            }

            this.logger.info(`Import successful: ${result.added.length} added, ${result.updated.length} updated`);
        }

        return true;
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

    private async convertToActualTransaction(transaction: MonMonTransaction): Promise<CreateTransaction> {
        this.assertValidTransaction(transaction);

        return {
            date: format(transaction.valueDate, DATE_FORMAT),
            amount: Math.round(transaction.amount * 100),
            imported_id: this.getIdForMoneyMoneyTransaction(transaction),
            imported_payee: transaction.name,
            cleared: this.config.import.synchronizeClearedStatus ? transaction.booked : undefined,
            notes: transaction.purpose,
            // payee_name: transaction.name,
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
            const regex = this.patternCache.get(pattern) || new RegExp(pattern.replace(/\*/g, '.*'), 'i');
            this.patternCache.set(pattern, regex);
            return regex.test(value);
        });
    }
}

export default Importer;
