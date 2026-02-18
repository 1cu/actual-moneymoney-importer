import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getBudgetBlocks,
    renderAnnotatedCategoryMappingLines,
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

const makeEntry = (overrides = {}) => ({
    sourceUuid: 'mm-1',
    targetId: 'actual-1',
    sourcePath: 'Ausgaben > Lebensmittel',
    targetPath: 'Lebenshaltung > 💳🧀 Lebensmittel',
    origin: 'configured',
    ...overrides,
});

test('getBudgetBlocks supports trailing comments on budget header', () => {
    const content = `
[[actualServers.budgets]]   # main budget
syncId = "budget-a"
`;

    const blocks = getBudgetBlocks(content);
    assert.equal(blocks.length, 1);
});

test('replaceCategoryMappingInConfig inserts missing mapping block', () => {
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'budget-b', [
        {
            sourceUuid: 'mm-1',
            targetId: 'actual-1',
            sourcePath: 'A > B',
            targetPath: 'C > D',
            origin: 'configured',
        },
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.match(result.content, /# MoneyMoney: A > B/);
    assert.match(result.content, /# Actual: C > D/);
    assert.match(result.content, /\[actualServers\.budgets\.categoryMapping\]/);
    assert.match(result.content, /"mm-1" = "actual-1"/);
});

test('replaceCategoryMappingInConfig replaces existing mapping block', () => {
    const withExisting = `${BASE_CONFIG}
[actualServers.budgets.categoryMapping]
"old-mm" = "old-actual"
`;

    const result = replaceCategoryMappingInConfig(withExisting, 'budget-b', [
        makeEntry({
            sourceUuid: 'new-mm',
            targetId: 'new-actual',
            sourcePath: 'X > Y',
            targetPath: 'Z > Q',
        }),
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.doesNotMatch(result.content, /"old-mm" = "old-actual"/);
    assert.match(result.content, /"new-mm" = "new-actual"/);
});

test('replaceCategoryMappingInConfig replaces section cleanly before next header', () => {
    const withFollowingSection = `
[[actualServers.budgets]]
syncId = "budget-a"

[actualServers.budgets.categoryMapping]
"old-mm" = "old-actual"

[actualServers.budgets.accountMapping]
"A" = "B"
`;

    const result = replaceCategoryMappingInConfig(withFollowingSection, 'budget-a', [
        makeEntry({
            sourceUuid: 'new-mm',
            targetId: 'new-actual',
            sourcePath: 'X > Y',
            targetPath: 'Z > Q',
        }),
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.match(
        result.content,
        /\[actualServers\.budgets\.categoryMapping\]\n# MoneyMoney: X > Y[\s\S]*"new-mm" = "new-actual"\n\n\[actualServers\.budgets\.accountMapping\]/
    );
});

test('replaceCategoryMappingInConfig updates only target budget in multi-budget config', () => {
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'budget-a', [
        makeEntry({
            sourceUuid: 'mm-a',
            targetId: 'actual-a',
            sourcePath: 'M > A',
            targetPath: 'T > A',
        }),
    ]);

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
    const result = replaceCategoryMappingInConfig(BASE_CONFIG, 'does-not-exist', [
        makeEntry({
            sourceUuid: 'mm-a',
            targetId: 'actual-a',
            sourcePath: 'M > A',
            targetPath: 'T > A',
        }),
    ]);

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

    const result = replaceCategoryMappingInConfig(ambiguous, 'dupe', [
        makeEntry({
            sourceUuid: 'mm-a',
            targetId: 'actual-a',
            sourcePath: 'M > A',
            targetPath: 'T > A',
        }),
    ]);

    assert.equal(result.ok, false);
});

test('replaceCategoryMappingInConfig fails safely when patched TOML is invalid', () => {
    const malformed = `${BASE_CONFIG}\ninvalid = \"unterminated`;
    const result = replaceCategoryMappingInConfig(malformed, 'budget-b', [
        makeEntry({
            sourceUuid: 'mm-a',
            targetId: 'actual-a',
            sourcePath: 'M > A',
            targetPath: 'T > A',
        }),
    ]);

    assert.equal(result.ok, false);
    if (result.ok) {
        return;
    }

    assert.match(result.reason, /TOML parse failed after patch/);
});

test('replaceCategoryMappingInConfig replaces mapping section at EOF without trailing newline', () => {
    const content =
        '[[actualServers.budgets]]\n' +
        'syncId = "budget-a"\n\n' +
        '[actualServers.budgets.categoryMapping]\n' +
        '"old-mm" = "old-actual"';

    const result = replaceCategoryMappingInConfig(content, 'budget-a', [
        makeEntry({
            sourceUuid: 'new-mm',
            targetId: 'new-actual',
            sourcePath: 'X > Y',
            targetPath: 'Z > Q',
        }),
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) {
        return;
    }

    assert.match(result.content, /"new-mm" = "new-actual"/);
    assert.doesNotMatch(result.content, /"old-mm" = "old-actual"/);
});

test('renderAnnotatedCategoryMappingLines includes unresolved fallback comments', () => {
    const lines = renderAnnotatedCategoryMappingLines([
        makeEntry({
            sourcePath: '',
            targetPath: '',
            sourceUuid: 'mm-u',
            targetId: 'actual-u',
            origin: 'suggested',
            reason: 'path-exact',
        }),
    ]);

    assert.match(lines.join('\n'), /\[UNRESOLVED\] mm-u/);
    assert.match(lines.join('\n'), /\[UNRESOLVED\] actual-u/);
    assert.doesNotMatch(lines.join('\n'), /# Match:/);
    assert.doesNotMatch(lines.join('\n'), /# Origin:/);
});

test('renderAnnotatedCategoryMappingLines shows explicit empty mapping section', () => {
    const lines = renderAnnotatedCategoryMappingLines([]);
    assert.deepEqual(lines, [
        '[actualServers.budgets.categoryMapping]',
        '# No mappings generated.',
    ]);
});
