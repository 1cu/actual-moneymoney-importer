import assert from 'node:assert/strict';
import test from 'node:test';
import CategoryMap from '../../dist/utils/CategoryMap.js';

const makeLogger = () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
});

const makeActualApiStub = () => ({
    getCategories: async () => [],
    getCategoryGroups: async () => [],
});

const makeMonMonCategory = ({
    uuid,
    name,
    defaultValue = false,
    group = false,
    indentation = 0,
}) => ({
    uuid,
    name,
    default: defaultValue,
    group,
    indentation,
    currency: 'EUR',
    icon: Buffer.from([]),
    rules: '',
    budget: {},
});

test('loadFromData resolves canonical mapping by UUID', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {
            'mm-food': 'actual-food',
        },
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-food', name: 'Food' })],
        [
            {
                id: 'actual-food',
                name: 'Food',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const resolved = map.getMappedActualCategoryId('mm-food');
    assert.equal(resolved.actualCategoryId, 'actual-food');
    assert.equal(resolved.isMapped, true);
});

test('uncategorized default category is excluded from unmapped requirements', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [
            makeMonMonCategory({
                uuid: 'mm-uncat',
                name: 'Unkategorisiert',
                defaultValue: true,
            }),
            makeMonMonCategory({ uuid: 'mm-food', name: 'Food' }),
        ],
        [],
        []
    );

    const report = map.getReport();
    assert.deepEqual(report.unresolvedMoneyMoneyCategories, [
        { uuid: 'mm-food', path: 'Food' },
    ]);
});

test('emoji-prefixed Actual category name is normalized for suggestions', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-tank', name: 'Tanken' })],
        [
            {
                id: 'actual-tank',
                name: '💳⛽️ Tanken',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const report = map.getReport();
    assert.equal(report.safeSuggestions.length, 1);
    assert.equal(report.safeSuggestions[0]?.sourceUuid, 'mm-tank');
    assert.equal(report.safeSuggestions[0]?.targetId, 'actual-tank');
});

test('ambiguous name matches do not produce suggestions', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-food', name: 'Food' })],
        [
            {
                id: 'actual-food-a',
                name: '🍔 Food',
                group_id: 'group-expenses-a',
                is_income: false,
            },
            {
                id: 'actual-food-b',
                name: 'Food',
                group_id: 'group-expenses-b',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses-a',
                name: 'Expenses A',
                is_income: false,
            },
            {
                id: 'group-expenses-b',
                name: 'Expenses B',
                is_income: false,
            },
        ]
    );

    const report = map.getReport();
    assert.equal(report.safeSuggestions.length, 0);
});

test('resolveMoneyMoneyCategoryRefs accepts UUID, path, and leaf name refs', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [
            makeMonMonCategory({
                uuid: 'mm-root',
                name: 'Umbuchungen',
                group: true,
            }),
            makeMonMonCategory({
                uuid: 'mm-transfer',
                name: 'Echte Umbuchungen',
                indentation: 1,
            }),
        ],
        [],
        []
    );

    const resolved = map.resolveMoneyMoneyCategoryRefs([
        'mm-transfer',
        'Umbuchungen > Echte Umbuchungen',
        'Echte Umbuchungen',
    ]);

    assert.deepEqual([...resolved.resolvedUuids], ['mm-transfer']);
    assert.deepEqual(resolved.invalidRefs, []);
});

test('resolveMoneyMoneyCategoryRefs rejects refs that resolve to a category group', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [
            makeMonMonCategory({
                uuid: 'mm-root',
                name: 'Umbuchungen',
                group: true,
            }),
            makeMonMonCategory({
                uuid: 'mm-transfer',
                name: 'Echte Umbuchungen',
                indentation: 1,
            }),
        ],
        [],
        []
    );

    const resolved = map.resolveMoneyMoneyCategoryRefs(['Umbuchungen']);

    assert.deepEqual([...resolved.resolvedUuids], []);
    assert.equal(resolved.invalidRefs.length, 1);
    assert.match(
        resolved.invalidRefs[0]?.reason ?? '',
        /resolved to a category group/
    );
});

test('resolveMoneyMoneyCategoryRefs reports ambiguous leaf name refs', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [
            makeMonMonCategory({
                uuid: 'mm-root-a',
                name: 'A',
                group: true,
            }),
            makeMonMonCategory({
                uuid: 'mm-root-b',
                name: 'B',
                group: true,
            }),
            makeMonMonCategory({
                uuid: 'mm-transfer-a',
                name: 'Transfer',
                indentation: 1,
            }),
            makeMonMonCategory({
                uuid: 'mm-transfer-b',
                name: 'Transfer',
                indentation: 1,
            }),
        ],
        [],
        []
    );

    const resolved = map.resolveMoneyMoneyCategoryRefs(['Transfer']);

    assert.deepEqual([...resolved.resolvedUuids], []);
    assert.equal(resolved.invalidRefs.length, 1);
    assert.match(
        resolved.invalidRefs[0]?.reason ?? '',
        /Ambiguous MoneyMoney category ref 'Transfer'/
    );
});

test('getCanonicalMapping excludes suggestions when includeSuggestions is false', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-food', name: 'Food' })],
        [
            {
                id: 'actual-food',
                name: 'Food',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const withoutSuggestions = map.getCanonicalMapping({
        includeSuggestions: false,
    });
    const withSuggestions = map.getCanonicalMapping({
        includeSuggestions: true,
    });

    assert.deepEqual(withoutSuggestions, {});
    assert.deepEqual(withSuggestions, { 'mm-food': 'actual-food' });
});

test('getCanonicalMappingEntries exposes origin and optional reason', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {
            'mm-configured': 'actual-configured',
        },
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );

    map.loadFromData(
        [
            makeMonMonCategory({ uuid: 'mm-configured', name: 'Configured' }),
            makeMonMonCategory({ uuid: 'mm-suggested', name: 'Suggested' }),
        ],
        [
            {
                id: 'actual-configured',
                name: 'Configured',
                group_id: 'group-expenses',
                is_income: false,
            },
            {
                id: 'actual-suggested',
                name: 'Suggested',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const entries = map.getCanonicalMappingEntries({
        includeSuggestions: true,
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.origin, 'configured');
    assert.equal(entries[1]?.origin, 'suggested');
    assert.equal(entries[1]?.reason, 'exact-normalized');
});

test('getCanonicalMappingEntries sorts by sourcePath then sourceUuid', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {
            'mm-b': 'actual-b',
            'mm-a': 'actual-a',
        },
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );
    map.loadFromData(
        [
            makeMonMonCategory({ uuid: 'mm-a', name: 'Same' }),
            makeMonMonCategory({ uuid: 'mm-b', name: 'Same' }),
        ],
        [
            {
                id: 'actual-a',
                name: 'Same A',
                group_id: 'group-expenses',
                is_income: false,
            },
            {
                id: 'actual-b',
                name: 'Same B',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const entries = map.getCanonicalMappingEntries({
        includeSuggestions: false,
    });
    assert.deepEqual(
        entries.map((entry) => entry.sourceUuid),
        ['mm-a', 'mm-b']
    );
});

test('report exposes planning fields and omits legacy report keys', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );
    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-food', name: 'Food' })],
        [
            {
                id: 'actual-food',
                name: 'Food',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const report = map.getReport();
    assert.ok(Array.isArray(report.configuredMappings));
    assert.ok(Array.isArray(report.invalidMappings));
    assert.ok(Array.isArray(report.safeSuggestions));
    assert.ok(Array.isArray(report.unresolvedMoneyMoneyCategories));
    assert.ok(Array.isArray(report.unusedActualCategories));
    assert.ok(Array.isArray(report.planningWarnings));
    assert.equal('validMappings' in report, false);
    assert.equal('suggestions' in report, false);
    assert.equal('unmappedCategories' in report, false);
});

test('unusedActualCategories excludes configured and suggested target categories', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {
            'mm-food': 'actual-food',
        },
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );
    map.loadFromData(
        [
            makeMonMonCategory({ uuid: 'mm-food', name: 'Food' }),
            makeMonMonCategory({ uuid: 'mm-tank', name: 'Tanken' }),
        ],
        [
            {
                id: 'actual-food',
                name: 'Food',
                group_id: 'group-expenses',
                is_income: false,
            },
            {
                id: 'actual-tank',
                name: '💳⛽️ Tanken',
                group_id: 'group-expenses',
                is_income: false,
            },
            {
                id: 'actual-unused',
                name: 'Unused',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const report = map.getReport();
    assert.deepEqual(report.unusedActualCategories, [
        { id: 'actual-unused', path: 'Expenses > Unused' },
    ]);
});

test('planningWarnings include exact messages when unresolved or unused categories exist', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(
        budgetConfig,
        makeActualApiStub(),
        makeLogger()
    );
    map.loadFromData(
        [makeMonMonCategory({ uuid: 'mm-food', name: 'Food' })],
        [
            {
                id: 'actual-extra',
                name: 'Extra',
                group_id: 'group-expenses',
                is_income: false,
            },
        ],
        [
            {
                id: 'group-expenses',
                name: 'Expenses',
                is_income: false,
            },
        ]
    );

    const report = map.getReport();
    assert.deepEqual(report.planningWarnings, [
        'Unresolved MoneyMoney categories: 1',
        'Unused Actual categories: 1',
        'Planning is incomplete (this can be intentional).',
    ]);
});
