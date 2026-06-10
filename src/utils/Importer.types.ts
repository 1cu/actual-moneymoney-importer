import type { APIAccountEntity } from '@actual-app/api/models';
import type { TransactionEntity } from '@actual-app/core/types/models';
import type {
    Account as MonMonAccount,
    Transaction as MonMonTransaction,
} from 'moneymoney';

/** Effective existing-category sync behaviour derived from {@link Config.import.categorySync}. */
export type ExistingCategorySyncPolicy =
    | 'always' // categorySync = "all"
    | 'new'; // categorySync = "new" or legacy "ask" fallback

export type CategoryUpdateClassification =
    | { type: 'backfill'; targetCategoryId: string }
    | {
          type: 'conflict';
          targetCategoryId: string;
          currentCategoryId: string;
      }
    | { type: 'noop' };

export type ExistingTransactionPair = {
    monMonTransaction: MonMonTransaction;
    actualTransaction: TransactionEntity;
};

export type ExistingCategoryUpdate = {
    transactionId: string;
    importedId: string;
    fromCategoryId?: string;
    toCategoryId: string;
    reason: 'backfill' | 'conflict';
    monMonTransaction: MonMonTransaction;
};

export type PromptMode = 'prompt' | 'all' | 'none';
export type PromptDecision = boolean | 'all' | 'none' | 'quit';

export type PromptState = {
    mode: PromptMode;
    promptInterface?: ReturnType<
        typeof import('node:readline/promises').createInterface
    >;
};

export type CategoryUpdatePlan = {
    pendingUpdates: ExistingCategoryUpdate[];
    backfillCount: number;
    conflictCount: number;
    skippedConflictCount: number;
    transferLockedCount: number;
};

export type ImportRunMetrics = {
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
    accountsWithImportErrors: number;
    totalImportErrors: number;
};

export type DuplicateImportedIdGroup = {
    importedId: string;
    transactions: TransactionEntity[];
    representativeTransaction: TransactionEntity;
    normalizedPayee: string;
    isLikelySplit: boolean;
};

export type PlannedTransferCounterpart = {
    importedId: string;
    importedPayee: string;
    valueDate: Date;
    notes?: string;
    cleared?: boolean;
};

export type PlannedTransferSeed = {
    importedId: string;
    transferPayeeId: string;
    targetActualAccountId: string;
    targetActualAccountName: string;
    sameRunCounterpart?: PlannedTransferCounterpart;
};

export type PlannedExistingCounterpartConversion = {
    existingCounterpartTransactionId: string;
    existingCounterpartAccountId: string;
    existingCounterpartAccountName: string;
    sourceActualAccountName: string;
    sourceTransferPayeeId: string;
    sourceImportedId: string;
    sourceImportedPayee: string;
    sourceNotes?: string;
    sourceCleared?: boolean;
};

export type TransferPlan = {
    seedByImportedId: Map<string, PlannedTransferSeed>;
    suppressedImportedIds: Set<string>;
    existingCounterpartConversionsByImportedId: Map<
        string,
        PlannedExistingCounterpartConversion
    >;
    resolvedTransferCategoryUuids: Set<string>;
};

export type TransferPlanningCandidate = {
    transaction: MonMonTransaction;
    importedId: string;
    sourceMonMonAccount: MonMonAccount;
    sourceActualAccount: APIAccountEntity;
    targetMonMonAccount: MonMonAccount;
    targetActualAccount: APIAccountEntity;
    transferPayeeId: string;
};
