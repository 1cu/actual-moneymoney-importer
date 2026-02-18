import { format, subMonths } from 'date-fns';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
    Account as MonMonAccount,
    Transaction as MonMonTransaction,
    getTransactions,
} from 'moneymoney';
import { AccountMap } from './AccountMap.js';
import ActualApi from './ActualApi.js';
import CategoryMap from './CategoryMap.js';
import { ActualBudgetConfig, Config } from './config.js';
import Logger from './Logger.js';
import PayeeTransformer from './PayeeTransformer.js';
import { DATE_FORMAT } from './shared.js';

type ExistingCategorySyncPolicy = Config['import']['categorySyncOnExisting'];
type CategoryUpdateClassification =
    | { type: 'backfill'; targetCategoryId: string }
    | {
          type: 'conflict';
          targetCategoryId: string;
          currentCategoryId: string;
      }
    | { type: 'noop' };

type ExistingTransactionPair = {
    monMonTransaction: MonMonTransaction;
    actualTransaction: ReadTransaction;
};

type ExistingCategoryUpdate = {
    transactionId: string;
    importedId: string;
    fromCategoryId?: string;
    toCategoryId: string;
    reason: 'backfill' | 'conflict';
    monMonTransaction: MonMonTransaction;
};

type PromptMode = 'prompt' | 'all' | 'none';
type PromptDecision = boolean | 'all' | 'none' | 'quit';
type PromptState = {
    mode: PromptMode;
    promptInterface?: ReturnType<typeof createInterface>;
};
type CategoryUpdatePlan = {
    pendingUpdates: ExistingCategoryUpdate[];
    backfillCount: number;
    conflictCount: number;
    skippedConflictCount: number;
};

export const classifyCategoryUpdate = ({
    currentCategoryId,
    targetCategoryId,
    isUncategorized,
}: {
    currentCategoryId: string | undefined;
    targetCategoryId: string | undefined;
    isUncategorized: boolean;
}): CategoryUpdateClassification => {
    if (isUncategorized || !targetCategoryId) {
        return { type: 'noop' };
    }

    if (!currentCategoryId) {
        return { type: 'backfill', targetCategoryId };
    }

    if (currentCategoryId === targetCategoryId) {
        return { type: 'noop' };
    }

    return {
        type: 'conflict',
        targetCategoryId,
        currentCategoryId,
    };
};

export const parsePromptDecision = (
    answer: string
): PromptDecision | 'invalid' => {
    const trimmed = answer.trim();
    const normalized = trimmed.toLowerCase();

    if (trimmed === 'A') {
        return 'all';
    }

    if (trimmed === 'N') {
        return 'none';
    }

    if (normalized === 'y' || normalized === 'yes') {
        return true;
    }

    if (normalized === 'n' || normalized === 'no') {
        return false;
    }

    if (normalized === 'all') {
        return 'all';
    }

    if (normalized === 'none') {
        return 'none';
    }

    if (normalized === 'q' || normalized === 'quit') {
        return 'quit';
    }

    return 'invalid';
};

const buildExistingCategoryUpdate = ({
    pair,
    targetCategoryId,
    reason,
    fromCategoryId,
}: {
    pair: ExistingTransactionPair;
    targetCategoryId: string;
    reason: 'backfill' | 'conflict';
    fromCategoryId?: string;
}): ExistingCategoryUpdate => {
    return {
        transactionId: pair.actualTransaction.id,
        importedId: pair.actualTransaction.imported_id,
        ...(fromCategoryId ? { fromCategoryId } : {}),
        toCategoryId: targetCategoryId,
        reason,
        monMonTransaction: pair.monMonTransaction,
    };
};

class Importer {
    constructor(
        private config: Config,
        private budgetConfig: ActualBudgetConfig,
        private actualApi: ActualApi,
        private logger: Logger,
        private accountMap: AccountMap,
        private categoryMap: CategoryMap,
        private payeeTransformer?: PayeeTransformer
    ) {}

    async importTransactions({
        accountRefs,
        from,
        to: toDate,
        isDryRun = false,
        categorySyncOnExisting,
    }: {
        accountRefs?: Array<string>;
        from?: Date;
        to?: Date;
        isDryRun?: boolean;
        categorySyncOnExisting?: ExistingCategorySyncPolicy;
    }) {
        const existingCategoryPolicy =
            categorySyncOnExisting ?? this.config.import.categorySyncOnExisting;

        const fromDate = from ?? subMonths(new Date(), 1);
        const earliestImportDate = this.budgetConfig.earliestImportDate
            ? new Date(this.budgetConfig.earliestImportDate)
            : null;

        const importDate =
            earliestImportDate && earliestImportDate > fromDate
                ? earliestImportDate
                : fromDate;

        if (earliestImportDate && earliestImportDate > fromDate) {
            this.logger.warn(
                `Earliest import date is set to ${format(
                    earliestImportDate,
                    DATE_FORMAT
                )}. Using this date instead of ${format(fromDate, DATE_FORMAT)}.`
            );
        }

        this.logger.debug(
            `Cleared status synchronization is ${
                this.config.import.synchronizeClearedStatus
                    ? 'enabled'
                    : 'disabled'
            }`
        );

        this.logger.debug(
            `Category synchronization is ${
                this.config.import.synchronizeCategories
                    ? `enabled (existing policy: ${existingCategoryPolicy})`
                    : 'disabled'
            }`
        );

        const getTransactionsOptions: {
            from: Date;
            to?: Date;
        } = {
            from: importDate,
        };

        if (toDate) {
            getTransactionsOptions.to = toDate;
        }

        let monMonTransactions = await getTransactions(getTransactionsOptions);

        if (monMonTransactions.length === 0) {
            this.logger.info(
                `No transactions found in MoneyMoney since ${format(
                    importDate,
                    DATE_FORMAT
                )}.`
            );
            return;
        }

        if (!this.config.import.importUncheckedTransactions) {
            monMonTransactions = monMonTransactions.filter((t) => t.booked);
        }

        if (this.config.import.ignorePatterns !== undefined) {
            const ignorePatterns = this.config.import.ignorePatterns;

            monMonTransactions = monMonTransactions.filter((t) => {
                let isIgnored = (ignorePatterns.commentPatterns ?? []).some(
                    (pattern) => t.comment?.includes(pattern)
                );

                isIgnored ||= (ignorePatterns.payeePatterns ?? []).some(
                    (pattern) => t.name.includes(pattern)
                );

                isIgnored ||= (ignorePatterns.purposePatterns ?? []).some(
                    (pattern) => t.purpose?.includes(pattern)
                );

                if (isIgnored) {
                    this.logger.debug(
                        `Ignoring transaction ${t.id} (${t.name}) due to ignore patterns`
                    );
                }

                return !isIgnored;
            });
        }

        this.logger.debug(
            `Found ${
                monMonTransactions.length
            } total transactions in MoneyMoney since ${format(
                importDate,
                DATE_FORMAT
            )}`
        );

        const monMonTransactionMap = monMonTransactions.reduce(
            (acc, transaction) => {
                if (!acc[transaction.accountUuid]) {
                    acc[transaction.accountUuid] = [];
                }

                acc[transaction.accountUuid]?.push(transaction);

                return acc;
            },
            {} as Record<string, MonMonTransaction[]>
        );

        const accountMapping = this.accountMap.getMap(accountRefs);

        let existingPayeeNames: string[] = [];
        if (this.payeeTransformer && !isDryRun) {
            const existingPayees = await this.actualApi.getPayees();
            existingPayeeNames = existingPayees
                .filter(
                    (p: { name: string; transfer_acct?: string }) =>
                        p.name && !p.transfer_acct
                )
                .map((p: { name: string }) => p.name);

            this.logger.debug(
                `Found ${existingPayeeNames.length} existing payees in Actual budget`
            );
        }

        const unmappedCategoryWarnings = new Set<string>();
        const shouldSyncCategories = this.config.import.synchronizeCategories;

        const promptState: PromptState = { mode: 'prompt' };

        try {
            for (const [monMonAccount, actualAccount] of accountMapping) {
                const accountTransactions =
                    monMonTransactionMap[monMonAccount.uuid] ?? [];

                const existingActualTransactions =
                    await this.actualApi.getTransactions(actualAccount.id);
                const { newMonMonTransactions, existingPairs } =
                    this.buildAccountTransactionBuckets({
                        accountTransactions,
                        existingActualTransactions,
                        actualAccountName: actualAccount.name,
                        shouldSyncCategories,
                    });

                const createTransactions: CreateTransaction[] = [];
                for (const transaction of newMonMonTransactions) {
                    const createTransaction =
                        await this.convertToActualTransaction(transaction);

                    if (shouldSyncCategories) {
                        const categoryResolution =
                            this.categoryMap.getMappedActualCategoryId(
                                transaction.categoryUuid
                            );

                        if (categoryResolution.actualCategoryId) {
                            createTransaction.category =
                                categoryResolution.actualCategoryId;
                        } else if (
                            !categoryResolution.isUncategorized &&
                            !categoryResolution.isMapped
                        ) {
                            const warningKey =
                                categoryResolution.categoryPath ??
                                transaction.categoryUuid;

                            if (!unmappedCategoryWarnings.has(warningKey)) {
                                unmappedCategoryWarnings.add(warningKey);
                                this.logger.warn(
                                    `No category mapping found for MoneyMoney category '${warningKey}'. Transaction categories will be left untouched.`
                                );
                            }
                        }
                    }

                    createTransactions.push(createTransaction);
                }

                if (existingActualTransactions.length === 0) {
                    const startTransaction: CreateTransaction = {
                        date: format(
                            accountTransactions.length > 0
                                ? (accountTransactions.at(-1)?.valueDate ??
                                      new Date())
                                : new Date(),
                            DATE_FORMAT
                        ),
                        amount: this.getStartingBalanceForAccount(
                            monMonAccount,
                            accountTransactions
                        ),
                        imported_id: `${monMonAccount.uuid}-start`,
                        cleared: true,
                        notes: 'Starting balance',
                        imported_payee: 'Starting balance',
                    };

                    createTransactions.push(startTransaction);
                }

                if (createTransactions.length > 0) {
                    this.logger.debug(
                        `Considering ${createTransactions.length} new transactions for Actual account '${actualAccount.name}'...`
                    );

                    if (this.payeeTransformer && !isDryRun) {
                        const transactionPayees = createTransactions.map(
                            (t) => t.imported_payee as string
                        );
                        const uniquePayees = [
                            ...new Set(transactionPayees),
                        ].filter((p) => p && p.trim());

                        this.logger.debug(
                            `Cleaning up ${uniquePayees.length} unique payee names (from ${createTransactions.length} transactions) using OpenAI...`
                        );

                        const transformedPayees =
                            await this.payeeTransformer.transformPayees(
                                uniquePayees,
                                existingPayeeNames
                            );

                        if (transformedPayees !== null) {
                            createTransactions.forEach((t) => {
                                t.payee_name =
                                    transformedPayees[
                                        t.imported_payee as string
                                    ] ??
                                    t.imported_payee ??
                                    '';
                            });
                        } else {
                            const onError =
                                this.config.payeeTransformation
                                    .onTransformError;

                            if (onError === 'fail') {
                                throw new Error(
                                    'Payee transformation failed. Check the error messages above for details.'
                                );
                            }

                            this.logger.warn(
                                'Payee transformation failed. Using default payee names...'
                            );

                            createTransactions.forEach((t) => {
                                t.payee_name = t.imported_payee ?? '';
                            });
                        }
                    } else {
                        createTransactions.forEach((t) => {
                            t.payee_name = t.imported_payee ?? '';
                        });
                    }

                    if (!isDryRun) {
                        const result = await this.actualApi.importTransactions(
                            actualAccount.id,
                            createTransactions
                        );

                        if (result.errors && result.errors.length > 0) {
                            this.logger.error(
                                'Some errors occurred during import:'
                            );
                            for (let i = 0; i < result.errors.length; i++) {
                                this.logger.error(
                                    `Error ${i + 1}: ${result.errors[i]?.message ?? 'Unknown error'}`
                                );
                            }
                        }

                        this.logger.info(
                            `Transaction import to account '${actualAccount.name}' successful`,
                            [
                                `Added ${result.added.length} new transaction.`,
                                `Updated ${result.updated.length} existing transaction.`,
                            ]
                        );
                    } else {
                        this.logger.info(
                            `Dry run: would import ${createTransactions.length} new transactions to '${actualAccount.name}'.`
                        );
                    }
                }

                if (!shouldSyncCategories) {
                    continue;
                }

                const {
                    pendingUpdates,
                    backfillCount,
                    conflictCount,
                    skippedConflictCount,
                } = await this.planExistingCategoryUpdates({
                    existingPairs,
                    existingCategoryPolicy,
                    promptState,
                });

                this.logger.info(
                    `Category sync summary for account '${actualAccount.name}'`,
                    [
                        `Existing transactions considered: ${existingPairs.length}`,
                        `Backfills: ${backfillCount}`,
                        `Conflicts: ${conflictCount}`,
                        `Planned updates: ${pendingUpdates.length}`,
                        `Skipped conflicts: ${skippedConflictCount}`,
                    ]
                );

                if (pendingUpdates.length === 0) {
                    continue;
                }

                await this.applyOrPreviewCategoryUpdates({
                    actualAccountName: actualAccount.name,
                    pendingUpdates,
                    isDryRun,
                });
            }
        } finally {
            promptState.promptInterface?.close();
        }
    }

    private buildAccountTransactionBuckets({
        accountTransactions,
        existingActualTransactions,
        actualAccountName,
        shouldSyncCategories,
    }: {
        accountTransactions: MonMonTransaction[];
        existingActualTransactions: ReadTransaction[];
        actualAccountName: string;
        shouldSyncCategories: boolean;
    }) {
        const existingByImportedId = new Map<string, ReadTransaction>();
        const duplicateImportedIds = new Set<string>();

        // Deterministic winner policy for duplicate imported_id values: latest by (date, id) wins.
        const sortedExistingTransactions = [...existingActualTransactions]
            .filter((transaction) => !!transaction.imported_id)
            .sort((a, b) => {
                if (a.date === b.date) {
                    return a.id.localeCompare(b.id);
                }

                return a.date.localeCompare(b.date);
            });

        for (const transaction of sortedExistingTransactions) {
            if (!transaction.imported_id) {
                continue;
            }

            if (existingByImportedId.has(transaction.imported_id)) {
                duplicateImportedIds.add(transaction.imported_id);
            }

            existingByImportedId.set(transaction.imported_id, transaction);
        }

        if (duplicateImportedIds.size > 0) {
            const duplicateSample = Array.from(duplicateImportedIds)
                .slice(0, 5)
                .join(', ');
            this.logger.warn(
                `Detected ${duplicateImportedIds.size} duplicate imported_id values in Actual account '${actualAccountName}'. Category sync uses the latest transaction by (date,id) for each duplicate imported_id. Sample IDs: ${duplicateSample}`
            );
        }

        const newMonMonTransactions: MonMonTransaction[] = [];
        const existingPairs: ExistingTransactionPair[] = [];

        for (const transaction of accountTransactions) {
            const importedId = this.getIdForMoneyMoneyTransaction(transaction);
            const existingTransaction = existingByImportedId.get(importedId);

            if (existingTransaction) {
                if (shouldSyncCategories) {
                    existingPairs.push({
                        monMonTransaction: transaction,
                        actualTransaction: existingTransaction,
                    });
                }
                continue;
            }

            newMonMonTransactions.push(transaction);
        }

        return {
            newMonMonTransactions,
            existingPairs,
        };
    }

    private async planExistingCategoryUpdates({
        existingPairs,
        existingCategoryPolicy,
        promptState,
    }: {
        existingPairs: ExistingTransactionPair[];
        existingCategoryPolicy: ExistingCategorySyncPolicy;
        promptState: PromptState;
    }): Promise<CategoryUpdatePlan> {
        const pendingUpdates: ExistingCategoryUpdate[] = [];
        let backfillCount = 0;
        let conflictCount = 0;
        let skippedConflictCount = 0;

        for (const pair of existingPairs) {
            const categoryResolution =
                this.categoryMap.getMappedActualCategoryId(
                    pair.monMonTransaction.categoryUuid
                );

            const classification = classifyCategoryUpdate({
                currentCategoryId: pair.actualTransaction.category || undefined,
                targetCategoryId: categoryResolution.actualCategoryId,
                isUncategorized: categoryResolution.isUncategorized,
            });

            if (classification.type === 'noop') {
                continue;
            }

            if (classification.type === 'backfill') {
                pendingUpdates.push(
                    buildExistingCategoryUpdate({
                        pair,
                        targetCategoryId: classification.targetCategoryId,
                        reason: 'backfill',
                    })
                );
                backfillCount++;
                continue;
            }

            conflictCount++;

            if (existingCategoryPolicy === 'new') {
                skippedConflictCount++;
                continue;
            }

            if (existingCategoryPolicy === 'always') {
                pendingUpdates.push(
                    buildExistingCategoryUpdate({
                        pair,
                        targetCategoryId: classification.targetCategoryId,
                        reason: 'conflict',
                        fromCategoryId: classification.currentCategoryId,
                    })
                );
                continue;
            }

            if (promptState.mode === 'none') {
                skippedConflictCount++;
                continue;
            }

            if (promptState.mode === 'all') {
                pendingUpdates.push(
                    buildExistingCategoryUpdate({
                        pair,
                        targetCategoryId: classification.targetCategoryId,
                        reason: 'conflict',
                        fromCategoryId: classification.currentCategoryId,
                    })
                );
                continue;
            }

            if (!promptState.promptInterface) {
                this.logger.info(
                    `Interactive category decisions apply for the rest of this import run across all accounts (use A/N to set a global choice, q to abort).`
                );
                promptState.promptInterface = createInterface({
                    input: stdin,
                    output: stdout,
                });
            }

            const shouldApply = await this.promptForConflictDecision(
                promptState.promptInterface,
                pair,
                classification.currentCategoryId,
                classification.targetCategoryId
            );

            if (shouldApply === 'all') {
                promptState.mode = 'all';
                pendingUpdates.push(
                    buildExistingCategoryUpdate({
                        pair,
                        targetCategoryId: classification.targetCategoryId,
                        reason: 'conflict',
                        fromCategoryId: classification.currentCategoryId,
                    })
                );
                continue;
            }

            if (shouldApply === 'none') {
                promptState.mode = 'none';
                skippedConflictCount++;
                continue;
            }

            if (shouldApply === 'quit') {
                throw new Error('Category sync aborted by user.');
            }

            if (shouldApply === true) {
                pendingUpdates.push(
                    buildExistingCategoryUpdate({
                        pair,
                        targetCategoryId: classification.targetCategoryId,
                        reason: 'conflict',
                        fromCategoryId: classification.currentCategoryId,
                    })
                );
                continue;
            }

            skippedConflictCount++;
        }

        return {
            pendingUpdates,
            backfillCount,
            conflictCount,
            skippedConflictCount,
        };
    }

    private async applyOrPreviewCategoryUpdates({
        actualAccountName,
        pendingUpdates,
        isDryRun,
    }: {
        actualAccountName: string;
        pendingUpdates: ExistingCategoryUpdate[];
        isDryRun: boolean;
    }) {
        if (isDryRun) {
            const preview = pendingUpdates.slice(0, 5).map((update) => {
                const fromPath = update.fromCategoryId
                    ? this.categoryMap.getActualCategoryPath(
                          update.fromCategoryId
                      )
                    : '(none)';
                const toPath = this.categoryMap.getActualCategoryPath(
                    update.toCategoryId
                );
                return `${update.importedId}: ${fromPath} -> ${toPath}`;
            });

            this.logger.info(
                `Dry run: would apply ${pendingUpdates.length} category updates in '${actualAccountName}'.`,
                preview
            );
            return;
        }

        for (const update of pendingUpdates) {
            await this.actualApi.updateTransaction(update.transactionId, {
                category: update.toCategoryId,
            });
        }

        this.logger.info(
            `Applied ${pendingUpdates.length} category updates for existing transactions in '${actualAccountName}'.`
        );
    }

    private async promptForConflictDecision(
        promptInterface: ReturnType<typeof createInterface>,
        pair: ExistingTransactionPair,
        currentCategoryId: string,
        targetCategoryId: string
    ): Promise<PromptDecision> {
        const fromCategory =
            this.categoryMap.getActualCategoryPath(currentCategoryId);
        const toCategory =
            this.categoryMap.getActualCategoryPath(targetCategoryId);
        const question = [
            `Category conflict for transaction '${pair.monMonTransaction.name}' (${format(pair.monMonTransaction.valueDate, DATE_FORMAT)}, ${pair.monMonTransaction.amount}):`,
            `Current Actual category: ${fromCategory}`,
            `Mapped MoneyMoney category: ${toCategory}`,
            `Apply update? [y]es/[n]o/[A]ll remaining/[N]one remaining/[q]uit: `,
        ].join('\n');

        while (true) {
            const answer = (await promptInterface.question(question)).trim();
            const decision = parsePromptDecision(answer);
            if (decision !== 'invalid') {
                return decision;
            }

            this.logger.warn(`Invalid input '${answer}'. Use y/n/A/N/q.`);
        }
    }

    private async convertToActualTransaction(
        transaction: MonMonTransaction
    ): Promise<CreateTransaction> {
        const transactionNotes = [
            transaction.purpose,
            transaction.comment && this.config.import.importComments
                ? `${this.config.import.commentPrefix}${transaction.comment}`
                : undefined,
        ]
            .filter(Boolean)
            .join(' | ');

        const createTransaction: CreateTransaction = {
            date: format(transaction.valueDate, 'yyyy-MM-dd'),
            amount: Math.round(transaction.amount * 100),
            imported_id: this.getIdForMoneyMoneyTransaction(transaction),
            imported_payee: transaction.name ?? '',
        };

        if (this.config.import.synchronizeClearedStatus) {
            createTransaction.cleared = transaction.booked;
        }

        if (transactionNotes) {
            createTransaction.notes = transactionNotes;
        }

        return createTransaction;
    }

    private getIdForMoneyMoneyTransaction(transaction: MonMonTransaction) {
        return `${transaction.accountUuid}-${transaction.id}`;
    }

    private getStartingBalanceForAccount(
        account: MonMonAccount,
        transactions: MonMonTransaction[]
    ) {
        const monMonAccountBalance = account.balance[0]?.[0] ?? 0;
        const totalExpenses = transactions.reduce(
            (acc, transaction) =>
                acc + (transaction.booked ? transaction.amount : 0),
            0
        );

        const startingBalance = Math.round(
            (monMonAccountBalance - totalExpenses) * 100
        );

        return startingBalance;
    }
}

export default Importer;
