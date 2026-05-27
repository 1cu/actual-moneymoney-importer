import {
    addDays,
    differenceInCalendarDays,
    format,
    parse,
    subDays,
    subMonths,
} from 'date-fns';
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
import TransferPlanner from './TransferPlanner.js';
import type {
    TransactionEntity,
    ImportTransactionEntity,
} from '@actual-app/core/types/models';
import type {
    CategoryUpdateClassification,
    CategoryUpdatePlan,
    DuplicateImportedIdGroup,
    ExistingCategorySyncPolicy,
    ExistingCategoryUpdate,
    ExistingTransactionPair,
    ImportRunMetrics,
    PlannedTransferSeed,
    PromptDecision,
    PromptState,
    TransferPlan,
} from './Importer.types.js';
import {
    DATE_FORMAT,
    buildTransactionNotes,
    getIdForMoneyMoneyTransaction,
    sanitizeString,
} from './shared.js';

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

export const collectUniquePayeeNamesForTransformation = ({
    accountStates,
    transferPlan,
}: {
    accountStates: Array<{
        newMonMonTransactions: MonMonTransaction[];
    }>;
    transferPlan: TransferPlan;
}) => {
    const payeeNames = new Set<string>();

    for (const accountState of accountStates) {
        for (const transaction of accountState.newMonMonTransactions) {
            const importedId = getIdForMoneyMoneyTransaction(transaction);
            if (
                transferPlan.suppressedImportedIds.has(importedId) ||
                transferPlan.seedByImportedId.has(importedId)
            ) {
                continue;
            }

            const payeeName = transaction.name?.trim();
            if (payeeName) {
                payeeNames.add(payeeName);
            }
        }
    }

    return [...payeeNames].sort((a, b) => a.localeCompare(b));
};

export const getTransferFetchWindow = ({
    importDate,
    toDate,
    matchWindowDays,
}: {
    importDate: Date;
    toDate?: Date;
    matchWindowDays: number;
}) => ({
    from:
        matchWindowDays > 0 ? subDays(importDate, matchWindowDays) : importDate,
    ...(toDate
        ? {
              to:
                  matchWindowDays > 0
                      ? addDays(toDate, matchWindowDays)
                      : toDate,
          }
        : {}),
});

export const isWithinRequestedImportRange = ({
    transactionDate,
    importDate,
    toDate,
}: {
    transactionDate: Date;
    importDate: Date;
    toDate?: Date;
}): boolean => {
    if (differenceInCalendarDays(transactionDate, importDate) < 0) {
        return false;
    }

    if (toDate && differenceInCalendarDays(transactionDate, toDate) > 0) {
        return false;
    }

    return true;
};

export const filterTransactionsForRequestedImportRange = ({
    transactions,
    importDate,
    toDate,
}: {
    transactions: MonMonTransaction[];
    importDate: Date;
    toDate?: Date;
}): MonMonTransaction[] =>
    transactions.filter((transaction) =>
        isWithinRequestedImportRange({
            transactionDate: transaction.valueDate,
            importDate,
            ...(toDate ? { toDate } : {}),
        })
    );

export const getLatestTransactionValueDate = (
    transactions: MonMonTransaction[]
): Date | null => {
    if (transactions.length === 0) {
        return null;
    }

    return transactions.reduce(
        (latest, transaction) =>
            transaction.valueDate > latest ? transaction.valueDate : latest,
        transactions[0]!.valueDate
    );
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
        importedId: pair.actualTransaction.imported_id as string,
        ...(fromCategoryId ? { fromCategoryId } : {}),
        toCategoryId: targetCategoryId,
        reason,
        monMonTransaction: pair.monMonTransaction,
    };
};

export const convertToActualTransaction = (
    transaction: MonMonTransaction,
    plannedTransfer: PlannedTransferSeed | undefined,
    actualAccountId: string,
    options: {
        importComments: boolean;
        commentPrefix: string;
        synchronizeClearedStatus: boolean;
    }
): ImportTransactionEntity => {
    const transactionNotes = buildTransactionNotes(
        transaction,
        options.importComments,
        options.commentPrefix
    );

    const createTransaction: ImportTransactionEntity = {
        account: actualAccountId,
        date: format(transaction.valueDate, DATE_FORMAT),
        amount: Math.round(transaction.amount * 100),
        imported_id: getIdForMoneyMoneyTransaction(transaction),
        imported_payee: transaction.name?.trim() ?? '',
    };

    if (plannedTransfer) {
        createTransaction.payee = plannedTransfer.transferPayeeId;
    }

    if (options.synchronizeClearedStatus) {
        createTransaction.cleared = transaction.booked;
    }

    if (transactionNotes) {
        createTransaction.notes = transactionNotes;
    }

    return createTransaction;
};

export const getStartingBalanceForAccount = (
    account: MonMonAccount,
    transactions: MonMonTransaction[]
): number => {
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
};

class Importer {
    private readonly transferPlanner: TransferPlanner;
    private hadImportErrors = false;

    constructor(
        private config: Config,
        private budgetConfig: ActualBudgetConfig,
        private actualApi: ActualApi,
        private logger: Logger,
        private accountMap: AccountMap,
        private categoryMap: CategoryMap,
        private payeeTransformer?: PayeeTransformer
    ) {
        this.transferPlanner = new TransferPlanner(
            this.config,
            this.categoryMap,
            this.logger
        );
    }

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
            ? parse(
                  this.budgetConfig.earliestImportDate,
                  DATE_FORMAT,
                  new Date()
              )
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

        const transfersEnabled = this.config.import.transfers.enabled;
        const matchWindowDays = transfersEnabled
            ? (this.config.import.transfers.matchWindowDays ?? 0)
            : 0;
        const fetchWindow = getTransferFetchWindow({
            importDate,
            matchWindowDays,
            ...(toDate ? { toDate } : {}),
        });

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

        if (matchWindowDays > 0) {
            this.logger.debug(
                `Transfer matching window is widened to ${format(fetchWindow.from, DATE_FORMAT)}${fetchWindow.to ? ` .. ${format(fetchWindow.to, DATE_FORMAT)}` : ''} (requested import window: ${format(importDate, DATE_FORMAT)}${toDate ? ` .. ${format(toDate, DATE_FORMAT)}` : ''}).`
            );
        }

        const getTransactionsOptions: {
            from: Date;
            to?: Date;
        } = {
            from: fetchWindow.from,
        };

        if (fetchWindow.to) {
            getTransactionsOptions.to = fetchWindow.to;
        }

        let monMonTransactions = await getTransactions(getTransactionsOptions);

        // Defensive normalization: sanitize string fields that originate
        // from MoneyMoney via AppleScript, which can suffer from encoding
        // corruption (e.g., umlauts replaced with '?').
        monMonTransactions = monMonTransactions.map((tx) => ({
            ...tx,
            name: sanitizeString(tx.name),
            purpose: sanitizeString(tx.purpose),
            comment: sanitizeString(tx.comment),
        }));

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

        const requestedRangeMonMonTransactions =
            filterTransactionsForRequestedImportRange({
                transactions: monMonTransactions,
                importDate,
                ...(toDate ? { toDate } : {}),
            });

        if (requestedRangeMonMonTransactions.length === 0) {
            this.logger.info(
                `No transactions found in the requested import range ${format(importDate, DATE_FORMAT)}${toDate ? ` .. ${format(toDate, DATE_FORMAT)}` : ''}.`
            );
            return;
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

        const requestedRangeMonMonTransactionMap =
            requestedRangeMonMonTransactions.reduce(
                (acc, transaction) => {
                    if (!acc[transaction.accountUuid]) {
                        acc[transaction.accountUuid] = [];
                    }

                    acc[transaction.accountUuid]?.push(transaction);

                    return acc;
                },
                {} as Record<string, MonMonTransaction[]>
            );

        const fullAccountMapping = transfersEnabled
            ? this.accountMap.getMap()
            : undefined;
        const accountMapping = accountRefs
            ? this.accountMap.getMap(accountRefs)
            : (fullAccountMapping ?? this.accountMap.getMap());
        const existingActualTransactionsByAccountId = new Map<
            string,
            TransactionEntity[]
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
                    requestedRangeMonMonTransactionMap[monMonAccount.uuid] ??
                    [];
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
                        duplicateScanWindow: {
                            from: format(fetchWindow.from, DATE_FORMAT),
                            ...(fetchWindow.to
                                ? { to: format(fetchWindow.to, DATE_FORMAT) }
                                : {}),
                        },
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
            ? this.transferPlanner.buildTransferPlan({
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
                  resolvedTransferCategoryUuids: new Set<string>(),
              };

        // Sort account states so seed accounts process first — this ensures
        // counterpart accounts import after transfer creation and can stamp
        // auto-created counterparts in the same run.
        const seedImportedIds = new Set(transferPlan.seedByImportedId.keys());
        const isSeedAccount = (state: (typeof accountStates)[number]) =>
            state.newMonMonTransactions.some((tx) =>
                seedImportedIds.has(getIdForMoneyMoneyTransaction(tx))
            );
        accountStates.sort((a, b) => {
            const aSeed = isSeedAccount(a) ? 0 : 1;
            const bSeed = isSeedAccount(b) ? 0 : 1;
            return aSeed - bSeed;
        });

        const shouldTransformPayees = !!this.payeeTransformer && !isDryRun;
        let transformedPayeesByRawName: Record<string, string> | null = null;
        const payeeTransformer = this.payeeTransformer;

        if (shouldTransformPayees && payeeTransformer) {
            const uniquePayeeNames = collectUniquePayeeNamesForTransformation({
                accountStates,
                transferPlan,
            });

            if (uniquePayeeNames.length > 0) {
                const transformedPayees =
                    await payeeTransformer.transformPayees(
                        uniquePayeeNames,
                        existingPayeeNames
                    );

                if (transformedPayees === null) {
                    const onError =
                        this.config.payeeTransformation.onTransformError;

                    if (onError === 'fail') {
                        throw new Error(
                            'Payee transformation failed. Check the error messages above for details.'
                        );
                    }

                    this.logger.warn(
                        'Payee transformation failed. Using default payee names...'
                    );
                } else {
                    transformedPayeesByRawName = transformedPayees;
                }
            }
        }

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
            accountsWithImportErrors: 0,
            totalImportErrors: 0,
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

                const createTransactions: ImportTransactionEntity[] = [];
                // Maps imported_id → intended category ID (for auto-rule override detection).
                const intendedCategoryByImportedId = new Map<string, string>();
                for (const transaction of newMonMonTransactions) {
                    const importedId =
                        getIdForMoneyMoneyTransaction(transaction);
                    if (transferPlan.suppressedImportedIds.has(importedId)) {
                        continue;
                    }

                    const plannedTransfer =
                        transferPlan.seedByImportedId.get(importedId);
                    const createTransaction =
                        await this.convertToActualTransaction(
                            transaction,
                            plannedTransfer,
                            actualAccount.id
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

                            const isTransferHandled =
                                transferPlan.seedByImportedId.has(importedId) ||
                                transferPlan.suppressedImportedIds.has(
                                    importedId
                                ) ||
                                transferPlan.existingCounterpartConversionsByImportedId.has(
                                    importedId
                                );

                            if (
                                !unmappedCategoryWarnings.has(warningKey) &&
                                !isTransferHandled
                            ) {
                                unmappedCategoryWarnings.add(warningKey);
                                runMetrics.totalUnmappedCategoryWarnings++;
                                this.logger.warn(
                                    `No category mapping found for MoneyMoney category '${warningKey}'. Transaction categories will be left untouched.`
                                );
                            } else if (isTransferHandled) {
                                this.logger.debug(
                                    `Skipping unmapped category warning for transfer-handled category '${warningKey}'.`
                                );
                            }
                        }
                    }

                    createTransactions.push(createTransaction);
                }

                if (!isDryRun) {
                    await this.applyExistingCounterpartConversions({
                        newMonMonTransactions,
                        transferPlan,
                    });
                }

                const effectiveExistingActualTransactions =
                    await this.getExistingTransactionsForStartBalanceCheck({
                        actualAccountId: actualAccount.id,
                        existingActualTransactions,
                        transfersEnabled,
                        isDryRun,
                    });

                if (effectiveExistingActualTransactions.length === 0) {
                    const latestTransactionDate =
                        getLatestTransactionValueDate(accountTransactions);

                    const startTransaction: ImportTransactionEntity = {
                        account: actualAccount.id,
                        date: format(
                            latestTransactionDate ?? new Date(),
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

                    createTransactions.forEach((t) => {
                        if (t.payee) {
                            return;
                        }

                        t.payee_name = shouldTransformPayees
                            ? (transformedPayeesByRawName?.[
                                  t.imported_payee as string
                              ] ??
                              t.imported_payee ??
                              '')
                            : (t.imported_payee ?? '');
                    });

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

                        const importErrors = result.errors ?? [];
                        const hadImportErrors = importErrors.length > 0;

                        if (hadImportErrors) {
                            this.hadImportErrors = true;
                            runMetrics.accountsWithImportErrors++;
                            runMetrics.totalImportErrors += importErrors.length;
                            this.logger.error(
                                'Some errors occurred during import:'
                            );
                            for (let i = 0; i < importErrors.length; i++) {
                                this.logger.error(
                                    `Error ${i + 1}: ${importErrors[i]?.message ?? 'Unknown error'}`
                                );
                            }
                        }

                        if (hadImportErrors) {
                            this.logger.warn(
                                `Transaction import to account '${actualAccount.name}' completed with errors`,
                                [
                                    `Added ${result.added.length} new transaction.`,
                                    `Updated ${result.updated.length} existing transaction.`,
                                ]
                            );
                        } else {
                            this.logger.info(
                                `Transaction import to account '${actualAccount.name}' successful`,
                                [
                                    `Added ${result.added.length} new transaction.`,
                                    `Updated ${result.updated.length} existing transaction.`,
                                ]
                            );
                        }

                        const importedTransactions =
                            result.added.length > 0 || result.updated.length > 0
                                ? await this.actualApi.getTransactionsByIds(
                                      actualAccount.id,
                                      [...result.added, ...result.updated]
                                  )
                                : [];

                        await this.applyTransferCounterpartUpdates({
                            actualAccountName: actualAccount.name,
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
                        `Category sync excluded ${transferLockedCount} transfer-linked existing transaction(s) in '${actualAccount.name}' (Actual manages transfer categories).`
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

    public hasImportErrors() {
        return this.hadImportErrors;
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
        importedTransactions: TransactionEntity[];
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
        const hasImportErrors = metrics.totalImportErrors > 0;
        const hasNotableWarnings =
            metrics.totalUnmappedCategoryWarnings > 0 || hasImportErrors;

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

        if (hasImportErrors) {
            hints.push(
                `Import errors: ${metrics.totalImportErrors} row-level error(s) across ${metrics.accountsWithImportErrors} account(s)`
            );
            this.logger.warn('Import run completed with errors', hints);
        } else {
            this.logger.info('Import run summary', hints);
        }
    }

    private buildAccountTransactionBuckets({
        monMonAccount,
        accountTransactions,
        existingActualTransactions,
        actualAccountName,
        shouldSyncCategories,
        duplicateScanWindow,
    }: {
        monMonAccount: MonMonAccount;
        accountTransactions: MonMonTransaction[];
        existingActualTransactions: TransactionEntity[];
        actualAccountName: string;
        shouldSyncCategories: boolean;
        duplicateScanWindow?: { from: string; to?: string };
    }) {
        const existingByImportedId = new Map<string, TransactionEntity>();

        // Deterministic winner policy for duplicate imported_id values: latest by (date, id) wins.
        const sortedExistingTransactions = [...existingActualTransactions]
            .filter((transaction) => !!transaction.imported_id)
            .sort((a, b) => {
                if (a.date === b.date) {
                    return a.id.localeCompare(b.id);
                }

                return a.date.localeCompare(b.date);
            });

        // Build the deduplication map from ALL existing transactions so
        // that previously imported transactions are correctly recognised
        // regardless of date.  Latest by (date, id) wins.
        for (const transaction of sortedExistingTransactions) {
            if (!transaction.imported_id) {
                continue;
            }
            existingByImportedId.set(transaction.imported_id, transaction);
        }

        // Only detect duplicate imported_ids within the scan window to
        // avoid noisy diagnostics for transactions well outside the import
        // range (e.g. a 2025 duplicate in a 2026 import run).
        const duplicateImportedIds = new Set<string>();
        const scanTransactions = duplicateScanWindow
            ? sortedExistingTransactions.filter((tx) => {
                  return (
                      tx.date >= duplicateScanWindow.from &&
                      (!duplicateScanWindow.to ||
                          tx.date <= duplicateScanWindow.to)
                  );
              })
            : sortedExistingTransactions;

        const seenInWindow = new Set<string>();
        for (const transaction of scanTransactions) {
            if (!transaction.imported_id) {
                continue;
            }
            if (seenInWindow.has(transaction.imported_id)) {
                duplicateImportedIds.add(transaction.imported_id);
            }
            seenInWindow.add(transaction.imported_id);
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
            const importedId = getIdForMoneyMoneyTransaction(transaction);
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

    private async getExistingTransactionsForStartBalanceCheck({
        actualAccountId,
        existingActualTransactions,
        transfersEnabled,
        isDryRun,
    }: {
        actualAccountId: string;
        existingActualTransactions: TransactionEntity[];
        transfersEnabled: boolean;
        isDryRun: boolean;
    }): Promise<TransactionEntity[]> {
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
        actualAccountName,
        importedTransactions,
        transferPlan,
    }: {
        actualAccountName: string;
        importedTransactions: TransactionEntity[];
        transferPlan: TransferPlan;
    }) {
        if (importedTransactions.length === 0) {
            return;
        }

        const counterpartUpdates: Record<string, unknown>[] = [];
        const counterpartLogs: Array<{
            transferId: string;
            targetActualAccountName: string;
            amount: number;
            date: string;
            notes: string | undefined;
            importedId: string;
        }> = [];

        for (const transaction of importedTransactions) {
            if (!transaction.imported_id) {
                continue;
            }

            const plannedSeed = transferPlan.seedByImportedId.get(
                transaction.imported_id
            );
            if (!plannedSeed || !transaction.transfer_id) {
                continue;
            }

            if (!plannedSeed.sameRunCounterpart) {
                continue;
            }

            const counterpartUpdate: Record<string, unknown> = {
                id: transaction.transfer_id,
                imported_id: plannedSeed.sameRunCounterpart.importedId,
                imported_payee: plannedSeed.sameRunCounterpart.importedPayee,
                notes: plannedSeed.sameRunCounterpart.notes ?? '',
                date: format(
                    plannedSeed.sameRunCounterpart.valueDate,
                    DATE_FORMAT
                ),
            };

            if (plannedSeed.sameRunCounterpart.cleared !== undefined) {
                counterpartUpdate.cleared =
                    plannedSeed.sameRunCounterpart.cleared;
            }

            counterpartUpdates.push(counterpartUpdate);
            counterpartLogs.push({
                transferId: transaction.transfer_id,
                targetActualAccountName: plannedSeed.targetActualAccountName,
                amount: transaction.amount,
                date: transaction.date,
                notes: transaction.notes || undefined,
                importedId: plannedSeed.sameRunCounterpart.importedId,
            });
        }

        if (counterpartUpdates.length === 0) {
            return;
        }

        await this.actualApi.batchUpdateTransactions({
            updated: counterpartUpdates,
            runTransfers: false,
        });

        for (const logEntry of counterpartLogs) {
            this.logger.info(
                `Created transfer from '${actualAccountName}' to '${logEntry.targetActualAccountName}' with amount ${(logEntry.amount / 100).toFixed(2)} on ${logEntry.date}${logEntry.notes ? ` (${logEntry.notes})` : ''}.`
            );

            this.logger.debug(
                `Stamped generated transfer counterpart '${logEntry.transferId}' in '${logEntry.targetActualAccountName}' with imported_id '${logEntry.importedId}'.`
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
            const importedId = getIdForMoneyMoneyTransaction(transaction);
            const conversion =
                transferPlan.existingCounterpartConversionsByImportedId.get(
                    importedId
                );
            if (!conversion) {
                continue;
            }

            try {
                await this.actualApi.updateTransaction(
                    conversion.existingCounterpartTransactionId,
                    { payee: conversion.sourceTransferPayeeId }
                );
            } catch (error) {
                throw new Error(
                    `Failed to convert plain transaction '${conversion.existingCounterpartTransactionId}' in '${conversion.existingCounterpartAccountName}' to a transfer: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }

            let convertAttempt = 0;
            let transferId: string | undefined;

            while (convertAttempt < 5 && !transferId) {
                if (convertAttempt > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }

                try {
                    const targetTransactions =
                        await this.actualApi.getTransactionsByIds(
                            conversion.existingCounterpartAccountId,
                            [conversion.existingCounterpartTransactionId]
                        );
                    const convertedTarget = targetTransactions[0];

                    transferId = convertedTarget?.transfer_id;

                    if (!transferId) {
                        this.logger.debug(
                            `Retrying auto-created transfer counterpart lookup for '${conversion.existingCounterpartTransactionId}' in '${conversion.existingCounterpartAccountId}' (attempt ${convertAttempt + 1}/5) after ${convertedTarget ? `transaction '${convertedTarget.id}' without a transfer id` : 'no matching transaction'}.`
                        );
                    }
                } catch (error) {
                    this.logger.debug(
                        `Retrying auto-created transfer counterpart lookup for '${conversion.existingCounterpartTransactionId}' in '${conversion.existingCounterpartAccountId}' (attempt ${convertAttempt + 1}/5) after error: ${error instanceof Error ? error.message : String(error)}`
                    );

                    if (this.isAuthOrPermissionError(error)) {
                        throw error;
                    }
                }

                convertAttempt++;
            }

            if (!transferId) {
                throw new Error(
                    `Could not locate auto-created transfer counterpart for converted transaction '${conversion.existingCounterpartTransactionId}' in '${conversion.existingCounterpartAccountName}' after retries.`
                );
            }

            try {
                const counterpartUpdate: Record<string, unknown> = {
                    id: transferId,
                    imported_id: conversion.sourceImportedId,
                    imported_payee: conversion.sourceImportedPayee,
                    date: format(transaction.valueDate, DATE_FORMAT),
                };

                if (conversion.sourceNotes !== undefined) {
                    counterpartUpdate.notes = conversion.sourceNotes;
                }

                if (conversion.sourceCleared !== undefined) {
                    counterpartUpdate.cleared = conversion.sourceCleared;
                }

                await this.actualApi.batchUpdateTransactions({
                    updated: [counterpartUpdate],
                    runTransfers: false,
                });
            } catch (error) {
                throw new Error(
                    `Failed to stamp auto-created transfer counterpart '${transferId}' for converted transaction '${conversion.existingCounterpartTransactionId}': ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }

            const transactionNotes = buildTransactionNotes(
                transaction,
                this.config.import.importComments,
                this.config.import.commentPrefix
            );

            this.logger.info(
                `Converted plain transaction in '${conversion.existingCounterpartAccountName}' to a transfer from '${conversion.sourceActualAccountName}' with amount ${transaction.amount.toFixed(2)} on ${format(transaction.valueDate, DATE_FORMAT)}${transactionNotes ? ` (${transactionNotes})` : ''}.`
            );

            this.logger.debug(
                `Stamped auto-created transfer counterpart '${transferId}' with imported_id '${conversion.sourceImportedId}'.`
            );
        }
    }

    private isAuthOrPermissionError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const status = (error as { status?: unknown }).status;

        return status === 401 || status === 403;
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
        plannedTransfer: PlannedTransferSeed | undefined,
        actualAccountId: string
    ): Promise<ImportTransactionEntity> {
        return convertToActualTransaction(
            transaction,
            plannedTransfer,
            actualAccountId,
            {
                importComments: this.config.import.importComments,
                commentPrefix: this.config.import.commentPrefix,
                synchronizeClearedStatus:
                    this.config.import.synchronizeClearedStatus,
            }
        );
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
        sortedExistingTransactions: TransactionEntity[],
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

    private getNormalizedImportedPayee(transaction: TransactionEntity): string {
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
    ): number {
        return getStartingBalanceForAccount(account, transactions);
    }
}

export default Importer;
