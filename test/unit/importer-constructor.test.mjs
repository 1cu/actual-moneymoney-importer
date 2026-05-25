import assert from 'node:assert/strict';
import { test } from 'node:test';
import Importer from '../../dist/utils/Importer.js';
import TransferPlanner from '../../dist/utils/TransferPlanner.js';

test('Importer constructor wires TransferPlanner dependency', () => {
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

    assert.ok(importer.transferPlanner);
    assert.ok(typeof importer.transferPlanner === 'object');
    assert.ok(importer.transferPlanner instanceof TransferPlanner);
});
