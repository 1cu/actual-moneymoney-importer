import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyCategoryUpdate,
    parsePromptDecision,
} from '../../dist/utils/Importer.js';

test('classifyCategoryUpdate returns backfill for empty current category', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: 'target-1',
        isUncategorized: false,
    });

    assert.equal(result, 'backfill');
});

test('classifyCategoryUpdate returns conflict for differing categories', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'current-1',
        targetCategoryId: 'target-1',
        isUncategorized: false,
    });

    assert.equal(result, 'conflict');
});

test('classifyCategoryUpdate returns noop for equal categories', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'same-1',
        targetCategoryId: 'same-1',
        isUncategorized: false,
    });

    assert.equal(result, 'noop');
});

test('classifyCategoryUpdate returns noop for uncategorized source', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: 'target-1',
        isUncategorized: true,
    });

    assert.equal(result, 'noop');
});

test('classifyCategoryUpdate returns noop for unmapped target', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'current-1',
        targetCategoryId: undefined,
        isUncategorized: false,
    });

    assert.equal(result, 'noop');
});

test('parsePromptDecision preserves A/N shortcuts before n/no', () => {
    assert.equal(parsePromptDecision('A'), 'all');
    assert.equal(parsePromptDecision('N'), 'none');
    assert.equal(parsePromptDecision('n'), false);
    assert.equal(parsePromptDecision('no'), false);
});

test('parsePromptDecision handles yes/no/all/none words and invalid', () => {
    assert.equal(parsePromptDecision('yes'), true);
    assert.equal(parsePromptDecision('y'), true);
    assert.equal(parsePromptDecision('  A  '), 'all');
    assert.equal(parsePromptDecision('  N  '), 'none');
    assert.equal(parsePromptDecision('  y  '), true);
    assert.equal(parsePromptDecision('all'), 'all');
    assert.equal(parsePromptDecision('none'), 'none');
    assert.equal(parsePromptDecision('  ???  '), 'invalid');
});
