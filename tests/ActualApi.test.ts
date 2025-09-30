import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { makeInvalidCredentialsError, makeNetworkDisconnectError } from './helpers/error-fixtures.js';

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
import type ActualApi from '../src/utils/ActualApi.js';

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

vi.mock('fs/promises', () => ({
    default: {
        access: vi.fn(),
        mkdir: vi.fn(),
        readdir: vi.fn(),
        readFile: vi.fn(),
    },
}));

const createLogger = (): Logger => {
    const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLogLevel: vi.fn(),
    } as unknown as Logger;
    return logger;
};

const makeServerConfig = (budgetId: string): ActualServerConfig => ({
    serverUrl: 'http://localhost:5000',
    serverPassword: 'test-password',
    requestTimeoutMs: 30000,
    budgets: [
        {
            syncId: budgetId,
            e2eEncryption: {
                enabled: false,
            },
        },
    ],
});

describe('ActualApi', () => {
    let api: ActualApi;
    let logger: Logger;

    beforeEach(() => {
        vi.clearAllMocks();
        logger = createLogger();
    });

    afterEach(async () => {
        if (api) {
            try {
                await api.shutdown();
            } catch {
                // Ignore shutdown errors in tests
            }
        }
    });

    it('initializes and shuts down correctly', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        await api.init();
        expect(initMock).toHaveBeenCalled();

        await api.shutdown();
        expect(shutdownMock).toHaveBeenCalled();
    });

    it('handles network errors gracefully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        initMock.mockRejectedValueOnce(makeNetworkDisconnectError());

        await expect(api.init()).rejects.toThrow();
    });

    it('handles authentication errors gracefully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        initMock.mockRejectedValueOnce(makeInvalidCredentialsError());

        await expect(api.init()).rejects.toThrow();
    });

    it('loads budget successfully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        // Mock fs.readdir to return directory entries
        const { default: fs } = await import('fs/promises');
        fs.readdir = vi.fn().mockResolvedValue([{ name: 'budget-dir', isDirectory: () => true }]);

        // Mock fs.readFile to return metadata
        fs.readFile = vi.fn().mockResolvedValue(
            JSON.stringify({
                groupId: 'budget',
                id: 'budget-id',
            })
        );

        downloadBudgetMock.mockResolvedValueOnce(undefined);
        loadBudgetMock.mockResolvedValueOnce(undefined);
        syncMock.mockResolvedValueOnce(undefined);

        await api.init();
        await api.loadBudget('budget');

        expect(downloadBudgetMock).toHaveBeenCalled();
        expect(loadBudgetMock).toHaveBeenCalled();
        expect(syncMock).toHaveBeenCalled();
    });

    it('imports transactions successfully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        const transactions: ImportTransaction[] = [
            {
                date: '2024-01-01',
                amount: 100,
                payee: 'Test Payee',
            },
        ];

        importTransactionsMock.mockResolvedValueOnce({
            added: [transactions[0]],
            updated: [],
            errors: [],
        });

        await api.init();
        const result = await api.importTransactions('account-1', transactions);

        expect(importTransactionsMock).toHaveBeenCalled();
        expect(result.added).toHaveLength(1);
    });

    it('gets transactions successfully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        const mockTransactions = [{ id: '1', amount: 100, payee: 'Test' }];

        getTransactionsMock.mockResolvedValueOnce(mockTransactions);

        await api.init();
        const result = await api.getTransactions('account-1', {
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
        });

        expect(getTransactionsMock).toHaveBeenCalled();
        expect(result).toEqual(mockTransactions);
    });

    it('gets accounts successfully', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        const mockAccounts = [{ id: '1', name: 'Test Account' }];

        getAccountsMock.mockResolvedValueOnce(mockAccounts);

        await api.init();
        const result = await api.getAccounts();

        expect(getAccountsMock).toHaveBeenCalled();
        expect(result).toEqual(mockAccounts);
    });

    it('handles timeout errors', async () => {
        const { default: ActualApi } = await import('../src/utils/ActualApi.js');
        api = new ActualApi(makeServerConfig('budget'), logger);

        initMock.mockImplementation(
            () =>
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timeout')), 100);
                })
        );

        await expect(api.init()).rejects.toThrow();
    });
});
