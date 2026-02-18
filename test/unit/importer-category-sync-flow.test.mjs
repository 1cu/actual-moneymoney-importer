import assert from 'node:assert/strict';
import test from 'node:test';
import Importer from '../../dist/utils/Importer.js';

const makeLogger = () => {
    const infos = [];
    const warnings = [];
    const toHintArray = (hint) => {
        if (!hint) {
            return [];
        }
        return Array.isArray(hint) ? hint : [hint];
    };
    return {
        infos,
        warnings,
        debug: () => {},
        info: (message, hint) =>
            infos.push({ message, hints: toHintArray(hint) }),
        warn: (message, hint) =>
            warnings.push({ message, hints: toHintArray(hint) }),
        error: () => {},
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

    const { importer: importerAlways } = makeImporter({ mappingByUuid });
    const planAlways = await importerAlways.planExistingCategoryUpdates({
        existingPairs: [makePair({ currentCategoryId: 'cat-current' })],
        existingCategoryPolicy: 'always',
        promptState: { mode: 'prompt' },
    });
    assert.equal(planAlways.pendingUpdates.length, 1);
    assert.equal(planAlways.pendingUpdates[0]?.reason, 'conflict');
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
    assert.equal(logger.infos.length, 1);
    assert.match(
        logger.infos[0]?.message ?? '',
        /appears to be split history \(informational\)/
    );
    assert.match(
        logger.infos[0]?.hints[0] ?? '',
        /Date=2026-02-18, Payee=Lidl sagt Danke, Amount=-12.34, TxCount=2/
    );
});

test('buildAccountTransactionBuckets warns for suspicious duplicate groups', () => {
    const { importer, logger } = makeImporter();

    importer.buildAccountTransactionBuckets({
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
    assert.match(
        logger.warnings[0]?.message ?? '',
        /1 group\(s\) need review/
    );
    assert.match(
        logger.warnings[0]?.hints[0] ?? '',
        /Date=2026-02-18, Payee=Lidl sagt Danke, Amount=-12.34, TxCount=2/
    );
});
