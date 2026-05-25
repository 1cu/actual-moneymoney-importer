import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    convertToActualTransaction,
    getStartingBalanceForAccount,
} from '../../dist/utils/Importer.js';

const makeTransaction = (overrides = {}) => ({
    id: 'txn-1',
    accountUuid: 'acc-uuid-1',
    amount: -42.5,
    valueDate: new Date('2025-06-15'),
    booked: true,
    name: 'Coffee Shop',
    purpose: 'Morning coffee',
    comment: 'Comment text',
    ...overrides,
});

const makeOptions = (overrides = {}) => ({
    importComments: false,
    commentPrefix: '# ',
    synchronizeClearedStatus: false,
    ...overrides,
});

const makePlannedTransfer = (overrides = {}) => ({
    importedId: 'acc-uuid-1-txn-1',
    transferPayeeId: 'payee-transfer-123',
    targetActualAccountId: 'act-target',
    targetActualAccountName: 'Target Account',
    ...overrides,
});

const makeAccount = (overrides = {}) => ({
    balance: [[500, 'EUR']],
    uuid: 'acc-1',
    name: 'Checking',
    accountNumber: 'DE123',
    ...overrides,
});

// convertToActualTransaction tests

test('produces all required fields with correct values', () => {
    const result = convertToActualTransaction(
        makeTransaction(),
        undefined,
        'act-account-id',
        makeOptions()
    );

    assert.strictEqual(result.account, 'act-account-id');
    assert.strictEqual(typeof result.date, 'string');
    assert.ok(result.date.length > 0);
    assert.strictEqual(result.amount, -4250);
    assert.strictEqual(result.imported_id, 'acc-uuid-1-txn-1');
    assert.strictEqual(result.imported_payee, 'Coffee Shop');
});

test('rounds amount correctly', () => {
    const negative = convertToActualTransaction(
        makeTransaction({ amount: -42.5 }),
        undefined,
        'a',
        makeOptions()
    );
    assert.strictEqual(negative.amount, -4250);

    const positive = convertToActualTransaction(
        makeTransaction({ amount: 12.99 }),
        undefined,
        'a',
        makeOptions()
    );
    assert.strictEqual(positive.amount, 1299);

    const zero = convertToActualTransaction(
        makeTransaction({ amount: 0 }),
        undefined,
        'a',
        makeOptions()
    );
    assert.strictEqual(zero.amount, 0);
});

test('formats valueDate as yyyy-MM-dd', () => {
    const result = convertToActualTransaction(
        makeTransaction({ valueDate: new Date('2025-06-15') }),
        undefined,
        'a',
        makeOptions()
    );

    assert.strictEqual(result.date, '2025-06-15');
});

test('trims payee name', () => {
    const result = convertToActualTransaction(
        makeTransaction({ name: '  Coffee Shop  ' }),
        undefined,
        'a',
        makeOptions()
    );

    assert.strictEqual(result.imported_payee, 'Coffee Shop');
});

test('handles undefined or null name as empty string', () => {
    const withUndefined = convertToActualTransaction(
        makeTransaction({ name: undefined }),
        undefined,
        'a',
        makeOptions()
    );
    assert.strictEqual(withUndefined.imported_payee, '');

    const withNull = convertToActualTransaction(
        makeTransaction({ name: null }),
        undefined,
        'a',
        makeOptions()
    );
    assert.strictEqual(withNull.imported_payee, '');
});

test('sets payee field when plannedTransfer is provided', () => {
    const result = convertToActualTransaction(
        makeTransaction(),
        makePlannedTransfer(),
        'a',
        makeOptions()
    );

    assert.strictEqual(result.payee, 'payee-transfer-123');
});

test('does not set payee when plannedTransfer is undefined', () => {
    const result = convertToActualTransaction(
        makeTransaction(),
        undefined,
        'a',
        makeOptions()
    );

    assert.strictEqual(result.payee, undefined);
});

test('sets cleared true when synchronizeClearedStatus is true and booked is true', () => {
    const result = convertToActualTransaction(
        makeTransaction({ booked: true }),
        undefined,
        'a',
        makeOptions({ synchronizeClearedStatus: true })
    );

    assert.strictEqual(result.cleared, true);
});

test('sets cleared false when synchronizeClearedStatus is true and booked is false', () => {
    const result = convertToActualTransaction(
        makeTransaction({ booked: false }),
        undefined,
        'a',
        makeOptions({ synchronizeClearedStatus: true })
    );

    assert.strictEqual(result.cleared, false);
});

test('does not set cleared when synchronizeClearedStatus is false', () => {
    const result = convertToActualTransaction(
        makeTransaction(),
        undefined,
        'a',
        makeOptions({ synchronizeClearedStatus: false })
    );

    assert.strictEqual(result.cleared, undefined);
});

test('builds notes with purpose when importComments is false', () => {
    const result = convertToActualTransaction(
        makeTransaction({ purpose: 'Coffee payment', comment: 'Some comment' }),
        undefined,
        'a',
        makeOptions({ importComments: false })
    );

    assert.strictEqual(result.notes, 'Coffee payment');
});

test('builds notes with purpose and prefix comment when importComments is true', () => {
    const result = convertToActualTransaction(
        makeTransaction({ purpose: 'Coffee payment', comment: 'My comment' }),
        undefined,
        'a',
        makeOptions({ importComments: true, commentPrefix: '# ' })
    );

    assert.strictEqual(result.notes, 'Coffee payment | # My comment');
});

test('does not set notes when there is no purpose and no comment', () => {
    const result = convertToActualTransaction(
        makeTransaction({ purpose: undefined, comment: undefined }),
        undefined,
        'a',
        makeOptions()
    );

    assert.strictEqual(result.notes, undefined);
});

test('generates importedId from accountUuid and id', () => {
    const result = convertToActualTransaction(
        makeTransaction({ accountUuid: 'my-acc', id: 'tx-99' }),
        undefined,
        'a',
        makeOptions()
    );

    assert.strictEqual(result.imported_id, 'my-acc-tx-99');
});

// getStartingBalanceForAccount tests

test('returns starting balance as rounded minor units', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [[1000, 'EUR']] }),
        [
            makeTransaction({ booked: true, amount: -200 }),
            makeTransaction({ booked: true, amount: -150 }),
        ]
    );

    // 1000 - (-200 + -150) = 1350 → Math.round(1350 * 100) = 135000
    assert.strictEqual(result, 135000);
});

test('only sums booked transactions ignoring pending', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [[1000, 'EUR']] }),
        [
            makeTransaction({ booked: true, amount: -200 }),
            makeTransaction({ booked: false, amount: -100 }),
        ]
    );

    // 1000 - (-200) = 1200 → Math.round(1200 * 100) = 120000
    assert.strictEqual(result, 120000);
});

test('handles empty transactions array', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [[500, 'EUR']] }),
        []
    );

    // 500 → Math.round(500 * 100) = 50000
    assert.strictEqual(result, 50000);
});

test('handles zero balance', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [[0, 'EUR']] }),
        [
            makeTransaction({ booked: true, amount: -100 }),
            makeTransaction({ booked: true, amount: -50 }),
        ]
    );

    // 0 - (-150) = 150 → Math.round(150 * 100) = 15000
    assert.strictEqual(result, 15000);
});

test('defaults balance to zero when balance array is empty', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [] }),
        []
    );

    assert.strictEqual(result, 0);
});

test('defaults balance to zero when first balance entry is null', () => {
    const result = getStartingBalanceForAccount(
        makeAccount({ balance: [[null, 'EUR']] }),
        []
    );

    assert.strictEqual(result, 0);
});
