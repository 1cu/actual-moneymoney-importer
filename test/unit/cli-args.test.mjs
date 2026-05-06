import assert from 'node:assert/strict';
import test from 'node:test';
import { includesRef, toRefList } from '../../dist/utils/cliArgs.js';

test('toRefList returns undefined for empty input', () => {
    assert.equal(toRefList(undefined), undefined);
    assert.equal(toRefList(''), undefined);
});

test('toRefList splits comma-separated and trims values', () => {
    assert.deepEqual(toRefList(' one, two ,three '), ['one', 'two', 'three']);
    assert.deepEqual(toRefList(['one,two', ' three ']), [
        'one',
        'two',
        'three',
    ]);
});

test('includesRef defaults to true for undefined refs', () => {
    assert.equal(includesRef(undefined, 'abc'), true);
    assert.equal(includesRef([], 'abc'), true);
});

test('includesRef matches case-insensitively', () => {
    assert.equal(includesRef(['ABC'], 'abc'), true);
    assert.equal(includesRef(['abc'], 'def'), false);
});
