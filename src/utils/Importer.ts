import { differenceInCalendarDays, format, subMonths } from 'date-fns';
import chalk from 'chalk';
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
    transferLockedCount: number;
};
type ImportRunMetrics = {
    accountsScanned: number;
    accountsWithImportActivity: number;
    accountsWithCategoryActivity: number;
    accountsWithConflicts: number;
    totalTransactionsAdded: number;
    totalTransactionsUpdated: number;
    totalCategoryUpdatesPlanned: number;
    totalCategoryUpdatesApplied: number;
    totalCategoryUpdatesDryRun: number;
    totalBackfills: number;
    totalConflicts: number;
    totalSkippedConflicts: number;
    totalUnmappedCategoryWarnings: number;
    totalAutoRuleOverrides: number;
};
type DuplicateImportedIdGroup = {
    importedId: string;
    transactions: ReadTransaction[];
    representativeTransaction: ReadTransaction;
    normalizedPayee: string;
    isLikelySplit: boolean;
};
type TransferPlan = {
    seedByImportedId: Map<string, PlannedTransferSeed>;
    suppressedImportedIds: Set<string>;
    existingCounterpartConversionsByImportedId: Map<
        string,
        PlannedExistingCounterpartConversion
    >;
};
type PlannedTransferSeed = {
    importedId: string;
    transferPayeeId: string;
    targetActualAccountId: string;
    targetActualAccountName: string;
    sameRunCounterpart?: PlannedTransferCounterpart;
};
type PlannedTransferCounterpart = {
    importedId: string;
    importedPayee: string;
    date: string;
    notes?: string;
    cleared?: boolean;
};
type PlannedExistingCounterpartConversion = {
    existingCounterpartTransactionId: string;
    existingCounterpartAccountId: string;
    existingCounterpartAccountName: string;
    sourceTransferPayeeId: string;
    sourceImportedId: string;
    sourceImportedPayee: string;
    sourceNotes?: string;
    sourceCleared?: boolean;
};
type TransferPlanningCandidate = {
    transaction: MonMonTransaction;
    importedId: string;
    sourceMonMonAccount: MonMonAccount;
    sourceActualAccount: Account;
    targetMonMonAccount: MonMonAccount;
    targetActualAccount: Account;
    transferPayeeId: string;
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

export const buildConflictPromptText = ({
    transactionName,
    valueDate,
    amount,
    currentCategory,
    targetCategory,
}: {
    transactionName: string;
    valueDate: Date;
    amount: number;
    currentCategory: string;
    targetCategory: string;
}): string => {
    const amountText = amount > 0 ? `+${amount.toFixed(2)}` : amount.toFixed(2);

    return [
        chalk.yellow.bold('Category conflict'),
        `${chalk.gray('Transaction:')} ${chalk.white(transactionName)}`,
        `${chalk.gray('Date:')}        ${format(valueDate, DATE_FORMAT)}`,
        `${chalk.gray('Amount:')}      ${amountText}`,
        '',
        `${chalk.gray('Keep current:')} ${chalk.red(currentCategory)}`,
        `${chalk.gray('Change to:')}    ${chalk.green(targetCategory)}`,
        '',
        `${chalk.gray('Choose:')} ${chalk.green('[y] update')}  ${chalk.red('[n] keep')}  ${chalk.green('[A] update all')}  ${chalk.red('[N] keep all')}  ${chalk.yellow('[q] quit')}`,
        chalk.bold('Your choice: '),
    ].join('\n');
};

export const shouldEmitMappingConflictGuidance = ({
    totalUnmappedCategoryWarnings,
    accountsWithConflicts,
}: {
    totalUnmappedCategoryWarnings: number;
    accountsWithConflicts: number;
}): boolean => totalUnmappedCategoryWarnings > 0 && accountsWithConflicts > 0;

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

        const transfersEnabled = this.config.import.transfers.enabled;
        const fullAccountMapping = transfersEnabled
            ? this.accountMap.getMap()
            : undefined;
        const accountMapping = accountRefs
            ? this.accountMap.getMap(accountRefs)
            : (fullAccountMapping ?? this.accountMap.getMap());
        const existingActualTransactionsByAccountId = new Map<
            string,
            ReadTransaction[]
        >();

        for (const [, actualAccount] of fullAccountMapping ?? accountMapping) {
            existingActualTransactionsByAccountId.set(
                actualAccount.id,
                await this.actualApi.getTransactions(actualAccount.id)
            );
        }

        let existingPayeeNames: string[] = [];
        const shouldLoadPayeesForTransfers = transfersEnabled;
        const existingPayees =
            (this.payeeTransformer && !isDryRun) || shouldLoadPayeesForTransfers
                ? await this.actualApi.getPayees()
                : [];
        if (this.payeeTransformer && !isDryRun) {
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

        const transferPayeeIdByAccountId = new Map(
            existingPayees
                .filter((payee) => payee.transfer_acct)
                .map((payee) => [payee.transfer_acct as string, payee.id])
        );
        const shouldSyncCategories = this.config.import.synchronizeCategories;

        const accountStates = Array.from(accountMapping.entries()).map(
            ([monMonAccount, actualAccount]) => {
                const accountTransactions =
                    monMonTransactionMap[monMonAccount.uuid] ?? [];
                const existingActualTransactions =
                    existingActualTransactionsByAccountId.get(
                        actualAccount.id
                    ) ?? [];
                const { newMonMonTransactions, existingPairs } =
                    this.buildAccountTransactionBuckets({
                        monMonAccount,
                        accountTransactions,
                        existingActualTransactions,
                        actualAccountName: actualAccount.name,
                        shouldSyncCategories,
                    });

                return {
                    monMonAccount,
                    actualAccount,
                    accountTransactions,
                    existingActualTransactions,
                    newMonMonTransactions,
                    existingPairs,
                };
            }
        );

        const transferPlan = transfersEnabled
            ? this.buildTransferPlan({
                  fullAccountMapping: fullAccountMapping!,
                  accountStates,
                  monMonTransactionMap,
                  existingActualTransactionsByAccountId,
                  transferPayeeIdByAccountId,
              })
            : {
                  seedByImportedId: new Map<string, PlannedTransferSeed>(),
                  suppressedImportedIds: new Set<string>(),
                  existingCounterpartConversionsByImportedId: new Map(),
              };

        const unmappedCategoryWarnings = new Set<string>();
        const runMetrics: ImportRunMetrics = {
            accountsScanned: 0,
            accountsWithImportActivity: 0,
            accountsWithCategoryActivity: 0,
            accountsWithConflicts: 0,
            totalTransactionsAdded: 0,
            totalTransactionsUpdated: 0,
            totalCategoryUpdatesPlanned: 0,
            totalCategoryUpdatesApplied: 0,
            totalCategoryUpdatesDryRun: 0,
            totalBackfills: 0,
            totalConflicts: 0,
            totalSkippedConflicts: 0,
            totalUnmappedCategoryWarnings: 0,
            totalAutoRuleOverrides: 0,
        };

        const promptState: PromptState = { mode: 'prompt' };

        try {
            for (const {
                monMonAccount,
                actualAccount,
                accountTransactions,
                existingActualTransactions,
                newMonMonTransactions,
                existingPairs,
            } of accountStates) {
                runMetrics.accountsScanned++;

                const createTransactions: CreateTransaction[] = [];
                // Maps imported_id → intended category ID (for auto-rule override detection).
                const intendedCategoryByImportedId = new Map<string, string>();
                for (const transaction of newMonMonTransactions) {
                    const importedId =
                        this.getIdForMoneyMoneyTransaction(transaction);
                    if (transferPlan.suppressedImportedIds.has(importedId)) {
                        continue;
                    }

                    const plannedTransfer =
                        transferPlan.seedByImportedId.get(importedId);
                    const createTransaction =
                        await this.convertToActualTransaction(
                            transaction,
                            plannedTransfer
                        );

                    if (shouldSyncCategories && !plannedTransfer) {
                        const categoryResolution =
                            this.categoryMap.getMappedActualCategoryId(
                                transaction.categoryUuid
                            );

                        if (categoryResolution.actualCategoryId) {
                            createTransaction.category =
                                categoryResolution.actualCategoryId;
                            if (createTransaction.imported_id) {
                                intendedCategoryByImportedId.set(
                                    createTransaction.imported_id,
                                    categoryResolution.actualCategoryId
                                );
                            }
                        } else if (
                            !categoryResolution.isUncategorized &&
                            !categoryResolution.isMapped
                        ) {
                            const warningKey =
                                categoryResolution.categoryPath ??
                                transaction.categoryUuid;

                            if (!unmappedCategoryWarnings.has(warningKey)) {
                                unmappedCategoryWarnings.add(warningKey);
                                runMetrics.totalUnmappedCategoryWarnings++;
                                this.logger.warn(
                                    `No category mapping found for MoneyMoney category '${warningKey}'. Transaction categories will be left untouched.`
                                );
                            }
                        }
                    }

                    createTransactions.push(createTransaction);
                }

                const effectiveExistingActualTransactions =
                    await this.getExistingTransactionsForStartBalanceCheck({
                        actualAccountId: actualAccount.id,
                        existingActualTransactions,
                        transfersEnabled,
                        isDryRun,
                    });

                if (effectiveExistingActualTransactions.length === 0) {
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

                if (!isDryRun) {
                    await this.applyExistingCounterpartConversions({
                        newMonMonTransactions,
                        transferPlan,
                    });
                }

                if (createTransactions.length > 0) {
                    this.logger.debug(
                        `Considering ${createTransactions.length} new transactions for Actual account '${actualAccount.name}'...`
                    );

                    if (this.payeeTransformer && !isDryRun) {
                        const transactionPayees = createTransactions
                            .filter((t) => !t.payee)
                            .map((t) => t.imported_payee as string);
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
                                if (t.payee) {
                                    return;
                                }
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
                                if (t.payee) {
                                    return;
                                }
                                t.payee_name = t.imported_payee ?? '';
                            });
                        }
                    } else {
                        createTransactions.forEach((t) => {
                            if (t.payee) {
                                return;
                            }
                            t.payee_name = t.imported_payee ?? '';
                        });
                    }

                    if (!isDryRun) {
                        const result = await this.actualApi.importTransactions(
                            actualAccount.id,
                            createTransactions
                        );
                        runMetrics.totalTransactionsAdded +=
                            result.added.length;
                        runMetrics.totalTransactionsUpdated +=
                            result.updated.length;
                        if (
                            result.added.length > 0 ||
                            result.updated.length > 0
                        ) {
                            runMetrics.accountsWithImportActivity++;
                        }

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

                        const importedTransactions =
                            result.added.length > 0 || result.updated.length > 0
                                ? await this.actualApi.getTransactionsByIds(
                                      actualAccount.id,
                                      [...result.added, ...result.updated]
                                  )
                                : [];

                        await this.applyTransferCounterpartUpdates({
                            importedTransactions,
                            transferPlan,
                        });

                        if (
                            intendedCategoryByImportedId.size > 0 &&
                            result.added.length > 0
                        ) {
                            const overrideCount =
                                await this.detectAndWarnAutoRuleOverrides({
                                    actualAccountName: actualAccount.name,
                                    addedIds: result.added,
                                    importedTransactions,
                                    intendedCategoryByImportedId,
                                });
                            runMetrics.totalAutoRuleOverrides += overrideCount;
                        }
                    } else {
                        runMetrics.totalTransactionsAdded +=
                            createTransactions.length;
                        runMetrics.accountsWithImportActivity++;
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
                    transferLockedCount,
                } = await this.planExistingCategoryUpdates({
                    existingPairs,
                    existingCategoryPolicy,
                    promptState,
                });

                if (transferLockedCount > 0) {
                    this.logger.debug(
                        `Skipped ${transferLockedCount} transfer-linked existing transaction(s) for category sync in '${actualAccount.name}' (Actual manages transfer categories).`
                    );
                }

                runMetrics.totalBackfills += backfillCount;
                runMetrics.totalConflicts += conflictCount;
                runMetrics.totalSkippedConflicts += skippedConflictCount;
                runMetrics.totalCategoryUpdatesPlanned += pendingUpdates.length;
                if (backfillCount > 0 || conflictCount > 0) {
                    runMetrics.accountsWithCategoryActivity++;
                }
                if (conflictCount > 0) {
                    runMetrics.accountsWithConflicts++;
                }

                this.logCategorySyncSummary({
                    actualAccountName: actualAccount.name,
                    existingPairsCount: existingPairs.length,
                    backfillCount,
                    conflictCount,
                    pendingUpdatesCount: pendingUpdates.length,
                    skippedConflictCount,
                });

                if (pendingUpdates.length === 0) {
                    continue;
                }

                await this.applyOrPreviewCategoryUpdates({
                    actualAccountName: actualAccount.name,
                    pendingUpdates,
                    isDryRun,
                });
                if (isDryRun) {
                    runMetrics.totalCategoryUpdatesDryRun +=
                        pendingUpdates.length;
                } else {
                    runMetrics.totalCategoryUpdatesApplied +=
                        pendingUpdates.length;
                }
            }

            if (shouldEmitMappingConflictGuidance(runMetrics)) {
                this.logger.warn(
                    `Category conflicts occurred while some categories are unmapped. Review with 'actual-mmi categories map' if needed.`
                );
            }
            this.emitImportRunSummary(runMetrics, isDryRun);
        } finally {
            promptState.promptInterface?.close();
        }
    }

    private logCategorySyncSummary({
        actualAccountName,
        existingPairsCount,
        backfillCount,
        conflictCount,
        pendingUpdatesCount,
        skippedConflictCount,
    }: {
        actualAccountName: string;
        existingPairsCount: number;
        backfillCount: number;
        conflictCount: number;
        pendingUpdatesCount: number;
        skippedConflictCount: number;
    }) {
        const hasCategoryActivity = backfillCount > 0 || conflictCount > 0;
        if (hasCategoryActivity) {
            const hints = [
                `Existing transactions considered: ${existingPairsCount}`,
            ];

            if (backfillCount > 0) {
                hints.push(`Backfills: ${backfillCount}`);
            }

            if (conflictCount > 0) {
                hints.push(`Conflicts: ${conflictCount}`);
            }

            if (pendingUpdatesCount > 0) {
                hints.push(`Planned updates: ${pendingUpdatesCount}`);
            }

            if (skippedConflictCount > 0) {
                hints.push(`Skipped conflicts: ${skippedConflictCount}`);
            }

            this.logger.info(
                `Category sync summary for account '${actualAccountName}'`,
                hints
            );
            return;
        }

        this.logger.debug(
            `Category sync no-op for account '${actualAccountName}': existing=${existingPairsCount}, backfills=${backfillCount}, conflicts=${conflictCount}, planned=${pendingUpdatesCount}, skipped=${skippedConflictCount}`
        );
    }

    async detectAndWarnAutoRuleOverrides({
        actualAccountName,
        addedIds,
        importedTransactions,
        intendedCategoryByImportedId,
    }: {
        actualAccountName: string;
        addedIds: string[];
        importedTransactions: ReadTransaction[];
        intendedCategoryByImportedId: Map<string, string>;
    }): Promise<number> {
        const addedIdSet = new Set(addedIds);
        const freshTransactions = importedTransactions.filter((transaction) =>
            addedIdSet.has(transaction.id)
        );

        let overrideCount = 0;
        for (const tx of freshTransactions) {
            if (!tx.imported_id) {
                continue;
            }
            const intendedCategoryId = intendedCategoryByImportedId.get(
                tx.imported_id
            );
            if (!intendedCategoryId) {
                continue;
            }
            if (tx.category !== intendedCategoryId) {
                overrideCount++;
                const intendedPath =
                    this.categoryMap.getActualCategoryPath(intendedCategoryId);
                const actualPath = tx.category
                    ? this.categoryMap.getActualCategoryPath(tx.category)
                    : '(none)';
                this.logger.warn(
                    `Auto-rule changed category for transaction '${tx.imported_payee ?? tx.imported_id}' in account '${actualAccountName}': intended '${intendedPath}' → actual '${actualPath}'`
                );
            }
        }

        return overrideCount;
    }

    private emitImportRunSummary(metrics: ImportRunMetrics, isDryRun: boolean) {
        const hasImportActivity =
            metrics.totalTransactionsAdded > 0 ||
            metrics.totalTransactionsUpdated > 0;
        const hasCategoryActivity = metrics.totalCategoryUpdatesPlanned > 0;
        const hasNotableWarnings = metrics.totalUnmappedCategoryWarnings > 0;

        if (!hasImportActivity && !hasCategoryActivity && !hasNotableWarnings) {
            this.logger.info('Nothing to import.');
            return;
        }

        const hints = [`Accounts scanned: ${metrics.accountsScanned}`];

        if (hasImportActivity) {
            hints.push(
                `Transactions: added=${metrics.totalTransactionsAdded}, updated=${metrics.totalTransactionsUpdated}`
            );
        }

        if (hasCategoryActivity) {
            if (isDryRun) {
                hints.push(
                    `Category updates: planned=${metrics.totalCategoryUpdatesPlanned} (dry-run, no changes written)`
                );
            } else {
                hints.push(
                    `Category updates: planned=${metrics.totalCategoryUpdatesPlanned}, applied=${metrics.totalCategoryUpdatesApplied}`
                );
            }
        }

        if (
            metrics.totalBackfills > 0 ||
            metrics.totalConflicts > 0 ||
            metrics.totalSkippedConflicts > 0
        ) {
            const categorySyncParts: string[] = [];
            if (metrics.totalBackfills > 0) {
                categorySyncParts.push(`backfills=${metrics.totalBackfills}`);
            }
            if (metrics.totalConflicts > 0) {
                categorySyncParts.push(`conflicts=${metrics.totalConflicts}`);
            }
            if (metrics.totalSkippedConflicts > 0) {
                categorySyncParts.push(
                    `skipped=${metrics.totalSkippedConflicts}`
                );
            }
            hints.push(
                `Category sync activity: ${categorySyncParts.join(', ')}`
            );
        }

        if (metrics.accountsWithConflicts > 0) {
            hints.push(
                `Accounts with conflicts: ${metrics.accountsWithConflicts}`
            );
        }

        if (metrics.totalUnmappedCategoryWarnings > 0) {
            hints.push(
                `Unmapped category warnings: ${metrics.totalUnmappedCategoryWarnings}`
            );
        }

        if (metrics.totalAutoRuleOverrides > 0) {
            hints.push(
                `Auto-rule category overrides detected: ${metrics.totalAutoRuleOverrides}`
            );
        }

        this.logger.info('Import run summary', hints);
    }

    private buildAccountTransactionBuckets({
        monMonAccount,
        accountTransactions,
        existingActualTransactions,
        actualAccountName,
        shouldSyncCategories,
    }: {
        monMonAccount: MonMonAccount;
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
            const duplicateGroups = this.buildDuplicateImportedIdGroups(
                sortedExistingTransactions,
                duplicateImportedIds
            );
            const likelySplitGroups = duplicateGroups.filter(
                (group) => group.isLikelySplit
            );
            const suspiciousGroups = duplicateGroups.filter(
                (group) => !group.isLikelySplit
            );
            const sampledGroups = [
                ...suspiciousGroups,
                ...likelySplitGroups,
            ].slice(0, 5);

            const duplicateDetails = sampledGroups.map((group) => {
                const { monMonAccountUuid, monMonTransactionId } =
                    this.parseImportedId(group.importedId);
                const amount = this.formatMinorUnitsAsMajor(
                    group.representativeTransaction.amount
                );
                const monMonAccountDisplay =
                    monMonAccountUuid === monMonAccount.uuid
                        ? `${monMonAccount.name} (${monMonAccountUuid})`
                        : monMonAccountUuid;

                return `Date=${group.representativeTransaction.date}, Payee=${group.normalizedPayee}, Amount=${amount}, TxCount=${group.transactions.length} (imported_id='${group.importedId}', MoneyMoneyAccount='${monMonAccountDisplay}', MoneyMoneyTx='${monMonTransactionId}')`;
            });

            if (duplicateGroups.length > sampledGroups.length) {
                duplicateDetails.push(
                    `...and ${duplicateGroups.length - sampledGroups.length} more duplicate imported_id group(s).`
                );
            }

            if (likelySplitGroups.length > 0) {
                this.logger.debug(
                    `Detected ${likelySplitGroups.length} likely split duplicate imported_id group(s) in Actual account '${actualAccountName}'.`
                );
            }

            if (suspiciousGroups.length > 0) {
                this.logger.warn(
                    `Detected ${duplicateGroups.length} duplicate imported_id group(s) in Actual account '${actualAccountName}'; ${suspiciousGroups.length} group(s) need review.`,
                    sampledGroups
                        .filter((group) => !group.isLikelySplit)
                        .slice(0, 5)
                        .map((group) => {
                            const { monMonAccountUuid, monMonTransactionId } =
                                this.parseImportedId(group.importedId);
                            const amount = this.formatMinorUnitsAsMajor(
                                group.representativeTransaction.amount
                            );
                            const monMonAccountDisplay =
                                monMonAccountUuid === monMonAccount.uuid
                                    ? `${monMonAccount.name} (${monMonAccountUuid})`
                                    : monMonAccountUuid;

                            return `Date=${group.representativeTransaction.date}, Payee=${group.normalizedPayee}, Amount=${amount}, TxCount=${group.transactions.length} (imported_id='${group.importedId}', MoneyMoneyAccount='${monMonAccountDisplay}', MoneyMoneyTx='${monMonTransactionId}')`;
                        })
                );
            }

            this.logger.debug(
                `Duplicate imported_id diagnostics for account '${actualAccountName}' (total=${duplicateGroups.length}, suspicious=${suspiciousGroups.length}).`,
                duplicateDetails
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
        let transferLockedCount = 0;

        for (const pair of existingPairs) {
            if (pair.actualTransaction.transfer_id) {
                transferLockedCount++;
                continue;
            }

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
                    `Interactive category decisions stay active for the rest of this import across all accounts.`,
                    `Use A/N to apply a choice to all remaining conflicts, or q to abort.`
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
            transferLockedCount,
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

    private buildTransferPlan({
        fullAccountMapping,
        accountStates,
        monMonTransactionMap,
        existingActualTransactionsByAccountId,
        transferPayeeIdByAccountId,
    }: {
        fullAccountMapping: Map<MonMonAccount, Account>;
        accountStates: Array<{
            monMonAccount: MonMonAccount;
            actualAccount: Account;
            newMonMonTransactions: MonMonTransaction[];
        }>;
        monMonTransactionMap: Record<string, MonMonTransaction[]>;
        existingActualTransactionsByAccountId: Map<string, ReadTransaction[]>;
        transferPayeeIdByAccountId: Map<string, string>;
    }): TransferPlan {
        const emptyPlan: TransferPlan = {
            seedByImportedId: new Map<string, PlannedTransferSeed>(),
            suppressedImportedIds: new Set<string>(),
            existingCounterpartConversionsByImportedId: new Map(),
        };

        const transferConfig = this.config.import.transfers;
        if (
            !transferConfig.enabled ||
            transferConfig.categoryRefs.length === 0
        ) {
            return emptyPlan;
        }

        const { resolvedUuids, invalidRefs } =
            this.categoryMap.resolveMoneyMoneyCategoryRefs(
                transferConfig.categoryRefs
            );

        if (invalidRefs.length > 0) {
            throw new Error(
                `Invalid transfer category refs: ${invalidRefs
                    .map(({ ref, reason }) => `${ref} (${reason})`)
                    .join('; ')}`
            );
        }

        if (resolvedUuids.size === 0) {
            return emptyPlan;
        }

        const mappedAccounts = Array.from(fullAccountMapping.entries()).map(
            ([monMonAccount, actualAccount]) => ({
                monMonAccount,
                actualAccount,
            })
        );
        const newTransactionsByAccountUuid = Object.fromEntries(
            accountStates.map(({ monMonAccount, newMonMonTransactions }) => [
                monMonAccount.uuid,
                newMonMonTransactions,
            ])
        ) as Record<string, MonMonTransaction[]>;
        const mappedByAccountNumber = new Map<
            string,
            Array<{
                monMonAccount: MonMonAccount;
                actualAccount: Account;
            }>
        >();
        for (const entry of mappedAccounts) {
            const accountNumber = entry.monMonAccount.accountNumber;
            if (!accountNumber) {
                continue;
            }

            const entries = mappedByAccountNumber.get(accountNumber) ?? [];
            entries.push(entry);
            mappedByAccountNumber.set(accountNumber, entries);
        }
        const ambiguousMappedAccountNumbers = new Set(
            Array.from(mappedByAccountNumber.entries())
                .filter(([, entries]) => entries.length > 1)
                .map(([accountNumber]) => accountNumber)
        );
        for (const accountNumber of ambiguousMappedAccountNumbers) {
            this.logger.warn(
                `Automatic transfer detection is disabled for mapped account number '${accountNumber}' because it resolves to multiple MoneyMoney accounts.`
            );
        }

        const candidates: TransferPlanningCandidate[] = [];

        for (const { monMonAccount, actualAccount } of mappedAccounts) {
            const accountTransactions =
                newTransactionsByAccountUuid[monMonAccount.uuid] ?? [];

            for (const transaction of accountTransactions) {
                if (!resolvedUuids.has(transaction.categoryUuid)) {
                    continue;
                }

                if (!transaction.accountNumber) {
                    continue;
                }

                if (
                    ambiguousMappedAccountNumbers.has(transaction.accountNumber)
                ) {
                    continue;
                }

                const target = mappedByAccountNumber.get(
                    transaction.accountNumber
                )?.[0];

                if (
                    !target ||
                    target.monMonAccount.uuid === monMonAccount.uuid
                ) {
                    continue;
                }

                const transferPayeeId = transferPayeeIdByAccountId.get(
                    target.actualAccount.id
                );
                if (!transferPayeeId) {
                    continue;
                }

                candidates.push({
                    transaction,
                    importedId: this.getIdForMoneyMoneyTransaction(transaction),
                    sourceMonMonAccount: monMonAccount,
                    sourceActualAccount: actualAccount,
                    targetMonMonAccount: target.monMonAccount,
                    targetActualAccount: target.actualAccount,
                    transferPayeeId,
                });
            }
        }

        candidates.sort((a, b) => a.importedId.localeCompare(b.importedId));

        const seedByImportedId = new Map<string, PlannedTransferSeed>();
        const suppressedImportedIds = new Set<string>();
        const claimedCounterpartIds = new Set<string>();
        const existingCounterpartConversionsByImportedId = new Map<
            string,
            PlannedExistingCounterpartConversion
        >();

        for (const candidate of candidates) {
            if (suppressedImportedIds.has(candidate.importedId)) {
                continue;
            }

            const matchingCounterparts = this.findMatchingTransferCounterparts({
                candidate,
                monMonTransactionMap: newTransactionsByAccountUuid,
                matchWindowDays: transferConfig.matchWindowDays,
            });

            if (matchingCounterparts.length > 1) {
                this.logger.debug(
                    `Skipping automatic transfer for '${candidate.importedId}' because multiple same-run counterpart candidates were found.`
                );
                continue;
            }

            const sameRunCounterpart = matchingCounterparts[0];
            if (sameRunCounterpart) {
                const counterpartImportedId =
                    this.getIdForMoneyMoneyTransaction(sameRunCounterpart);
                if (claimedCounterpartIds.has(counterpartImportedId)) {
                    this.logger.debug(
                        `Skipping automatic transfer for '${candidate.importedId}' because counterpart '${counterpartImportedId}' was already claimed by another transfer seed.`
                    );
                    continue;
                }

                const existingTargetTransactions =
                    existingActualTransactionsByAccountId.get(
                        candidate.targetActualAccount.id
                    ) ?? [];
                if (
                    existingTargetTransactions.some(
                        (transaction) =>
                            transaction.imported_id === counterpartImportedId
                    )
                ) {
                    this.logger.debug(
                        `Skipping automatic transfer for '${candidate.importedId}' because counterpart '${counterpartImportedId}' already exists in Actual.`
                    );
                    continue;
                }

                suppressedImportedIds.add(counterpartImportedId);
                claimedCounterpartIds.add(counterpartImportedId);

                seedByImportedId.set(candidate.importedId, {
                    importedId: candidate.importedId,
                    transferPayeeId: candidate.transferPayeeId,
                    targetActualAccountId: candidate.targetActualAccount.id,
                    targetActualAccountName: candidate.targetActualAccount.name,
                    sameRunCounterpart: {
                        importedId: counterpartImportedId,
                        importedPayee: sameRunCounterpart.name ?? '',
                        date: format(sameRunCounterpart.valueDate, DATE_FORMAT),
                        notes:
                            this.buildTransactionNotes(sameRunCounterpart) ||
                            '',
                        ...(this.config.import.synchronizeClearedStatus
                            ? { cleared: sameRunCounterpart.booked }
                            : {}),
                    },
                });
                continue;
            }

            const existingCounterparts = this.findMatchingTransferCounterparts({
                candidate,
                monMonTransactionMap,
                matchWindowDays: transferConfig.matchWindowDays,
            });
            if (existingCounterparts.length > 1) {
                this.logger.debug(
                    `Skipping automatic transfer for '${candidate.importedId}' because multiple historical counterpart candidates were found.`
                );
                continue;
            }

            const existingCounterpart = existingCounterparts[0];
            if (existingCounterpart) {
                const existingCounterpartImportedId =
                    this.getIdForMoneyMoneyTransaction(existingCounterpart);
                const existingTargetTransactions =
                    existingActualTransactionsByAccountId.get(
                        candidate.targetActualAccount.id
                    ) ?? [];
                const existingTargetTransaction =
                    existingTargetTransactions.find(
                        (transaction) =>
                            transaction.imported_id ===
                            existingCounterpartImportedId
                    );

                if (existingTargetTransaction?.transfer_id) {
                    this.logger.debug(
                        `Skipping automatic transfer for '${candidate.importedId}' because counterpart '${existingCounterpartImportedId}' is already a transfer.`
                    );
                    continue;
                }

                if (existingTargetTransaction) {
                    const sourceTransferPayeeId =
                        transferPayeeIdByAccountId.get(
                            candidate.sourceActualAccount.id
                        );
                    if (!sourceTransferPayeeId) {
                        continue;
                    }

                    suppressedImportedIds.add(candidate.importedId);

                    existingCounterpartConversionsByImportedId.set(
                        candidate.importedId,
                        {
                            existingCounterpartTransactionId:
                                existingTargetTransaction.id,
                            existingCounterpartAccountId:
                                candidate.targetActualAccount.id,
                            existingCounterpartAccountName:
                                candidate.targetActualAccount.name,
                            sourceTransferPayeeId,
                            sourceImportedId: candidate.importedId,
                            sourceImportedPayee:
                                candidate.transaction.name ?? '',
                            ...(this.buildTransactionNotes(
                                candidate.transaction
                            )
                                ? {
                                      sourceNotes: this.buildTransactionNotes(
                                          candidate.transaction
                                      ),
                                  }
                                : {}),
                            ...(this.config.import.synchronizeClearedStatus
                                ? {
                                      sourceCleared:
                                          candidate.transaction.booked,
                                  }
                                : {}),
                        }
                    );

                    this.logger.debug(
                        `Planning conversion of existing plain transaction '${existingTargetTransaction.id}' in '${candidate.targetActualAccount.name}' to a transfer for source '${candidate.importedId}'.`
                    );
                    continue;
                }
            }

            seedByImportedId.set(candidate.importedId, {
                importedId: candidate.importedId,
                transferPayeeId: candidate.transferPayeeId,
                targetActualAccountId: candidate.targetActualAccount.id,
                targetActualAccountName: candidate.targetActualAccount.name,
            });
        }

        this.logger.debug(
            `Automatic transfer planning: seeds=${seedByImportedId.size}, suppressedCounterparts=${suppressedImportedIds.size}, counterpartConversions=${existingCounterpartConversionsByImportedId.size}`
        );

        return {
            seedByImportedId,
            suppressedImportedIds,
            existingCounterpartConversionsByImportedId,
        };
    }

    private findMatchingTransferCounterparts({
        candidate,
        monMonTransactionMap,
        matchWindowDays,
    }: {
        candidate: TransferPlanningCandidate;
        monMonTransactionMap: Record<string, MonMonTransaction[]>;
        matchWindowDays: number;
    }): MonMonTransaction[] {
        const targetTransactions =
            monMonTransactionMap[candidate.targetMonMonAccount.uuid] ?? [];
        const sourceAmount = Math.round(candidate.transaction.amount * 100);

        return targetTransactions.filter((transaction) => {
            const candidateImportedId =
                this.getIdForMoneyMoneyTransaction(transaction);
            const hasMatchingPurpose =
                !!candidate.transaction.purpose &&
                !!transaction.purpose &&
                candidate.transaction.purpose === transaction.purpose;
            const hasReciprocalAccountNumber =
                !!transaction.accountNumber &&
                !!candidate.sourceMonMonAccount.accountNumber &&
                transaction.accountNumber ===
                    candidate.sourceMonMonAccount.accountNumber;

            return (
                candidateImportedId !== candidate.importedId &&
                Math.round(transaction.amount * 100) === -sourceAmount &&
                (hasMatchingPurpose || hasReciprocalAccountNumber) &&
                Math.abs(
                    differenceInCalendarDays(
                        transaction.valueDate,
                        candidate.transaction.valueDate
                    )
                ) <= matchWindowDays
            );
        });
    }

    private async getExistingTransactionsForStartBalanceCheck({
        actualAccountId,
        existingActualTransactions,
        transfersEnabled,
        isDryRun,
    }: {
        actualAccountId: string;
        existingActualTransactions: ReadTransaction[];
        transfersEnabled: boolean;
        isDryRun: boolean;
    }): Promise<ReadTransaction[]> {
        if (
            existingActualTransactions.length > 0 ||
            !transfersEnabled ||
            isDryRun
        ) {
            return existingActualTransactions;
        }

        return this.actualApi.getTransactions(actualAccountId);
    }

    private async applyTransferCounterpartUpdates({
        importedTransactions,
        transferPlan,
    }: {
        importedTransactions: ReadTransaction[];
        transferPlan: TransferPlan;
    }) {
        if (importedTransactions.length === 0) {
            return;
        }

        for (const transaction of importedTransactions) {
            if (!transaction.imported_id) {
                continue;
            }

            const plannedSeed = transferPlan.seedByImportedId.get(
                transaction.imported_id
            );
            if (!plannedSeed?.sameRunCounterpart || !transaction.transfer_id) {
                continue;
            }

            const counterpartUpdate: Partial<UpdateTransaction> = {
                imported_id: plannedSeed.sameRunCounterpart.importedId,
                imported_payee: plannedSeed.sameRunCounterpart.importedPayee,
                date: plannedSeed.sameRunCounterpart.date,
                notes: plannedSeed.sameRunCounterpart.notes ?? '',
            };

            if (plannedSeed.sameRunCounterpart.cleared !== undefined) {
                counterpartUpdate.cleared =
                    plannedSeed.sameRunCounterpart.cleared;
            }

            await this.actualApi.updateTransaction(
                transaction.transfer_id,
                counterpartUpdate
            );

            this.logger.debug(
                `Stamped generated transfer counterpart '${transaction.transfer_id}' in '${plannedSeed.targetActualAccountName}' with imported_id '${plannedSeed.sameRunCounterpart.importedId}'.`
            );
        }
    }

    private async applyExistingCounterpartConversions({
        newMonMonTransactions,
        transferPlan,
    }: {
        newMonMonTransactions: MonMonTransaction[];
        transferPlan: TransferPlan;
    }) {
        for (const transaction of newMonMonTransactions) {
            const importedId = this.getIdForMoneyMoneyTransaction(transaction);
            const conversion =
                transferPlan.existingCounterpartConversionsByImportedId.get(
                    importedId
                );
            if (!conversion) {
                continue;
            }

            await this.actualApi.updateTransaction(
                conversion.existingCounterpartTransactionId,
                { payee: conversion.sourceTransferPayeeId }
            );

            const transactionNotes = this.buildTransactionNotes(transaction);

            this.logger.info(
                `Converted plain transaction in '${conversion.existingCounterpartAccountName}' to a transfer pair with source amount ${transaction.amount.toFixed(2)} on ${transaction.bookingDate.toISOString().slice(0, 10)}${transactionNotes ? ` (${transactionNotes})` : ''}.`
            );

            await new Promise((resolve) => setTimeout(resolve, 250));

            const targetTransactions = await this.actualApi.getTransactions(
                conversion.existingCounterpartAccountId
            );
            const convertedTarget = targetTransactions.find(
                (tx) => tx.id === conversion.existingCounterpartTransactionId
            );

            if (convertedTarget?.transfer_id) {
                const counterpartUpdate: Partial<UpdateTransaction> = {
                    imported_id: conversion.sourceImportedId,
                    imported_payee: conversion.sourceImportedPayee,
                };

                if (conversion.sourceNotes !== undefined) {
                    counterpartUpdate.notes = conversion.sourceNotes;
                }

                if (conversion.sourceCleared !== undefined) {
                    counterpartUpdate.cleared = conversion.sourceCleared;
                }

                await this.actualApi.updateTransaction(
                    convertedTarget.transfer_id,
                    counterpartUpdate
                );

                this.logger.debug(
                    `Stamped auto-created transfer counterpart '${convertedTarget.transfer_id}' with imported_id '${conversion.sourceImportedId}'.`
                );
            }
        }
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
        const question = buildConflictPromptText({
            transactionName: pair.monMonTransaction.name,
            valueDate: pair.monMonTransaction.valueDate,
            amount: pair.monMonTransaction.amount,
            currentCategory: fromCategory,
            targetCategory: toCategory,
        });

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
        transaction: MonMonTransaction,
        plannedTransfer?: PlannedTransferSeed
    ): Promise<CreateTransaction> {
        const transactionNotes = this.buildTransactionNotes(transaction);

        const createTransaction: CreateTransaction = {
            date: format(transaction.valueDate, 'yyyy-MM-dd'),
            amount: Math.round(transaction.amount * 100),
            imported_id: this.getIdForMoneyMoneyTransaction(transaction),
            imported_payee: transaction.name ?? '',
        };

        if (plannedTransfer) {
            createTransaction.payee = plannedTransfer.transferPayeeId;
        }

        if (this.config.import.synchronizeClearedStatus) {
            createTransaction.cleared = transaction.booked;
        }

        if (transactionNotes) {
            createTransaction.notes = transactionNotes;
        }

        return createTransaction;
    }

    private buildTransactionNotes(transaction: MonMonTransaction): string {
        return [
            transaction.purpose,
            transaction.comment && this.config.import.importComments
                ? `${this.config.import.commentPrefix}${transaction.comment}`
                : undefined,
        ]
            .filter(Boolean)
            .join(' | ');
    }

    private getIdForMoneyMoneyTransaction(transaction: MonMonTransaction) {
        return `${transaction.accountUuid}-${transaction.id}`;
    }

    private parseImportedId(importedId: string) {
        const separatorIndex = importedId.lastIndexOf('-');
        if (separatorIndex === -1) {
            return {
                monMonAccountUuid: importedId,
                monMonTransactionId: 'unknown',
            };
        }

        return {
            monMonAccountUuid: importedId.slice(0, separatorIndex),
            monMonTransactionId: importedId.slice(separatorIndex + 1),
        };
    }

    private buildDuplicateImportedIdGroups(
        sortedExistingTransactions: ReadTransaction[],
        duplicateImportedIds: Set<string>
    ): DuplicateImportedIdGroup[] {
        const groups: DuplicateImportedIdGroup[] = [];

        for (const importedId of duplicateImportedIds) {
            const transactions = sortedExistingTransactions.filter(
                (transaction) => transaction.imported_id === importedId
            );
            const representativeTransaction = transactions.at(-1);
            const firstTransaction = transactions[0];

            if (
                transactions.length < 2 ||
                !representativeTransaction ||
                !firstTransaction
            ) {
                continue;
            }

            const firstDate = firstTransaction.date;
            const firstNormalizedPayee =
                this.getNormalizedImportedPayee(firstTransaction);
            const isLikelySplit = transactions.every(
                (transaction) =>
                    transaction.date === firstDate &&
                    this.getNormalizedImportedPayee(transaction) ===
                        firstNormalizedPayee
            );

            groups.push({
                importedId,
                transactions,
                representativeTransaction,
                normalizedPayee: this.getNormalizedImportedPayee(
                    representativeTransaction
                ),
                isLikelySplit,
            });
        }

        return groups.sort((a, b) => a.importedId.localeCompare(b.importedId));
    }

    private getNormalizedImportedPayee(transaction: ReadTransaction): string {
        return (
            transaction.imported_payee?.trim() ||
            transaction.notes?.trim() ||
            '(no payee)'
        );
    }

    private formatMinorUnitsAsMajor(amount: number): string {
        return (amount / 100).toFixed(2);
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
