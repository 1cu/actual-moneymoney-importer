import type { APIAccountEntity } from '@actual-app/api/models';
import type { TransactionEntity } from '@actual-app/core/types/models';
import { differenceInCalendarDays } from 'date-fns';
import type {
    Account as MonMonAccount,
    Transaction as MonMonTransaction,
} from 'moneymoney';
import type CategoryMap from './CategoryMap.js';
import type { Config } from './config.js';
import type {
    PlannedExistingCounterpartConversion,
    PlannedTransferSeed,
    TransferPlan,
    TransferPlanningCandidate,
} from './Importer.types.js';
import type Logger from './Logger.js';
import {
    buildTransactionNotes,
    getIdForMoneyMoneyTransaction,
} from './shared.js';

type PlannerAccountState = {
    monMonAccount: MonMonAccount;
    actualAccount: APIAccountEntity;
    newMonMonTransactions: MonMonTransaction[];
};

type BuildTransferPlanInput = {
    fullAccountMapping: Map<MonMonAccount, APIAccountEntity>;
    accountStates: PlannerAccountState[];
    monMonTransactionMap: Record<string, MonMonTransaction[]>;
    existingActualTransactionsByAccountId: Map<string, TransactionEntity[]>;
    transferPayeeIdByAccountId: Map<string, string>;
};

export default class TransferPlanner {
    constructor(
        private readonly config: Config,
        private readonly categoryMap: CategoryMap,
        private readonly logger: Logger
    ) {}

    buildTransferPlan({
        fullAccountMapping,
        accountStates,
        monMonTransactionMap,
        existingActualTransactionsByAccountId,
        transferPayeeIdByAccountId,
    }: BuildTransferPlanInput): TransferPlan {
        const emptyPlan: TransferPlan = {
            seedByImportedId: new Map<string, PlannedTransferSeed>(),
            suppressedImportedIds: new Set<string>(),
            existingCounterpartConversionsByImportedId: new Map(),
            resolvedTransferCategoryUuids: new Set(),
        };

        const transferConfig = this.config.import.transfers;
        if (
            !transferConfig.enabled ||
            transferConfig.categoryRefs.length === 0
        ) {
            return emptyPlan;
        }

        const matchWindowDays = transferConfig.matchWindowDays ?? 0;

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
        const mappedAccountByUuid = new Map(
            mappedAccounts.map(({ monMonAccount, actualAccount }) => [
                monMonAccount.uuid,
                actualAccount,
            ])
        );
        const paddedNewTransactionsByAccountUuid = Object.fromEntries(
            Object.entries(monMonTransactionMap).map(
                ([accountUuid, transactions]) => {
                    const requestedImportedIds = new Set(
                        newTransactionsByAccountUuid[accountUuid]?.map(
                            transaction =>
                                getIdForMoneyMoneyTransaction(transaction)
                        ) ?? []
                    );
                    const existingImportedIds = new Set(
                        (
                            existingActualTransactionsByAccountId.get(
                                mappedAccountByUuid.get(accountUuid)?.id ?? ''
                            ) ?? []
                        )
                            .filter(transaction => !!transaction.imported_id)
                            .map(
                                transaction => transaction.imported_id as string
                            )
                    );

                    return [
                        accountUuid,
                        transactions.filter(transaction => {
                            const importedId =
                                getIdForMoneyMoneyTransaction(transaction);
                            return (
                                !requestedImportedIds.has(importedId) &&
                                !existingImportedIds.has(importedId)
                            );
                        }),
                    ];
                }
            )
        ) as Record<string, MonMonTransaction[]>;
        const mappedByAccountNumber = new Map<
            string,
            Array<{
                monMonAccount: MonMonAccount;
                actualAccount: APIAccountEntity;
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
                    importedId: getIdForMoneyMoneyTransaction(transaction),
                    sourceMonMonAccount: monMonAccount,
                    sourceActualAccount: actualAccount,
                    targetMonMonAccount: target.monMonAccount,
                    targetActualAccount: target.actualAccount,
                    transferPayeeId,
                });
            }
        }

        const rankedCandidates = candidates
            .map(candidate => ({
                ...candidate,
                hasExactDateCounterpart: this.hasExactDateCounterpart({
                    candidate,
                    newTransactionsByAccountUuid,
                    paddedNewTransactionsByAccountUuid,
                    monMonTransactionMap,
                    existingActualTransactionsByAccountId,
                }),
            }))
            .sort(
                (a, b) =>
                    Number(b.hasExactDateCounterpart) -
                        Number(a.hasExactDateCounterpart) ||
                    a.importedId.localeCompare(b.importedId)
            );

        const seedByImportedId = new Map<string, PlannedTransferSeed>();
        const suppressedImportedIds = new Set<string>();
        const claimedCounterpartIds = new Set<string>();
        const claimedExistingCounterpartTransactionIds = new Set<string>();
        const existingCounterpartConversionsByImportedId = new Map<
            string,
            PlannedExistingCounterpartConversion
        >();

        for (const candidate of rankedCandidates) {
            if (suppressedImportedIds.has(candidate.importedId)) {
                continue;
            }

            const matchingCounterparts = this.findSameRunTransferCounterparts({
                candidate,
                matchWindowDays,
                targetTransactions: [
                    ...(newTransactionsByAccountUuid[
                        candidate.targetMonMonAccount.uuid
                    ] ?? []),
                    ...(paddedNewTransactionsByAccountUuid[
                        candidate.targetMonMonAccount.uuid
                    ] ?? []),
                ],
            });
            const preferredMatchingCounterparts =
                this.preferExactDateCounterparts({
                    counterparts: matchingCounterparts,
                    candidateDate: candidate.transaction.valueDate,
                });

            if (preferredMatchingCounterparts.length > 1) {
                this.logger.debug(
                    `Skipping automatic transfer for '${candidate.importedId}' because multiple same-date same-run counterpart candidates were found.`
                );
                continue;
            }

            if (preferredMatchingCounterparts.length === 1) {
                const [exactSameRunCounterpart] = preferredMatchingCounterparts;
                if (!exactSameRunCounterpart) {
                    continue;
                }
                const sameRunCounterpartIsExactDate =
                    differenceInCalendarDays(
                        exactSameRunCounterpart.valueDate,
                        candidate.transaction.valueDate
                    ) === 0;
                const exactHistoricalCounterpart = sameRunCounterpartIsExactDate
                    ? undefined
                    : this.findUsableHistoricalCounterpart({
                          candidate,
                          historicalCounterparts:
                              this.findHistoricalTransferCounterparts({
                                  candidate,
                                  matchWindowDays: 0,
                                  targetTransactions:
                                      monMonTransactionMap[
                                          candidate.targetMonMonAccount.uuid
                                      ] ?? [],
                              }),
                          existingActualTransactionsByAccountId,
                          claimedExistingCounterpartTransactionIds,
                      });

                if (
                    !sameRunCounterpartIsExactDate &&
                    exactHistoricalCounterpart
                ) {
                    this.logger.debug(
                        `Skipping off-date same-run counterpart for '${candidate.importedId}' because an exact-date historical counterpart was found.`
                    );
                } else {
                    const counterpartImportedId = getIdForMoneyMoneyTransaction(
                        exactSameRunCounterpart
                    );
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
                            transaction =>
                                transaction.imported_id ===
                                counterpartImportedId
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
                        targetActualAccountName:
                            candidate.targetActualAccount.name,
                        sameRunCounterpart: {
                            importedId: counterpartImportedId,
                            importedPayee: exactSameRunCounterpart.name ?? '',
                            valueDate: exactSameRunCounterpart.valueDate,
                            notes:
                                buildTransactionNotes(
                                    exactSameRunCounterpart,
                                    this.config.import.importComments,
                                    this.config.import.commentPrefix
                                ) || '',
                            ...(this.config.import.synchronizeClearedStatus
                                ? { cleared: exactSameRunCounterpart.booked }
                                : {}),
                        },
                    });
                    continue;
                }
            }

            const existingCounterparts =
                this.findHistoricalTransferCounterparts({
                    candidate,
                    matchWindowDays,
                    targetTransactions:
                        monMonTransactionMap[
                            candidate.targetMonMonAccount.uuid
                        ] ?? [],
                });
            const preferredExistingCounterparts =
                this.preferExactDateCounterparts({
                    counterparts: existingCounterparts,
                    candidateDate: candidate.transaction.valueDate,
                });

            if (preferredExistingCounterparts.length > 1) {
                this.logger.debug(
                    `Skipping automatic transfer for '${candidate.importedId}' because multiple same-date historical counterpart candidates were found.`
                );
                continue;
            }

            const existingCounterpart = preferredExistingCounterparts[0];
            if (existingCounterpart) {
                const existingCounterpartImportedId =
                    getIdForMoneyMoneyTransaction(existingCounterpart);
                const existingTargetTransactions =
                    existingActualTransactionsByAccountId.get(
                        candidate.targetActualAccount.id
                    ) ?? [];
                const existingSourceTransactions =
                    existingActualTransactionsByAccountId.get(
                        candidate.sourceActualAccount.id
                    ) ?? [];
                // If the source-side counterpart was already stamped during a
                // partial historical conversion, skip re-planning it.
                if (
                    existingSourceTransactions.some(
                        transaction =>
                            transaction.imported_id === candidate.importedId &&
                            !!transaction.transfer_id
                    )
                ) {
                    this.logger.debug(
                        `Skipping automatic transfer for '${candidate.importedId}' because its transfer counterpart already exists in '${candidate.sourceActualAccount.name}'.`
                    );
                    continue;
                }

                const existingTargetTransaction =
                    existingTargetTransactions.find(
                        transaction =>
                            transaction.imported_id ===
                            existingCounterpartImportedId
                    );

                if (existingTargetTransaction?.transfer_id) {
                    this.logger.debug(
                        `Skipping automatic transfer for '${candidate.importedId}' because historical counterpart '${existingTargetTransaction.id}' is already part of a transfer.`
                    );
                    continue;
                }

                const sourceTransferPayeeId = transferPayeeIdByAccountId.get(
                    candidate.sourceActualAccount.id
                );
                if (!sourceTransferPayeeId) {
                    continue;
                }

                if (existingTargetTransaction) {
                    if (
                        claimedExistingCounterpartTransactionIds.has(
                            existingTargetTransaction.id
                        )
                    ) {
                        this.logger.debug(
                            `Skipping automatic transfer for '${candidate.importedId}' because historical counterpart '${existingTargetTransaction.id}' was already claimed by another transfer conversion.`
                        );
                        continue;
                    }

                    claimedExistingCounterpartTransactionIds.add(
                        existingTargetTransaction.id
                    );

                    suppressedImportedIds.add(candidate.importedId);

                    const sourceNotes = buildTransactionNotes(
                        candidate.transaction,
                        this.config.import.importComments,
                        this.config.import.commentPrefix
                    );

                    existingCounterpartConversionsByImportedId.set(
                        candidate.importedId,
                        {
                            existingCounterpartTransactionId:
                                existingTargetTransaction.id,
                            existingCounterpartAccountId:
                                candidate.targetActualAccount.id,
                            existingCounterpartAccountName:
                                candidate.targetActualAccount.name,
                            sourceActualAccountName:
                                candidate.sourceActualAccount.name,
                            sourceTransferPayeeId,
                            sourceImportedId: candidate.importedId,
                            sourceImportedPayee:
                                candidate.transaction.name ?? '',
                            ...(sourceNotes ? { sourceNotes } : {}),
                            ...(this.config.import.synchronizeClearedStatus
                                ? {
                                      sourceCleared:
                                          candidate.transaction.booked,
                                  }
                                : {}),
                        }
                    );

                    this.logger.debug(
                        `Planning conversion of historical counterpart '${existingTargetTransaction.id}' in '${candidate.targetActualAccount.name}' to a transfer for source '${candidate.importedId}'.`
                    );
                }
            }
        }

        this.logger.debug(
            `Automatic transfer planning: seeds=${seedByImportedId.size}, suppressedCounterparts=${suppressedImportedIds.size}, counterpartConversions=${existingCounterpartConversionsByImportedId.size}`
        );

        return {
            seedByImportedId,
            suppressedImportedIds,
            existingCounterpartConversionsByImportedId,
            resolvedTransferCategoryUuids: resolvedUuids,
        };
    }

    // Same-run matching is permissive for same-window transfers, but still
    // rejects contradictory target-side IBANs so unrelated bookings stay out.
    private findSameRunTransferCounterparts({
        candidate,
        matchWindowDays,
        targetTransactions,
    }: {
        candidate: TransferPlanningCandidate;
        matchWindowDays: number;
        targetTransactions: MonMonTransaction[];
    }): MonMonTransaction[] {
        const sourceAmount = Math.round(candidate.transaction.amount * 100);

        return targetTransactions.filter(transaction =>
            this.isMatchingTransferCounterpart({
                candidate,
                transaction,
                relaxedMatching: true,
                sourceAmount,
                candidateDate: candidate.transaction.valueDate,
                matchWindowDays,
            })
        );
    }

    private findHistoricalTransferCounterparts({
        candidate,
        matchWindowDays,
        targetTransactions,
    }: {
        candidate: TransferPlanningCandidate;
        matchWindowDays: number;
        targetTransactions: MonMonTransaction[];
    }): MonMonTransaction[] {
        const sourceAmount = Math.round(candidate.transaction.amount * 100);

        return targetTransactions.filter(transaction =>
            this.isMatchingTransferCounterpart({
                candidate,
                transaction,
                relaxedMatching: false,
                sourceAmount,
                candidateDate: candidate.transaction.valueDate,
                matchWindowDays,
            })
        );
    }

    private hasExactDateCounterpart({
        candidate,
        newTransactionsByAccountUuid,
        paddedNewTransactionsByAccountUuid = {},
        monMonTransactionMap,
        existingActualTransactionsByAccountId,
    }: {
        candidate: TransferPlanningCandidate;
        newTransactionsByAccountUuid: Record<string, MonMonTransaction[]>;
        paddedNewTransactionsByAccountUuid: Record<string, MonMonTransaction[]>;
        monMonTransactionMap: Record<string, MonMonTransaction[]>;
        existingActualTransactionsByAccountId: Map<string, TransactionEntity[]>;
    }): boolean {
        const exactHistoricalCounterpart = this.findUsableHistoricalCounterpart(
            {
                candidate,
                historicalCounterparts: this.findHistoricalTransferCounterparts(
                    {
                        candidate,
                        matchWindowDays: 0,
                        targetTransactions:
                            monMonTransactionMap[
                                candidate.targetMonMonAccount.uuid
                            ] ?? [],
                    }
                ),
                existingActualTransactionsByAccountId,
                claimedExistingCounterpartTransactionIds: new Set(),
            }
        );

        return (
            this.findSameRunTransferCounterparts({
                candidate,
                matchWindowDays: 0,
                targetTransactions: [
                    ...(newTransactionsByAccountUuid[
                        candidate.targetMonMonAccount.uuid
                    ] ?? []),
                    ...(paddedNewTransactionsByAccountUuid[
                        candidate.targetMonMonAccount.uuid
                    ] ?? []),
                ],
            }).length > 0 || !!exactHistoricalCounterpart
        );
    }

    private isMatchingTransferCounterpart({
        candidate,
        transaction,
        relaxedMatching,
        sourceAmount,
        candidateDate,
        matchWindowDays,
    }: {
        candidate: TransferPlanningCandidate;
        transaction: MonMonTransaction;
        relaxedMatching: boolean;
        sourceAmount: number;
        candidateDate: Date;
        matchWindowDays: number;
    }): boolean {
        const candidateImportedId = getIdForMoneyMoneyTransaction(transaction);
        if (candidateImportedId === candidate.importedId) {
            return false;
        }

        if (
            !this.matchesTransferCounterpartAmountAndDate({
                transaction,
                sourceAmount,
                candidateDate,
                matchWindowDays,
            })
        ) {
            return false;
        }

        if (relaxedMatching) {
            return (
                !this.hasContradictoryAccountNumber({
                    candidate,
                    transaction,
                }) &&
                (this.hasMatchingTransferSignal({ candidate, transaction }) ||
                    this.hasHardTargetAccountReference(candidate))
            );
        }

        return this.hasMatchingTransferSignal({ candidate, transaction });
    }

    private matchesTransferCounterpartAmountAndDate({
        transaction,
        sourceAmount,
        candidateDate,
        matchWindowDays,
    }: {
        transaction: MonMonTransaction;
        sourceAmount: number;
        candidateDate: Date;
        matchWindowDays: number;
    }): boolean {
        return (
            Math.round(transaction.amount * 100) === -sourceAmount &&
            Math.abs(
                differenceInCalendarDays(transaction.valueDate, candidateDate)
            ) <= matchWindowDays
        );
    }

    private preferExactDateCounterparts({
        counterparts,
        candidateDate,
    }: {
        counterparts: MonMonTransaction[];
        candidateDate: Date;
    }): MonMonTransaction[] {
        const exactDateCounterparts = counterparts.filter(
            transaction =>
                differenceInCalendarDays(
                    transaction.valueDate,
                    candidateDate
                ) === 0
        );

        return exactDateCounterparts.length > 0
            ? exactDateCounterparts
            : counterparts;
    }

    private findUsableHistoricalCounterpart({
        candidate,
        historicalCounterparts,
        existingActualTransactionsByAccountId,
        claimedExistingCounterpartTransactionIds,
    }: {
        candidate: TransferPlanningCandidate;
        historicalCounterparts: MonMonTransaction[];
        existingActualTransactionsByAccountId: Map<string, TransactionEntity[]>;
        claimedExistingCounterpartTransactionIds: Set<string>;
    }): TransactionEntity | undefined {
        const preferredHistoricalCounterparts =
            this.preferExactDateCounterparts({
                counterparts: historicalCounterparts,
                candidateDate: candidate.transaction.valueDate,
            });

        if (preferredHistoricalCounterparts.length !== 1) {
            return undefined;
        }

        const [exactHistoricalCounterpart] = preferredHistoricalCounterparts;
        if (!exactHistoricalCounterpart) {
            return undefined;
        }
        const exactHistoricalCounterpartImportedId =
            getIdForMoneyMoneyTransaction(exactHistoricalCounterpart);
        const existingTargetTransactions =
            existingActualTransactionsByAccountId.get(
                candidate.targetActualAccount.id
            ) ?? [];
        const existingTargetTransaction = existingTargetTransactions.find(
            transaction =>
                transaction.imported_id === exactHistoricalCounterpartImportedId
        );

        if (
            !existingTargetTransaction ||
            existingTargetTransaction.transfer_id ||
            claimedExistingCounterpartTransactionIds.has(
                existingTargetTransaction.id
            )
        ) {
            return undefined;
        }

        return existingTargetTransaction;
    }

    private hasMatchingTransferSignal({
        candidate,
        transaction,
    }: {
        candidate: TransferPlanningCandidate;
        transaction: MonMonTransaction;
    }): boolean {
        const hasMatchingPurpose =
            !!candidate.transaction.purpose &&
            !!transaction.purpose &&
            candidate.transaction.purpose === transaction.purpose;
        const hasReciprocalAccountNumber =
            !!transaction.accountNumber &&
            !!candidate.sourceMonMonAccount.accountNumber &&
            transaction.accountNumber ===
                candidate.sourceMonMonAccount.accountNumber;

        return hasMatchingPurpose || hasReciprocalAccountNumber;
    }

    private hasHardTargetAccountReference(
        candidate: TransferPlanningCandidate
    ): boolean {
        return (
            !!candidate.transaction.accountNumber &&
            candidate.transaction.accountNumber ===
                candidate.targetMonMonAccount.accountNumber
        );
    }

    private hasContradictoryAccountNumber({
        candidate,
        transaction,
    }: {
        candidate: TransferPlanningCandidate;
        transaction: MonMonTransaction;
    }): boolean {
        return (
            !!transaction.accountNumber &&
            !!candidate.sourceMonMonAccount.accountNumber &&
            transaction.accountNumber !==
                candidate.sourceMonMonAccount.accountNumber
        );
    }
}
