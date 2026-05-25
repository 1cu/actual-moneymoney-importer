import assert from 'node:assert/strict';
import { test } from 'node:test';
import Importer from '../../dist/utils/Importer.js';
import TransferPlanner from '../../dist/utils/TransferPlanner.js';

test('Importer constructor creates a TransferPlanner instance', () => {
    const config = { import: { transfers: {} } };
    const budgetConfig = {};
    const actualApi = {};
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const accountMap = { getMap: () => [] };
    const categoryMap = { getMappedActualCategoryId: () => ({}) };

    const importer = new Importer(
        config,
        budgetConfig,
        actualApi,
        logger,
        accountMap,
        categoryMap
    );

    assert.ok(importer.transferPlanner instanceof TransferPlanner);
});

test('Importer constructor stores TransferPlanner result as instance property', () => {
    const config = { import: { transfers: {} } };
    const budgetConfig = {};
    const actualApi = {};
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const accountMap = { getMap: () => [] };
    const categoryMap = { getMappedActualCategoryId: () => ({}) };

    const importer = new Importer(
        config,
        budgetConfig,
        actualApi,
        logger,
        accountMap,
        categoryMap
    );

    // Private fields in TypeScript are compile-time only;
    // the transferPlanner property is accessible at runtime from JS.
    assert.ok(importer.transferPlanner);
    assert.ok(typeof importer.transferPlanner === 'object');
    assert.ok(importer.transferPlanner instanceof TransferPlanner);
});
