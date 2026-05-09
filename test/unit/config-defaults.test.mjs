import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
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
    assert.equal(parsed.import.transfers.enabled, false);
    assert.deepEqual(parsed.import.transfers.categoryRefs, []);
    assert.equal(parsed.import.transfers.matchWindowDays, 5);
});

test('automatic transfers require at least one category ref when enabled', () => {
    assert.throws(
        () =>
            configSchema.parse({
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                    transfers: {
                        enabled: true,
                        categoryRefs: [],
                    },
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
            }),
        (error) =>
            error instanceof ZodError &&
            error.issues.some((issue) =>
                issue.message.includes(
                    'At least one transfer category ref must be configured'
                )
            )
    );
});
