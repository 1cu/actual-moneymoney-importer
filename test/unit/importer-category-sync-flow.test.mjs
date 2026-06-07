import assert from 'node:assert/strict';
import test from 'node:test';
import Importer from '../../dist/utils/Importer.js';

const makeLogger = () => {
    const infos = [];
    const warnings = [];
    const debugs = [];
    const toHintArray = (hint) => {
        if (!hint) {
            return [];
        }
        return Array.isArray(hint) ? hint : [hint];
    };
    return {
        infos,
        warnings,
        debugs,
        debug: (message, hint) =>
            debugs.push({ message, hints: toHintArray(hint) }),
        info: (message, hint) =>
            infos.push({ message, hints: toHintArray(hint) }),
        warn: (message, hint) =>
            warnings.push({ message, hints: toHintArray(hint) }),
        error: () => {},
        phase: () => {},
    };
};

const makeImporter = ({
    mappingByUuid = {},
    policy = 'ask',
    updateTransaction = async () => {},
} = {}) => {
    const logger = makeLogger();
    const actualApi = {
        updateTransaction,
    };
    const accountMap = {
        getMap: () => [],
    };
    const categoryMap = {
        getMappedActualCategoryId: (uuid) =>
            mappingByUuid[uuid] ?? {
                actualCategoryId: undefined,
                isUncategorized: false,
                isMapped: false,
            },
        getActualCategoryPath: (categoryId) => categoryId,
    };
    const config = {
        import: {
            categorySyncOnExisting: policy,
            synchronizeCategories: true,
        },
    };
    const budgetConfig = {};

    const importer = new Importer(
        config,
        budgetConfig,
        actualApi,
        logger,
        accountMap,
        categoryMap
    );

    return { importer, logger };
};

const makePair = ({
    importedId = 'imp-1',
    currentCategoryId,
    sourceUuid = 'mm-1',
} = {}) => ({
    monMonTransaction: {
        id: importedId.split('-').at(-1) ?? '1',
        accountUuid: 'acc-1',
        categoryUuid: sourceUuid,
        name: 'Txn',
        valueDate: new Date('2026-02-18'),
        amount: -12.34,
    },
    actualTransaction: {
        id: `actual-${importedId}`,
        imported_id: importedId,
        category: currentCategoryId,
    },
});

test('planExistingCategoryUpdates backfills null category for new policy', async () => {
    const { importer } = makeImporter({
        mappingByUuid: {
            'mm-1': {
                actualCategoryId: 'cat-target',
                isUncategorized: false,
                isMapped: true,
            },
        },
        policy: 'new',
    });

    const plan = await importer.planExistingCategoryUpdates({
        existingPairs: [makePair({ currentCategoryId: undefined })],
        existingCategoryPolicy: 'new',
        promptState: { mode: 'prompt' },
    });

    assert.equal(plan.backfillCount, 1);
    assert.equal(plan.pendingUpdates.length, 1);
    assert.equal(plan.pendingUpdates[0]?.toCategoryId, 'cat-target');
    assert.equal(plan.pendingUpdates[0]?.reason, 'backfill');
    assert.equal(plan.transferLockedCount, 0);
});

test('planExistingCategoryUpdates skips conflict for new and applies for always', async () => {
    const mappingByUuid = {
        'mm-1': {
            actualCategoryId: 'cat-target',
            isUncategorized: false,
            isMapped: true,
        },
    };

    const { importer: importerNew } = makeImporter({ mappingByUuid });
    const planNew = await importerNew.planExistingCategoryUpdates({
        existingPairs: [makePair({ currentCategoryId: 'cat-current' })],
        existingCategoryPolicy: 'new',
        promptState: { mode: 'prompt' },
    });
    assert.equal(planNew.pendingUpdates.length, 0);
    assert.equal(planNew.skippedConflictCount, 1);
    assert.equal(planNew.transferLockedCount, 0);

    const { importer: importerAlways } = makeImporter({ mappingByUuid });
    const planAlways = await importerAlways.planExistingCategoryUpdates({
        existingPairs: [makePair({ currentCategoryId: 'cat-current' })],
        existingCategoryPolicy: 'always',
        promptState: { mode: 'prompt' },
    });
    assert.equal(planAlways.pendingUpdates.length, 1);
    assert.equal(planAlways.pendingUpdates[0]?.reason, 'conflict');
    assert.equal(planAlways.transferLockedCount, 0);
});

test('planExistingCategoryUpdates skips transfer-linked transactions from category sync', async () => {
    const { importer } = makeImporter({
        mappingByUuid: {
            'mm-1': {
                actualCategoryId: 'cat-target',
                isUncategorized: false,
                isMapped: true,
            },
        },
        policy: 'new',
    });

    const pair = makePair({ currentCategoryId: undefined });
    pair.actualTransaction.transfer_id = 'transfer-123';

    const plan = await importer.planExistingCategoryUpdates({
        existingPairs: [pair],
        existingCategoryPolicy: 'new',
        promptState: { mode: 'prompt' },
    });

    assert.equal(plan.backfillCount, 0);
    assert.equal(plan.conflictCount, 0);
    assert.equal(plan.pendingUpdates.length, 0);
    assert.equal(plan.transferLockedCount, 1);
});

test('planExistingCategoryUpdates aborts on quit decision', async () => {
    const { importer } = makeImporter({
        mappingByUuid: {
            'mm-1': {
                actualCategoryId: 'cat-target',
                isUncategorized: false,
                isMapped: true,
            },
        },
    });

    importer.promptForConflictDecision = async () => 'quit';

    await assert.rejects(
        () =>
            importer.planExistingCategoryUpdates({
                existingPairs: [makePair({ currentCategoryId: 'cat-current' })],
                existingCategoryPolicy: 'ask',
                promptState: {
                    mode: 'prompt',
                    promptInterface: {},
                },
            }),
        /Category sync aborted by user/
    );
});

test('applyOrPreviewCategoryUpdates does not mutate in dry run', async () => {
    let updateCalls = 0;
    const { importer } = makeImporter({
        updateTransaction: async () => {
            updateCalls++;
        },
    });

    await importer.applyOrPreviewCategoryUpdates({
        actualAccountName: 'Test',
        pendingUpdates: [
            {
                transactionId: 'tx-1',
                importedId: 'imp-1',
                toCategoryId: 'cat-target',
                reason: 'backfill',
                monMonTransaction: makePair().monMonTransaction,
            },
        ],
        isDryRun: true,
    });

    assert.equal(updateCalls, 0);
});

test('buildAccountTransactionBuckets logs duplicates and picks deterministic winner', () => {
    const { importer, logger } = makeImporter();

    const result = importer.buildAccountTransactionBuckets({
        monMonAccount: {
            uuid: 'acc-1',
            name: 'Gehaltskonto',
        },
        accountTransactions: [
            {
                id: '1',
                accountUuid: 'acc-1',
                categoryUuid: 'mm-1',
                name: 'Txn',
                valueDate: new Date('2026-02-18'),
                amount: -1,
            },
        ],
        existingActualTransactions: [
            {
                id: 'tx-b',
                imported_id: 'acc-1-1',
                date: '2026-02-18',
                amount: -1234,
                imported_payee: 'Lidl sagt Danke',
                notes: 'Split groceries',
                category: 'cat-b',
            },
            {
                id: 'tx-a',
                imported_id: 'acc-1-1',
                date: '2026-02-18',
                amount: -1234,
                imported_payee: 'Lidl sagt Danke',
                notes: 'Split groceries',
                category: 'cat-a',
            },
        ],
        actualAccountName: 'Account',
        shouldSyncCategories: true,
    });

    assert.equal(result.existingPairs.length, 1);
    assert.equal(result.existingPairs[0]?.actualTransaction.id, 'tx-b');
    assert.equal(logger.warnings.length, 0);
    assert.equal(logger.infos.length, 0);
    assert.equal(logger.debugs.length, 2);
    assert.match(
        logger.debugs[0]?.message ?? '',
        /Detected 1 likely split duplicate imported_id group\(s\)/
    );
    assert.match(
        logger.debugs[1]?.hints[0] ?? '',
        /Date=2026-02-18, Payee=Lidl sagt Danke, Amount=-12.34, TxCount=2/
    );
    assert.match(
        logger.debugs[1]?.hints[0] ?? '',
        /MoneyMoneyAccount='Gehaltskonto \(acc-1\)'/
    );
});

test('buildAccountTransactionBuckets warns for suspicious duplicate groups', () => {
    const { importer, logger } = makeImporter();

    importer.buildAccountTransactionBuckets({
        monMonAccount: {
            uuid: 'acc-1',
            name: 'Gehaltskonto',
        },
        accountTransactions: [],
        existingActualTransactions: [
            {
                id: 'tx-b',
                imported_id: 'acc-1-1',
                date: '2026-02-18',
                amount: -1234,
                imported_payee: 'Lidl sagt Danke',
                notes: 'Split groceries',
                category: 'cat-b',
            },
            {
                id: 'tx-a',
                imported_id: 'acc-1-1',
                date: '2026-02-17',
                amount: -1234,
                imported_payee: 'Lidl sagt Danke',
                notes: 'Split groceries',
                category: 'cat-a',
            },
        ],
        actualAccountName: 'Account',
        shouldSyncCategories: true,
    });

    assert.equal(logger.infos.length, 0);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0]?.message ?? '', /1 group\(s\) need review/);
    assert.equal(logger.debugs.length, 1);
    assert.match(
        logger.debugs[0]?.hints[0] ?? '',
        /Date=2026-02-18, Payee=Lidl sagt Danke, Amount=-12.34, TxCount=2/
    );
});

test('logCategorySyncSummary pushes no-op to debug array instead of logging', () => {
    const { importer } = makeImporter();
    const debugArray = [];

    importer.logCategorySyncSummary({
        actualAccountName: 'Noop Account',
        existingPairsCount: 4,
        backfillCount: 0,
        conflictCount: 0,
        pendingUpdatesCount: 0,
        skippedConflictCount: 0,
        categorySyncDebug: debugArray,
    });

    assert.equal(debugArray.length, 1);
    assert.match(debugArray[0], /'Noop Account': no-op/);
});

test('logCategorySyncSummary emits info for category activity', () => {
    const { importer, logger } = makeImporter();

    importer.logCategorySyncSummary({
        actualAccountName: 'Active Account',
        existingPairsCount: 10,
        backfillCount: 1,
        conflictCount: 2,
        pendingUpdatesCount: 2,
        skippedConflictCount: 1,
        categorySyncDebug: [],
    });

    assert.equal(logger.infos.length, 1);
    assert.match(
        logger.infos[0]?.message ?? '',
        /Category sync summary for account 'Active Account'/
    );
    assert.equal(logger.debugs.length, 0);
});

test('logCategorySyncSummary omits zero-value fields in info hints', () => {
    const { importer, logger } = makeImporter();

    importer.logCategorySyncSummary({
        actualAccountName: 'Backfill Only',
        existingPairsCount: 47,
        backfillCount: 1,
        conflictCount: 0,
        pendingUpdatesCount: 1,
        skippedConflictCount: 0,
        categorySyncDebug: [],
    });

    assert.equal(logger.infos.length, 1);
    const hints = logger.infos[0]?.hints ?? [];
    assert.ok(hints.length > 0);

    // Zero-value fields should not appear in hints
    const hintsText = hints.join('\n');
    assert.doesNotMatch(hintsText, /[Cc]onflicts?:/);
    assert.doesNotMatch(hintsText, /[Ss]kipped conflicts?:/);
});

test('emitImportRunSummary prints nothing-to-import for fully empty runs', () => {
    const { importer, logger } = makeImporter();

    importer.emitImportRunSummary(
        {
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
        },
        false
    );

    assert.equal(logger.infos.length, 1);
    assert.match(logger.infos[0]?.message ?? '', /nothing.*import/i);
    assert.deepEqual(logger.infos[0]?.hints, []);
});

test('emitImportRunSummary includes dry-run wording and non-zero sections', () => {
    const { importer, logger } = makeImporter();

    importer.emitImportRunSummary(
        {
            accountsScanned: 8,
            accountsWithImportActivity: 2,
            accountsWithCategoryActivity: 1,
            accountsWithConflicts: 1,
            totalTransactionsAdded: 3,
            totalTransactionsUpdated: 1,
            totalCategoryUpdatesPlanned: 4,
            totalCategoryUpdatesApplied: 0,
            totalCategoryUpdatesDryRun: 4,
            totalBackfills: 1,
            totalConflicts: 3,
            totalSkippedConflicts: 2,
            totalUnmappedCategoryWarnings: 5,
        },
        true
    );

    const hints = logger.infos[0]?.hints ?? [];
    assert.match(hints.join('\n'), /Accounts scanned: 8/);
    assert.match(hints.join('\n'), /Transactions: added=3, updated=1/);
    assert.match(
        hints.join('\n'),
        /Category updates: planned=4 \(dry-run, no changes written\)/
    );
    assert.match(
        hints.join('\n'),
        /Category sync activity: backfills=1, conflicts=3, skipped=2/
    );
    assert.match(hints.join('\n'), /Accounts with conflicts: 1/);
    assert.match(hints.join('\n'), /Unmapped category warnings: 5/);
});

test('emitImportRunSummary omits zero counters inside category sync activity line', () => {
    const { importer, logger } = makeImporter();

    importer.emitImportRunSummary(
        {
            accountsScanned: 3,
            accountsWithImportActivity: 0,
            accountsWithCategoryActivity: 1,
            accountsWithConflicts: 0,
            totalTransactionsAdded: 0,
            totalTransactionsUpdated: 0,
            totalCategoryUpdatesPlanned: 1,
            totalCategoryUpdatesApplied: 0,
            totalCategoryUpdatesDryRun: 1,
            totalBackfills: 1,
            totalConflicts: 0,
            totalSkippedConflicts: 0,
            totalUnmappedCategoryWarnings: 0,
        },
        true
    );

    const categorySyncLine =
        (logger.infos[0]?.hints ?? []).find((hint) =>
            hint.startsWith('Category sync activity:')
        ) ?? '';
    assert.equal(categorySyncLine, 'Category sync activity: backfills=1');
});

test('detectAndWarnAutoRuleOverrides warns when stored category differs from intended', async () => {
    const { importer, logger } = makeImporter({
        mappingByUuid: {},
    });

    const overrideCount = await importer.detectAndWarnAutoRuleOverrides({
        actualAccountName: 'Checking',
        addedIds: ['actual-imp-1'],
        importedTransactions: [
            {
                id: 'actual-imp-1',
                imported_id: 'imp-1',
                imported_payee: 'Amazon',
                category: 'cat-auto-rule',
                date: '2026-02-23',
                amount: -500,
            },
        ],
        intendedCategoryByImportedId: new Map([['imp-1', 'cat-intended']]),
    });

    assert.equal(overrideCount, 1);
    assert.equal(logger.warnings.length, 1);
    assert.match(
        logger.warnings[0]?.message ?? '',
        /Auto-rule changed category for transaction 'Amazon' in account 'Checking'/
    );
    assert.match(logger.warnings[0]?.message ?? '', /cat-intended/);
    assert.match(logger.warnings[0]?.message ?? '', /cat-auto-rule/);
});

test('detectAndWarnAutoRuleOverrides is silent when stored category matches intended', async () => {
    const { importer, logger } = makeImporter();

    const overrideCount = await importer.detectAndWarnAutoRuleOverrides({
        actualAccountName: 'Checking',
        addedIds: ['actual-imp-1'],
        importedTransactions: [
            {
                id: 'actual-imp-1',
                imported_id: 'imp-1',
                imported_payee: 'Rewe',
                category: 'cat-intended',
                date: '2026-02-23',
                amount: -200,
            },
        ],
        intendedCategoryByImportedId: new Map([['imp-1', 'cat-intended']]),
    });

    assert.equal(overrideCount, 0);
    assert.equal(logger.warnings.length, 0);
});

test('detectAndWarnAutoRuleOverrides ignores transactions not in the intended-category map', async () => {
    const { importer, logger } = makeImporter();

    // intendedCategoryByImportedId only has 'imp-1', not 'imp-2'
    const overrideCount = await importer.detectAndWarnAutoRuleOverrides({
        actualAccountName: 'Checking',
        addedIds: ['actual-imp-2'],
        importedTransactions: [
            {
                id: 'actual-imp-2',
                imported_id: 'imp-2',
                imported_payee: 'Dm',
                category: 'cat-whatever',
                date: '2026-02-23',
                amount: -100,
            },
        ],
        intendedCategoryByImportedId: new Map([['imp-1', 'cat-intended']]),
    });

    assert.equal(overrideCount, 0);
    assert.equal(logger.warnings.length, 0);
});
