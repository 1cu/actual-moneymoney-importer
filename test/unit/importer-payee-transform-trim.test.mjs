import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUniquePayeeNamesForTransformation } from '../../dist/utils/Importer.js';

test('collectUniquePayeeNamesForTransformation trims payee names', () => {
    const result = collectUniquePayeeNamesForTransformation({
        accountStates: [
            {
                newMonMonTransactions: [
                    {
                        accountUuid: 'acc-1',
                        id: '1',
                        name: '  Netflix  ',
                        valueDate: new Date('2026-04-21'),
                    },
                ],
            },
        ],
        transferPlan: {
            seedByImportedId: new Map(),
            suppressedImportedIds: new Set(),
            existingCounterpartConversionsByImportedId: new Map(),
            resolvedTransferCategoryUuids: new Set(),
        },
    });

    assert.deepEqual(result, ['Netflix']);
});
