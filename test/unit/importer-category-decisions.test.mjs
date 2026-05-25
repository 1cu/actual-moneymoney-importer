import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    classifyCategoryUpdate,
    parsePromptDecision,
} from '../../dist/utils/Importer.js';

// ---------------------------------------------------------------------------
// classifyCategoryUpdate
// ---------------------------------------------------------------------------

test('classifyCategoryUpdate returns noop when isUncategorized is true', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-old',
        targetCategoryId: 'cat-new',
        isUncategorized: true,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop when targetCategoryId is undefined', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-old',
        targetCategoryId: undefined,
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop when targetCategoryId is null', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-old',
        targetCategoryId: null,
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop when targetCategoryId is empty string', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-old',
        targetCategoryId: '',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns backfill when currentCategoryId is undefined', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: 'cat-new',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, {
        type: 'backfill',
        targetCategoryId: 'cat-new',
    });
});

test('classifyCategoryUpdate returns backfill when currentCategoryId is null', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: null,
        targetCategoryId: 'cat-new',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, {
        type: 'backfill',
        targetCategoryId: 'cat-new',
    });
});

test('classifyCategoryUpdate returns backfill when currentCategoryId is empty string', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: '',
        targetCategoryId: 'cat-new',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, {
        type: 'backfill',
        targetCategoryId: 'cat-new',
    });
});

test('classifyCategoryUpdate returns noop when currentCategoryId equals targetCategoryId', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-same',
        targetCategoryId: 'cat-same',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns conflict when categories differ', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'cat-old',
        targetCategoryId: 'cat-new',
        isUncategorized: false,
    });
    assert.deepStrictEqual(result, {
        type: 'conflict',
        targetCategoryId: 'cat-new',
        currentCategoryId: 'cat-old',
    });
});

test('classifyCategoryUpdate returns noop when isUncategorized and targetCategoryId is missing (noop precedence)', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: undefined,
        isUncategorized: true,
    });
    assert.deepStrictEqual(result, { type: 'noop' });
});

// ---------------------------------------------------------------------------
// parsePromptDecision
// ---------------------------------------------------------------------------

test('parsePromptDecision returns all for exact uppercase A', () => {
    assert.strictEqual(parsePromptDecision('A'), 'all');
});

test('parsePromptDecision returns none for exact uppercase N', () => {
    assert.strictEqual(parsePromptDecision('N'), 'none');
});

test('parsePromptDecision returns true for y', () => {
    assert.strictEqual(parsePromptDecision('y'), true);
});

test('parsePromptDecision returns true for yes', () => {
    assert.strictEqual(parsePromptDecision('yes'), true);
});

test('parsePromptDecision returns true for uppercase Y', () => {
    assert.strictEqual(parsePromptDecision('Y'), true);
});

test('parsePromptDecision returns true for uppercase YES', () => {
    assert.strictEqual(parsePromptDecision('YES'), true);
});

test('parsePromptDecision returns false for lowercase n', () => {
    assert.strictEqual(parsePromptDecision('n'), false);
});

test('parsePromptDecision returns false for lowercase no', () => {
    assert.strictEqual(parsePromptDecision('no'), false);
});

test('parsePromptDecision returns none for uppercase N (not false)', () => {
    // The N check runs before the n/no check, so uppercase N returns 'none'
    assert.strictEqual(parsePromptDecision('N'), 'none');
});

test('parsePromptDecision returns all for all (case-insensitive)', () => {
    assert.strictEqual(parsePromptDecision('all'), 'all');
    assert.strictEqual(parsePromptDecision('ALL'), 'all');
    assert.strictEqual(parsePromptDecision('All'), 'all');
});

test('parsePromptDecision returns none for none (case-insensitive)', () => {
    assert.strictEqual(parsePromptDecision('none'), 'none');
    assert.strictEqual(parsePromptDecision('NONE'), 'none');
    assert.strictEqual(parsePromptDecision('None'), 'none');
});

test('parsePromptDecision returns quit for q (case-insensitive)', () => {
    assert.strictEqual(parsePromptDecision('q'), 'quit');
    assert.strictEqual(parsePromptDecision('Q'), 'quit');
});

test('parsePromptDecision returns quit for quit (case-insensitive)', () => {
    assert.strictEqual(parsePromptDecision('quit'), 'quit');
    assert.strictEqual(parsePromptDecision('QUIT'), 'quit');
    assert.strictEqual(parsePromptDecision('Quit'), 'quit');
});

test('parsePromptDecision returns invalid for unrecognized input', () => {
    assert.strictEqual(parsePromptDecision('x'), 'invalid');
    assert.strictEqual(parsePromptDecision('maybe'), 'invalid');
    assert.strictEqual(parsePromptDecision('1'), 'invalid');
    assert.strictEqual(parsePromptDecision('yes please'), 'invalid');
});

test('parsePromptDecision returns invalid for empty string', () => {
    assert.strictEqual(parsePromptDecision(''), 'invalid');
});

test('parsePromptDecision handles whitespace trimming', () => {
    assert.strictEqual(parsePromptDecision('  y  '), true);
    assert.strictEqual(parsePromptDecision('  Y  '), true);
    assert.strictEqual(parsePromptDecision('  yes  '), true);
    assert.strictEqual(parsePromptDecision('  n  '), false);
    assert.strictEqual(parsePromptDecision('  no  '), false);
    assert.strictEqual(parsePromptDecision('  A  '), 'all');
    assert.strictEqual(parsePromptDecision('  N  '), 'none');
    assert.strictEqual(parsePromptDecision('  all  '), 'all');
    assert.strictEqual(parsePromptDecision('  none  '), 'none');
    assert.strictEqual(parsePromptDecision('  q  '), 'quit');
    assert.strictEqual(parsePromptDecision('  quit  '), 'quit');
});

test("parsePromptDecision returns invalid for lowercase 'a' (not all)", () => {
    // 'A' check is case-sensitive exact match; lowercase 'a' doesn't match 'all' either
    assert.strictEqual(parsePromptDecision('a'), 'invalid');
});

test("parsePromptDecision returns invalid for lowercase 'n' with extra chars", () => {
    // 'N' check only matches exactly 'N', not 'nope'
    assert.strictEqual(parsePromptDecision('nope'), 'invalid');
});

test('parsePromptDecision returns invalid for single space', () => {
    assert.strictEqual(parsePromptDecision(' '), 'invalid');
});
