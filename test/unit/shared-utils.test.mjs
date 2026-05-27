import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildTransactionNotes,
    getIdForMoneyMoneyTransaction,
    sanitizeString,
} from '../../dist/utils/shared.js';

const makeTxn = (overrides) => ({
    purpose: undefined,
    comment: undefined,
    ...overrides,
});

test('getIdForMoneyMoneyTransaction returns accountUuid-id joined with a hyphen', () => {
    const result = getIdForMoneyMoneyTransaction({
        accountUuid: 'acc-123',
        id: 'txn-456',
    });
    assert.strictEqual(result, 'acc-123-txn-456');
});

test('getIdForMoneyMoneyTransaction uses id as-is when it is a number', () => {
    const result = getIdForMoneyMoneyTransaction({
        accountUuid: 'acc-1',
        id: 42,
    });
    assert.strictEqual(result, 'acc-1-42');
});

test('getIdForMoneyMoneyTransaction works with uuids containing hyphens', () => {
    const result = getIdForMoneyMoneyTransaction({
        accountUuid: 'abc-def-123',
        id: '-42',
    });
    assert.strictEqual(result, 'abc-def-123--42');
});

test('buildTransactionNotes returns purpose only when no comment', () => {
    const txn = makeTxn({ purpose: 'Ruecklagen' });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, 'Ruecklagen');
});

test('buildTransactionNotes returns formatted comment when importComments is true and no purpose', () => {
    const txn = makeTxn({ comment: 'my comment' });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, '# my comment');
});

test('buildTransactionNotes joins purpose and comment with separator when both exist and importComments is true', () => {
    const txn = makeTxn({ purpose: 'Ruecklagen', comment: 'memo' });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, 'Ruecklagen | # memo');
});

test('buildTransactionNotes returns empty string when nothing to include', () => {
    const txn = makeTxn({});
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, '');
});

test('buildTransactionNotes omits comment when importComments is false', () => {
    const txn = makeTxn({ purpose: 'Ruecklagen', comment: 'memo' });
    const result = buildTransactionNotes(txn, false, '# ');
    assert.strictEqual(result, 'Ruecklagen');
});

test('buildTransactionNotes returns comment only when no purpose and importComments is true', () => {
    const txn = makeTxn({ comment: 'note' });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, '# note');
});

test('buildTransactionNotes uses custom commentPrefix', () => {
    const txn = makeTxn({ comment: 'inline note' });
    const result = buildTransactionNotes(txn, true, '// ');
    assert.strictEqual(result, '// inline note');
});

test('buildTransactionNotes handles purpose with special characters', () => {
    const txn = makeTxn({
        purpose: 'Überweisung & mehr | test',
        comment: 'foo',
    });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, 'Überweisung & mehr | test | # foo');
});

test('buildTransactionNotes does not trim leading/trailing whitespace in comment', () => {
    const txn = makeTxn({ purpose: 'purpose', comment: '  spaced  ' });
    const result = buildTransactionNotes(txn, true, '# ');
    assert.strictEqual(result, 'purpose | #   spaced  ');
});

test('sanitizeString returns empty string for null/undefined/empty', () => {
    assert.strictEqual(sanitizeString(null), '');
    assert.strictEqual(sanitizeString(undefined), '');
    assert.strictEqual(sanitizeString(''), '');
});

test('sanitizeString passes through clean NFC text unchanged', () => {
    assert.strictEqual(sanitizeString('Hello World'), 'Hello World');
    assert.strictEqual(sanitizeString('Überweisung 123'), 'Überweisung 123');
    assert.strictEqual(
        sanitizeString('Italien, Österreich & mehr'),
        'Italien, Österreich & mehr'
    );
});

test('sanitizeString applies NFC normalization', () => {
    // e-acute as decomposed form (U+0065 U+0301) should become NFC é (U+00E9)
    const decomposed = 'caf\u0065\u0301'; // caf + e + combining acute
    const composed = 'caf\u00E9'; // caf + é (precomposed)
    assert.strictEqual(sanitizeString(decomposed), composed);
});

test('sanitizeString strips control characters but keeps newlines/tabs/carriage returns', () => {
    assert.strictEqual(sanitizeString('a\u0000b\u0008c'), 'abc');
    assert.strictEqual(sanitizeString('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('sanitizeString trims surrounding whitespace', () => {
    assert.strictEqual(sanitizeString('  hello  '), 'hello');
    assert.strictEqual(sanitizeString('\t\nline\n\t'), 'line');
});
