import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as actual from '@actual-app/api';
import {
    previewProposal,
    withOfflineBudget,
} from '../../scripts/cutover-offline.mjs';

test('offline preview blocks network, replays raw payee, and preserves source', async () => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'actual-offline-test-')
    );
    const sourceRoot = path.join(root, 'source');
    const workDir = path.join(root, 'work');
    const originalFetch = globalThis.fetch;
    const originalConnect = net.Socket.prototype.connect;
    try {
        await fs.mkdir(sourceRoot);
        const internal = await actual.init({
            dataDir: sourceRoot,
            verbose: false,
        });
        await internal.send('create-budget', {
            budgetName: 'OfflineFixture',
            avoidUpload: true,
        });
        const accountId = await actual.createAccount({ name: 'Checking' }, 0);
        const sourceDir = path.join(
            sourceRoot,
            (await fs.readdir(sourceRoot))[0]
        );
        const [first, second] = (await actual.getCategories())
            .filter(category => !category.is_income)
            .slice(0, 2);
        await actual.shutdown();
        const sourceStat = await fs.stat(path.join(sourceDir, 'db.sqlite'));
        const transaction = {
            id: 'offline-probe',
            account: accountId,
            date: '2026-11-01',
            amount: -100,
            imported_payee: 'OFFLINE_PREVIEW_UNIQUE_RAW',
            rawImport: { imported_payee: 'OFFLINE_PREVIEW_UNIQUE_RAW' },
            payee: null,
            category: first.id,
            schedule: null,
        };
        await withOfflineBudget(
            { sourceDir, workDir },
            async ({ api, internal: offline }) => {
                assert.throws(
                    () => net.connect(443, 'example.com'),
                    /blocked a network call/
                );
                assert.throws(
                    () => globalThis.fetch('https://example.com'),
                    /blocked a network call/
                );
                const proposal = {
                    create: [
                        {
                            stage: 'post',
                            conditionsOp: 'and',
                            conditions: [
                                {
                                    field: 'imported_payee',
                                    op: 'is',
                                    value: transaction.imported_payee,
                                },
                            ],
                            actions: [
                                {
                                    field: 'category',
                                    op: 'set',
                                    value: second.id,
                                },
                            ],
                        },
                    ],
                    delete: [],
                };
                const report = await previewProposal({
                    api,
                    internal: offline,
                    transactions: [transaction],
                    proposal,
                    asOf: '2026-11-02',
                });
                assert.equal(report.details[0].current.category, first.id);
                assert.equal(report.details[0].baseline.category, null);
                assert.equal(report.details[0].proposed.category, second.id);
                assert.equal(report.windows[0].start, '2026-10-03');
                assert.equal(report.windows[0].categoryDelta[first.id], 100);
                assert.equal(report.windows[0].categoryDelta[second.id], -100);
                assert.deepEqual(report.unresolvedAliases, [
                    transaction.imported_payee,
                ]);
                assert.equal(report.safeToApply, false);
                assert.equal(
                    report.parity.budgetParityScope,
                    'cutover-with-historical-ledger-unchanged'
                );
            }
        );
        assert.equal(globalThis.fetch, originalFetch);
        assert.equal(net.Socket.prototype.connect, originalConnect);
        await withOfflineBudget(
            { sourceDir, workDir: path.join(root, 'keep-raw-work') },
            async ({ api, internal: offline }) => {
                const report = await previewProposal({
                    api,
                    internal: offline,
                    transactions: [transaction],
                    proposal: { create: [], delete: [] },
                    asOf: '2026-11-02',
                    keepRawPayees: true,
                });
                assert.equal(report.safeToApply, true);
                assert.equal(report.unresolvedPayeePolicy, 'keep-raw');
                assert.deepEqual(report.unresolvedAliases, [
                    transaction.imported_payee,
                ]);
                assert.equal(report.parity.scheduleParity, true);
                const imported = {
                    date: '2026-11-02',
                    amount: -123,
                    imported_id: 'synthetic-repeat-import',
                    payee_name: 'Synthetic merchant',
                };
                const firstImport = await api.importTransactions(accountId, [
                    imported,
                ]);
                const secondImport = await api.importTransactions(accountId, [
                    imported,
                ]);
                assert.equal(firstImport.added.length, 1);
                assert.equal(secondImport.added.length, 0);
                assert.equal(
                    (await api.getTransactions(accountId)).filter(
                        t => t.imported_id === imported.imported_id
                    ).length,
                    1
                );

                const scheduleChange = await previewProposal({
                    api,
                    internal: offline,
                    transactions: [transaction],
                    proposal: {
                        create: [
                            {
                                stage: 'post',
                                conditionsOp: 'and',
                                conditions: [
                                    {
                                        field: 'imported_payee',
                                        op: 'is',
                                        value: transaction.imported_payee,
                                    },
                                ],
                                actions: [
                                    {
                                        op: 'link-schedule',
                                        value: '00000000-0000-4000-8000-000000000001',
                                    },
                                ],
                            },
                        ],
                        delete: [],
                    },
                    asOf: '2026-11-02',
                    keepRawPayees: true,
                });
                assert.equal(scheduleChange.parity.scheduleParity, false);
                assert.equal(scheduleChange.safeToApply, false);
            }
        );
        await assert.rejects(
            withOfflineBudget(
                { sourceDir, workDir: path.join(root, 'failure-work') },
                async () => {
                    throw new Error('preview failed');
                }
            ),
            /preview failed/
        );
        assert.equal(globalThis.fetch, originalFetch);
        assert.equal(net.Socket.prototype.connect, originalConnect);
        const after = await fs.stat(path.join(sourceDir, 'db.sqlite'));
        assert.equal(after.mtimeMs, sourceStat.mtimeMs);
        assert.equal(after.size, sourceStat.size);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
