import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import type { Dirent } from 'node:fs';

// Type for transaction import - matches the ImportTransaction interface
type ImportTransaction = {
    account?: string;
    date: string;
    amount?: number;
    payee?: string;
    payee_name?: string;
    imported_payee?: string;
    category?: string;
    notes?: string;
    imported_id?: string;
    transfer_id?: string;
    cleared?: boolean;
    subtransactions?: Array<{
        amount: number;
        category?: string;
        notes?: string;
    }>;
};

import type { ActualServerConfig } from '../src/utils/config.js';
import type Logger from '../src/utils/Logger.js';
import { LogLevel } from '../src/utils/Logger.js';
import { DEFAULT_DATA_DIR } from '../src/utils/shared.js';

const initMock = vi.fn();
const getAccountsMock = vi.fn();
const downloadBudgetMock = vi.fn();
const loadBudgetMock = vi.fn();
const importTransactionsMock = vi.fn();
const syncMock = vi.fn();
const getTransactionsMock = vi.fn();
const shutdownMock = vi.fn();

vi.mock('@actual-app/api', () => ({
    default: {
        init: initMock,
        internal: {
            send: vi.fn(),
        },
        getAccounts: getAccountsMock,
        downloadBudget: downloadBudgetMock,
        loadBudget: loadBudgetMock,
        importTransactions: importTransactionsMock,
        sync: syncMock,
        getTransactions: getTransactionsMock,
        shutdown: shutdownMock,
    },
}));

const accessMock = vi.fn();
const mkdirMock = vi.fn();
const readdirMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('fs/promises', () => ({
    default: {
        access: accessMock,
        mkdir: mkdirMock,
        readdir: readdirMock,
        readFile: readFileMock,
    },
}));

const createLogger = () =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLevel: () => LogLevel.INFO,
    }) as unknown as Logger;

const createDirent = (
    name: string,
    { isDirectory = true }: { isDirectory?: boolean } = {}
): Dirent =>
    ({
        name,
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSymbolicLink: () => false,
        isSocket: () => false,
    }) as unknown as Dirent;

describe('ActualApi', () => {
    beforeEach(() => {
        initMock.mockReset();
        getAccountsMock.mockReset();
        downloadBudgetMock.mockReset();
        loadBudgetMock.mockReset();
        importTransactionsMock.mockReset();
        syncMock.mockReset();
        getTransactionsMock.mockReset();
        shutdownMock.mockReset();
        shutdownMock.mockResolvedValue(undefined);
        initMock.mockResolvedValue(undefined);
        accessMock.mockReset();
        mkdirMock.mockReset();
        readdirMock.mockReset();
        readFileMock.mockReset();
        accessMock.mockResolvedValue(undefined);
        mkdirMock.mockResolvedValue(undefined);
        readdirMock.mockResolvedValue([]);
        readFileMock.mockRejectedValue(new Error('missing metadata'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('passes bounded date ranges to the Actual API and restores console state', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());
        await api.init();

        const logSpy = vi.spyOn(console, 'log');
        getTransactionsMock.mockImplementation(async () => {
            console.log('Got messages from server abc');
            return [];
        });

        const start = new Date('2024-02-01T00:00:00Z');
        const end = new Date('2024-02-20T00:00:00Z');

        await api.getTransactions('account-1', { from: start, to: end });

        expect(getTransactionsMock).toHaveBeenCalledWith(
            'account-1',
            '2024-02-01',
            '2024-02-20'
        );
        expect(console.log).toBe(logSpy);
        expect(
            logSpy.mock.calls.some((args) =>
                String(args[0]).includes('Got messages from server')
            )
        ).toBe(false);

        logSpy.mockRestore();
    });

    it('downloads, loads, and synchronises the requested budget', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());

        readdirMock.mockResolvedValue([
            createDirent('budget-dir'),
            createDirent('other'),
        ]);
        readFileMock.mockImplementation(async (filePath: string) => {
            if (filePath === path.join(DEFAULT_DATA_DIR, 'budget-dir', 'metadata.json')) {
                return JSON.stringify({ groupId: 'budget' });
            }

            return JSON.stringify({ groupId: 'other-budget' });
        });

        initMock.mockResolvedValue(undefined);
        downloadBudgetMock.mockResolvedValue(undefined);
        loadBudgetMock.mockResolvedValue(undefined);
        syncMock.mockResolvedValue(undefined);

        await api.loadBudget('budget');

        expect(downloadBudgetMock).toHaveBeenCalledWith('budget', undefined);
        expect(loadBudgetMock).toHaveBeenCalledWith('budget');
        expect(syncMock).toHaveBeenCalled();
        expect(initMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dataDir: DEFAULT_DATA_DIR,
            })
        );
        expect(downloadBudgetMock.mock.invocationCallOrder[0]).toBeLessThan(
            loadBudgetMock.mock.invocationCallOrder[0]
        );
        expect(loadBudgetMock.mock.invocationCallOrder[0]).toBeLessThan(
            syncMock.mock.invocationCallOrder[0]
        );
    });

    it('surfaces a helpful error when the server no longer has the budget file', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());

        readdirMock.mockResolvedValue([createDirent('budget-dir')]);
        readFileMock.mockImplementation(async (filePath: string) => {
            if (filePath === path.join(DEFAULT_DATA_DIR, 'budget-dir', 'metadata.json')) {
                return JSON.stringify({ groupId: 'budget' });
            }

            throw new Error('Unexpected file path');
        });

        const postError = Object.assign(new Error('PostError: file-not-found'), {
            type: 'PostError',
            reason: 'file-not-found',
        });

        downloadBudgetMock.mockRejectedValue(postError);

        await expect(api.loadBudget('budget')).rejects.toThrow(
            /Actual server could not find the requested budget file/
        );
        expect(loadBudgetMock).not.toHaveBeenCalled();
    });

    it('surfaces timeout errors from Actual API calls', async () => {
        vi.useFakeTimers();

        try {
            const { default: ActualApi, ActualApiTimeoutError } = await import(
                '../src/utils/ActualApi.js'
            );

            const serverConfig: ActualServerConfig = {
                serverUrl: 'http://localhost:5006',
                serverPassword: 'secret',
                requestTimeoutMs: 5,
                budgets: [
                    {
                        syncId: 'budget',
                        e2eEncryption: {
                            enabled: false,
                            password: undefined,
                        },
                        accountMapping: {},
                    },
                ],
            };

            const logger = createLogger();
            const api = new ActualApi(serverConfig, logger);
            readdirMock.mockResolvedValue([createDirent('budget-dir')]);
            readFileMock.mockResolvedValue(
                JSON.stringify({ groupId: 'budget' })
            );
            await api.init(DEFAULT_DATA_DIR);

            downloadBudgetMock.mockImplementation(
                () => new Promise(() => undefined)
            );

            const loadPromise = api.loadBudget('budget');
            const capturedError = loadPromise.catch((error) => error);

            await vi.advanceTimersByTimeAsync(10);
            const timeoutError = await capturedError;
            expect(timeoutError).toBeInstanceOf(ActualApiTimeoutError);
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('timed out'),
                expect.arrayContaining([
                    'Server URL: http://localhost:5006',
                    'Budget sync ID: budget',
                ])
            );
            expect(loadBudgetMock).not.toHaveBeenCalled();
            expect(shutdownMock).toHaveBeenCalledTimes(1);
        } finally {
            // Ensure no timers remain and restore timers
            try {
                await vi.runOnlyPendingTimersAsync();
                vi.clearAllTimers();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('populates imported ids and deduplicates transactions before import', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());
        await api.init();

        const transactions: ImportTransaction[] = [
            {
                date: '2024-02-01',
                amount: 100,
                imported_id: 'existing',
                imported_payee: 'Alpha',
                notes: 'first',
            },
            {
                date: '2024-02-02',
                amount: 200,
                imported_id: 'existing',
                imported_payee: 'Beta',
                notes: 'second duplicate should be dropped',
            },
            {
                date: '2024-02-03',
                amount: 300,
                imported_payee: 'Gamma',
                notes: 'needs id',
            },
            {
                date: '2024-02-03',
                amount: 300,
                imported_payee: 'Gamma',
                notes: 'needs id',
            },
        ];

        importTransactionsMock.mockResolvedValue({
            added: [],
            updated: [],
        });

        await api.importTransactions('account-1', transactions);

        expect(importTransactionsMock).toHaveBeenCalledTimes(1);
        const [, sentTransactions] = importTransactionsMock.mock.calls[0];

        expect(sentTransactions).toHaveLength(2);
        expect(sentTransactions[0].imported_id).toBe('existing');
        expect(sentTransactions[1].imported_id).toMatch(/^mm-sync-/);
        expect(new Set(sentTransactions.map((tx) => tx.imported_id)).size).toBe(
            sentTransactions.length
        );
    });

    it('retries timed out imports without creating duplicate transactions', async () => {
        vi.useFakeTimers();

        let resolveFirstAttempt: (() => void) | null = null;

        try {
            const { default: ActualApi, ActualApiTimeoutError } = await import(
                '../src/utils/ActualApi.js'
            );

            const serverConfig: ActualServerConfig = {
                serverUrl: 'http://localhost:5006',
                serverPassword: 'secret',
                requestTimeoutMs: 5,
                budgets: [
                    {
                        syncId: 'budget',
                        e2eEncryption: {
                            enabled: false,
                            password: undefined,
                        },
                        accountMapping: {},
                    },
                ],
            };

            const logger = createLogger();
            const api = new ActualApi(serverConfig, logger);
            await api.init();

            const transactions: ImportTransaction[] = [
                {
                    date: '2024-02-01',
                    amount: 100,
                    imported_id: 'existing',
                    imported_payee: 'Alpha',
                    notes: 'first',
                },
                {
                    date: '2024-02-03',
                    amount: 300,
                    imported_payee: 'Gamma',
                    notes: 'needs id',
                },
            ];

            const serverRecords = new Map<string, ImportTransaction>();
            const callPayloads: string[][] = [];

            importTransactionsMock.mockImplementation((accountId, txns) => {
                expect(accountId).toBe('account-1');
                const ids = txns.map((tx) => tx.imported_id ?? '');
                callPayloads.push(ids);
                expect(new Set(ids).size).toBe(ids.length);

                const newTransactions = txns.filter((tx) => {
                    const importedId = tx.imported_id;
                    expect(importedId).toBeTruthy();
                    return importedId ? !serverRecords.has(importedId) : false;
                });

                const finalize = () => {
                    for (const tx of newTransactions) {
                        serverRecords.set(tx.imported_id as string, tx);
                    }
                };

                if (!resolveFirstAttempt) {
                    return new Promise((resolve) => {
                        resolveFirstAttempt = () => {
                            finalize();
                            resolve({ added: newTransactions, updated: [] });
                        };
                    });
                }

                finalize();
                return Promise.resolve({ added: newTransactions, updated: [] });
            });

            const firstAttempt = api.importTransactions(
                'account-1',
                transactions
            );
            const firstAttemptError = firstAttempt.catch((error) => error);

            await vi.advanceTimersByTimeAsync(10);

            const timeoutError = await firstAttemptError;
            expect(timeoutError).toBeInstanceOf(ActualApiTimeoutError);
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('timed out'),
                expect.arrayContaining([
                    'Server URL: http://localhost:5006',
                    'Account ID: account-1',
                ])
            );

            expect(resolveFirstAttempt).toBeTruthy();
            resolveFirstAttempt!();
            await Promise.resolve();

            const secondAttempt = api.importTransactions('account-1', transactions);
            await secondAttempt;

            expect(callPayloads).toHaveLength(2);
            expect(callPayloads[0]).toEqual(callPayloads[1]);
            expect(importTransactionsMock).toHaveBeenCalledTimes(2);
            const secondPayloadIds = callPayloads[1];
            expect(new Set(secondPayloadIds).size).toBe(secondPayloadIds.length);
            expect(serverRecords.size).toBe(2);
        } finally {
            try {
                await vi.runOnlyPendingTimersAsync();
                vi.clearAllTimers();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('ignores shutdown when the API was never initialised', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());
        await api.shutdown();

        expect(shutdownMock).not.toHaveBeenCalled();
    });

    it('derives the budget directory from metadata before initialisation', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'target-budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());

        readdirMock.mockResolvedValue([
            createDirent('alpha'),
            createDirent('target-directory'),
            createDirent('beta'),
        ]);
        readFileMock.mockImplementation(async (filePath: string) => {
            if (filePath === path.join(DEFAULT_DATA_DIR, 'target-directory', 'metadata.json')) {
                return JSON.stringify({ groupId: 'target-budget' });
            }

            return JSON.stringify({ groupId: 'other-budget' });
        });

        initMock.mockResolvedValue(undefined);
        downloadBudgetMock.mockResolvedValue(undefined);
        loadBudgetMock.mockResolvedValue(undefined);
        syncMock.mockResolvedValue(undefined);

        await api.loadBudget('target-budget');

        expect(initMock).toHaveBeenCalledTimes(1);
        expect(initMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dataDir: DEFAULT_DATA_DIR,
            })
        );
        expect(downloadBudgetMock).toHaveBeenCalled();
    });

    it('throws a helpful error when no metadata matches the requested budget', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'missing-budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());

        const nonMatchingMetadata = JSON.stringify({
            groupId: 'different-budget',
        });

        readdirMock.mockResolvedValue([
            createDirent('alpha'),
            createDirent('beta'),
        ]);
        readFileMock.mockResolvedValue(nonMatchingMetadata);
        downloadBudgetMock.mockResolvedValue(undefined);

        await expect(api.loadBudget('missing-budget')).rejects.toThrow(
            /No Actual budget directory found for syncId 'missing-budget'\./
        );
        expect(downloadBudgetMock).toHaveBeenCalledTimes(1);
        expect(readdirMock).toHaveBeenCalledTimes(2);
    });

    it('reinitialises across sequential budgets without leaking session state', async () => {
        const { default: ActualApi } = await import(
            '../src/utils/ActualApi.js'
        );

        const serverConfig: ActualServerConfig = {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'secret',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'first-budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
                {
                    syncId: 'second-budget',
                    e2eEncryption: {
                        enabled: false,
                        password: undefined,
                    },
                    accountMapping: {},
                },
            ],
        };

        const api = new ActualApi(serverConfig, createLogger());

        readdirMock.mockResolvedValue([
            createDirent('dir-first'),
            createDirent('dir-second'),
        ]);
        readFileMock.mockImplementation(async (filePath: string) => {
            if (filePath === path.join(DEFAULT_DATA_DIR, 'dir-first', 'metadata.json')) {
                return JSON.stringify({ groupId: 'first-budget' });
            }
            if (filePath === path.join(DEFAULT_DATA_DIR, 'dir-second', 'metadata.json')) {
                return JSON.stringify({ groupId: 'second-budget' });
            }
            throw new Error('unexpected file');
        });

        initMock.mockResolvedValue(undefined);
        downloadBudgetMock.mockResolvedValue(undefined);
        loadBudgetMock.mockResolvedValue(undefined);
        syncMock.mockResolvedValue(undefined);

        await api.loadBudget('first-budget');
        await api.shutdown();
        await api.loadBudget('second-budget');

        expect(initMock).toHaveBeenCalledTimes(2);
        const [firstInitArgs, secondInitArgs] = initMock.mock.calls.map(
            ([args]) => args
        );
        expect(firstInitArgs.dataDir).toBe(DEFAULT_DATA_DIR);
        expect(secondInitArgs.dataDir).toBe(DEFAULT_DATA_DIR);
        expect(shutdownMock).toHaveBeenCalled();
    });
});
