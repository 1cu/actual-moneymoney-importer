import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProposal } from '../../scripts/cutover-candidates.mjs';

const payees = [
    { id: 'lidl', name: 'Lidl' },
    { id: 'rewe', name: 'Rewe' },
];
const categories = [
    { id: 'groceries', name: 'Groceries' },
    { id: 'other', name: 'Other' },
];
const tx = (id, overrides = {}) => ({
    id: String(id),
    date: '2026-10-01',
    payee: 'lidl',
    imported_payee: 'Lidl sagt Danke',
    category: 'groceries',
    account: 'checking',
    amount: -100,
    imported_id: `mm-${id}`,
    ...overrides,
});
const proposal = (transactions, overrides = {}) =>
    buildProposal({
        transactions,
        payees,
        categories,
        rules: [],
        moneyMoneyCategories: [],
        categoryMappings: {},
        asOf: '2026-11-01',
        ...overrides,
    });

test('unique historical alias and unanimous recent category yield two guarded candidates', () => {
    const result = proposal([
        tx(1),
        tx(2, { imported_payee: 'lidl sagt danke' }),
        tx(3),
    ]);
    assert.equal(result.create.length, 2);
    assert.deepEqual(result.create[0], {
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
            {
                field: 'imported_payee',
                op: 'oneOf',
                value: ['Lidl sagt Danke', 'lidl sagt danke'],
            },
        ],
        actions: [{ field: 'payee', op: 'set', value: 'lidl' }],
    });
    assert.deepEqual(result.create[1].conditions, [
        { field: 'payee', op: 'is', value: 'lidl' },
        { field: 'category', op: 'is', value: null },
    ]);
    assert.equal(result.audit.aliases[0].count, 3);
    assert.equal(result.audit.categoryFallbacks[0].count, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('case-folded alias collision suppresses payee rule and mixed categories suppress fallback', () => {
    const result = proposal([
        tx(1),
        tx(2, {
            imported_payee: 'LIDL SAGT DANKE',
            payee: 'rewe',
            category: 'other',
        }),
        tx(3),
    ]);
    assert.deepEqual(result.create, []);
    assert.equal(
        result.audit.skipped.find(item => item.kind === 'alias').reason,
        'ambiguous-payee'
    );
});

test('raw names with an unresolved historical payee cannot become aliases', () => {
    const result = proposal([tx(1), tx(2, { payee: null })]);
    assert.deepEqual(result.create, []);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('transfers, splits, and starting balances do not teach candidates', () => {
    const result = proposal([
        tx(1, { transfer_id: 't' }),
        tx(2, { is_parent: true }),
        tx(3, { is_child: true }),
        tx(4, { imported_payee: 'Starting balance' }),
        tx(5, { starting_balance_flag: true }),
        tx(6, { imported_id: 'mm-6-start' }),
    ]);
    assert.deepEqual(result.create, []);
});

test('category rules suppress fallback while schedule rules leave it available', () => {
    const transactions = [tx(1), tx(2), tx(3)];
    const existingCategory = {
        id: 'category-rule',
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'lidl' }],
        actions: [{ field: 'category', op: 'set', value: 'other' }],
    };
    const existingSchedule = {
        id: 'schedule-rule',
        stage: 'post',
        conditionsOp: 'and',
        conditions: [{ field: 'payee', op: 'is', value: 'lidl' }],
        actions: [{ op: 'link-schedule', value: 'schedule-id' }],
    };
    assert.equal(
        proposal(transactions, { rules: [existingCategory] }).create.filter(
            candidate => candidate.stage === 'post'
        ).length,
        0
    );
    assert.equal(
        proposal(transactions, { rules: [existingSchedule] }).create.filter(
            candidate => candidate.stage === 'post'
        ).length,
        1
    );
});

test('schedule linked history contributes aliases and category evidence without changing schedules', () => {
    const result = proposal([
        tx(1, { schedule: 'schedule-id', imported_payee: 'Insurance Ltd' }),
        tx(2, { schedule: 'schedule-id', imported_payee: 'Insurance Ltd' }),
        tx(3, { schedule: 'schedule-id', imported_payee: 'Insurance Ltd' }),
    ]);
    assert.equal(result.create.length, 2);
    assert.equal(result.audit.aliases[0].count, 3);
    assert.equal(result.audit.categoryFallbacks[0].count, 3);
    assert.equal(
        result.create.some(rule =>
            rule.actions.some(action => action.op === 'link-schedule')
        ),
        false
    );
});

test('only the observed Lidl identity rule is a deletion suggestion', () => {
    const identity = {
        id: 'lidl-identity',
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
            { field: 'imported_payee', op: 'is', value: 'Lidl sagt Danke' },
        ],
        actions: [{ field: 'payee', op: 'set', value: 'lidl' }],
    };
    const generic = {
        ...identity,
        id: 'generic-identity',
        conditions: [{ field: 'imported_payee', op: 'is', value: 'Rewe' }],
    };
    const result = proposal([tx(1), tx(2), tx(3)], {
        rules: [identity, generic],
    });
    assert.deepEqual(result.delete, ['lidl-identity']);
    assert.equal(
        result.create.filter(candidate => candidate.stage === 'pre').length,
        0
    );
});

test('MoneyMoney text stays audit-only with mapped target and conflict evidence', () => {
    const result = proposal([tx(1, { category: 'other' })], {
        moneyMoneyCategories: [
            { uuid: 'mm-food', rules: 'payee = Lidl sagt Danke\namount > 100' },
        ],
        categoryMappings: { 'mm-food': 'groceries' },
    });
    assert.equal(result.audit.moneyMoneyRules.length, 2);
    assert.deepEqual(result.audit.moneyMoneyRules[0], {
        sourceCategory: 'mm-food',
        text: 'payee = Lidl sagt Danke',
        targetCategory: 'groceries',
        status: 'manual-review',
        fields: ['payee'],
        operators: ['='],
        unsupportedFields: [],
        literalMerchant: 'Lidl sagt Danke',
        recentMatches: 1,
        observedPayees: ['lidl'],
        conflict: true,
    });
    assert.deepEqual(result.audit.moneyMoneyRules[1].unsupportedFields, [
        'amount',
    ]);
    assert.deepEqual(
        result.create.filter(
            candidate =>
                candidate.actions[0].value === 'groceries' &&
                candidate.stage === 'post'
        ),
        []
    );
});
