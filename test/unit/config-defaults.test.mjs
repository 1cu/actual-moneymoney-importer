import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { configSchema } from '../../dist/utils/config.js';

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

test('earliestImportDate rejects impossible calendar dates', () => {
    assert.throws(
        () =>
            configSchema.parse({
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
                                earliestImportDate: '2026-02-31',
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
                issue.message.includes('real calendar date')
            )
    );
});

test('omitted optional import config defaults are backwards-compatible', () => {
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
    assert.equal(parsed.import.transfers.matchWindowDays, 0);
    assert.equal(parsed.import.synchronizeClearedStatus, true);
});
