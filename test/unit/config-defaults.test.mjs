import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema } from '../../dist/utils/config.js';

test('config defaults synchronizeCategories to false when omitted', () => {
    const parsed = configSchema.parse({
        payeeTransformation: {
            enabled: false,
        },
        import: {
            importUncheckedTransactions: true,
        },
        actualServers: [
            {
                serverUrl: 'http://localhost:5006',
                serverPassword: 'pw',
                budgets: [
                    {
                        syncId: 'budget-id',
                        e2eEncryption: {
                            enabled: false,
                        },
                        accountMapping: {},
                    },
                ],
            },
        ],
    });

    assert.equal(parsed.import.synchronizeCategories, false);
});
