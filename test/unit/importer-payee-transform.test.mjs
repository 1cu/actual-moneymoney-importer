import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUniquePayeeNamesForTransformation } from '../../dist/utils/Importer.js';

const makeTransaction = ({ accountUuid, id, name }) => ({
    accountUuid,
    id,
    name,
    valueDate: new Date('2026-04-21'),
});

test('collectUniquePayeeNamesForTransformation dedupes and excludes transfer seeds', () => {
    const result = collectUniquePayeeNamesForTransformation({
        accountStates: [
            {
                newMonMonTransactions: [
                    makeTransaction({
                        accountUuid: 'acc-1',
                        id: '1',
                        name: 'Netflix',
                    }),
                    makeTransaction({
                        accountUuid: 'acc-1',
                        id: '2',
                        name: 'Coffee Shop',
                    }),
                ],
                existingActualTransactions: [],
            },
            {
                newMonMonTransactions: [
                    makeTransaction({
                        accountUuid: 'acc-2',
                        id: '3',
                        name: 'Coffee Shop',
                    }),
                    makeTransaction({
                        accountUuid: 'acc-2',
                        id: '4',
                        name: 'Books',
                    }),
                ],
                existingActualTransactions: [
                    {
                        id: 'existing-1',
                        imported_id: 'existing-1',
                    },
                ],
            },
        ],
        transferPlan: {
            seedByImportedId: new Map([['acc-1-2', { importedId: 'acc-1-2' }]]),
            suppressedImportedIds: new Set(['acc-2-4']),
            existingCounterpartConversionsByImportedId: new Map(),
            resolvedTransferCategoryUuids: new Set(),
        },
    });

    assert.deepEqual(result, ['Coffee Shop', 'Netflix']);
});
