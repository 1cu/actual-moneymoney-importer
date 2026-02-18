import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getBudgetBlocks,
    replaceCategoryMappingInConfig,
} from '../../dist/utils/categoryMappingConfigPatch.js';

const BASE_CONFIG = `
[[actualServers]]
serverUrl = "http://localhost:5006"
serverPassword = "pw"

[[actualServers.budgets]]
syncId = "budget-a"

[actualServers.budgets.accountMapping]
"A" = "B"

[[actualServers.budgets]]
syncId = "budget-b"
`;

test('getBudgetBlocks supports trailing comments on budget header', () => {
    const content = `
[[actualServers.budgets]]   # main budget
syncId = "budget-a"
`;

    const blocks = getBudgetBlocks(content);
    assert.equal(blocks.length, 1);
});

test('replaceCategoryMappingInConfig inserts missing mapping block', () => {
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'budget-b', {
        'mm-1': 'actual-1',
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.match(result.content, /\[actualServers\.budgets\.categoryMapping\]/);
    assert.match(result.content, /"mm-1" = "actual-1"/);
});

test('replaceCategoryMappingInConfig replaces existing mapping block', () => {
    const withExisting = `${BASE_CONFIG}
[actualServers.budgets.categoryMapping]
"old-mm" = "old-actual"
`;

    const result = replaceCategoryMappingInConfig(withExisting, 'budget-b', {
        'new-mm': 'new-actual',
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.doesNotMatch(result.content, /"old-mm" = "old-actual"/);
    assert.match(result.content, /"new-mm" = "new-actual"/);
});

test('replaceCategoryMappingInConfig updates only target budget in multi-budget config', () => {
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'budget-a', {
        'mm-a': 'actual-a',
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    const indexBudgetA = result.content.indexOf('syncId = "budget-a"');
    const indexBudgetB = result.content.indexOf('syncId = "budget-b"');
    const indexMapping = result.content.indexOf(
        '[actualServers.budgets.categoryMapping]'
    );

    assert.ok(indexBudgetA >= 0);
    assert.ok(indexBudgetB > indexBudgetA);
    assert.ok(indexMapping > indexBudgetA);
    assert.ok(indexMapping < indexBudgetB);
});

test('replaceCategoryMappingInConfig fails safely for missing syncId', () => {
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'does-not-exist', {
        'mm-a': 'actual-a',
    });

    assert.equal(result.ok, false);
    if (result.ok) {
        return;
    }

    assert.match(result.reason, /Expected exactly one budget block/);
});

test('replaceCategoryMappingInConfig fails safely for ambiguous syncId', () => {
    const ambiguous = `
[[actualServers.budgets]]
syncId = "dupe"

[[actualServers.budgets]]
syncId = "dupe"
`;

    const result = replaceCategoryMappingInConfig(ambiguous, 'dupe', {
        'mm-a': 'actual-a',
    });

    assert.equal(result.ok, false);
});

test('replaceCategoryMappingInConfig fails safely when patched TOML is invalid', () => {
    const malformed = `${BASE_CONFIG}\ninvalid = \"unterminated`;
    const result = replaceCategoryMappingInConfig(malformed, 'budget-b', {
        'mm-a': 'actual-a',
    });

    assert.equal(result.ok, false);
    if (result.ok) {
        return;
    }

    assert.match(result.reason, /TOML parse failed after patch/);
});
