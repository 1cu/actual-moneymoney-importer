import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildConflictPromptText,
    classifyCategoryUpdate,
    parsePromptDecision,
    shouldEmitMappingConflictGuidance,
} from '../../dist/utils/Importer.js';

const stripAnsi = (value) =>
    value.replace(new RegExp('\\u001B\\[[0-?]*[ -/]*[@-~]', 'gu'), ''); // eslint-disable-line no-control-regex

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

test('buildConflictPromptText groups transaction details, choices, and prompt label', () => {
    const prompt = stripAnsi(
        buildConflictPromptText({
            transactionName: 'Apple.com Bill, Cork IE',
            valueDate: new Date('2026-02-19'),
            amount: -5.99,
            currentCategory: 'Kommunikation & Medien > App Store Abos',
            targetCategory: 'Kommunikation & Medien > Apple Services',
        })
    );

    assert.match(prompt, /^Category conflict/m);
    assert.match(prompt, /Transaction:\s+Apple\.com Bill, Cork IE/);
    assert.match(prompt, /Date:\s+2026-02-19/);
    assert.match(prompt, /Amount:\s+-5\.99/);
    assert.match(
        prompt,
        /Keep current:\s+Kommunikation & Medien > App Store Abos/
    );
    assert.match(
        prompt,
        /Change to:\s+Kommunikation & Medien > Apple Services/
    );
    assert.match(
        prompt,
        /Choose:\s+\[y\] update\s+\[n\] keep\s+\[A\] update all\s+\[N\] keep all\s+\[q\] quit/
    );
    assert.match(prompt, /Your choice:\s*$/);
});

test('shouldEmitMappingConflictGuidance requires both unmapped warnings and conflicts', () => {
    assert.equal(
        shouldEmitMappingConflictGuidance({
            totalUnmappedCategoryWarnings: 1,
            accountsWithConflicts: 1,
        }),
        true
    );
    assert.equal(
        shouldEmitMappingConflictGuidance({
            totalUnmappedCategoryWarnings: 1,
            accountsWithConflicts: 0,
        }),
        false
    );
    assert.equal(
        shouldEmitMappingConflictGuidance({
            totalUnmappedCategoryWarnings: 0,
            accountsWithConflicts: 1,
        }),
        false
    );
});
