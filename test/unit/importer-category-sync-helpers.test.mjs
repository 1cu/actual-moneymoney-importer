import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyCategoryUpdate,
    parsePromptDecision,
    shouldLogCategoryMappingGuidance,
} from '../../dist/utils/Importer.js';

test('classifyCategoryUpdate returns backfill for empty current category', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: 'target-1',
        isUncategorized: false,
    });

    assert.deepEqual(result, {
        type: 'backfill',
        targetCategoryId: 'target-1',
    });
});

test('classifyCategoryUpdate returns conflict for differing categories', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'current-1',
        targetCategoryId: 'target-1',
        isUncategorized: false,
    });

    assert.deepEqual(result, {
        type: 'conflict',
        targetCategoryId: 'target-1',
        currentCategoryId: 'current-1',
    });
});

test('classifyCategoryUpdate returns noop for equal categories', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'same-1',
        targetCategoryId: 'same-1',
        isUncategorized: false,
    });

    assert.deepEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop for uncategorized source', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: 'target-1',
        isUncategorized: true,
    });

    assert.deepEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop for unmapped target', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: 'current-1',
        targetCategoryId: undefined,
        isUncategorized: false,
    });

    assert.deepEqual(result, { type: 'noop' });
});

test('classifyCategoryUpdate returns noop when both categories are undefined', () => {
    const result = classifyCategoryUpdate({
        currentCategoryId: undefined,
        targetCategoryId: undefined,
        isUncategorized: false,
    });

    assert.deepEqual(result, { type: 'noop' });
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
    assert.equal(parsePromptDecision('q'), 'quit');
    assert.equal(parsePromptDecision('quit'), 'quit');
    assert.equal(parsePromptDecision('  ???  '), 'invalid');
});

test('shouldLogCategoryMappingGuidance logs only once per run state', () => {
    assert.equal(shouldLogCategoryMappingGuidance(false), true);
    assert.equal(shouldLogCategoryMappingGuidance(true), false);
});
