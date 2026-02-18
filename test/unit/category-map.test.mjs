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

    const map = new CategoryMap(budgetConfig, makeActualApiStub(), makeLogger());

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

    const map = new CategoryMap(budgetConfig, makeActualApiStub(), makeLogger());

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
    assert.deepEqual(report.unmappedCategories, [
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

    const map = new CategoryMap(budgetConfig, makeActualApiStub(), makeLogger());

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
    assert.equal(report.suggestions.length, 1);
    assert.equal(report.suggestions[0]?.sourceUuid, 'mm-tank');
    assert.equal(report.suggestions[0]?.targetId, 'actual-tank');
});

test('ambiguous name matches do not produce suggestions', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(budgetConfig, makeActualApiStub(), makeLogger());

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
    assert.equal(report.suggestions.length, 0);
});

test('getCanonicalMapping excludes suggestions when includeSuggestions is false', () => {
    const budgetConfig = {
        syncId: 'sync-id',
        earliestImportDate: undefined,
        e2eEncryption: { enabled: false, password: undefined },
        accountMapping: {},
        categoryMapping: {},
    };

    const map = new CategoryMap(budgetConfig, makeActualApiStub(), makeLogger());

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
