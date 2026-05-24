import * as actual from '@actual-app/api';
import type {
    APICategoryEntity,
    APICategoryGroupEntity,
} from '@actual-app/api/models';
import type {
    ImportTransactionEntity,
    TransactionEntity,
} from '@actual-app/core/types/models';
import { format } from 'date-fns';
import fs from 'fs/promises';
import { withApiNoiseFilter } from './ActualApiLogControl.js';
import { ActualServerConfig } from './config.js';
import Logger, { LogLevel } from './Logger.js';
import { DEFAULT_DATA_DIR } from './shared.js';

type UserFile = {
    deleted: number;
    encryptKeyId: null;
    fileId: string;
    groupId: string;
    name: string;
};

type GetUserFilesResponse = {
    status: string;
    data: Array<UserFile>;
};

type TransactionBatchUpdateChanges = {
    added?: Array<Record<string, unknown>>;
    updated?: Array<Record<string, unknown>>;
    deleted?: Array<{ id: string }>;
    runTransfers?: boolean;
    learnCategories?: boolean;
};

const ACTUAL_TRANSACTION_HISTORY_START_DATE = format(
    new Date(2000, 0, 1),
    'yyyy-MM-dd'
);

class ActualApi {
    protected isInitialized = false;
    private actualInternal: Awaited<ReturnType<typeof actual.init>> | null =
        null;
    // private _api: typeof actual | null = null;

    constructor(
        private serverConfig: ActualServerConfig,
        private logger: Logger,
        private actualApi = actual,
        private fetchImpl = globalThis.fetch
    ) {}

    async init() {
        const actualDataDir = DEFAULT_DATA_DIR;

        const dataDirExists = await fs
            .access(actualDataDir)
            .then(() => true)
            .catch(() => false);

        if (!dataDirExists) {
            await fs.mkdir(actualDataDir, { recursive: true });
            this.logger.debug(
                `Created Actual data directory at ${actualDataDir}`
            );
        }

        this.logger.debug(
            `Initializing Actual instance for server ${this.serverConfig.serverUrl} with data directory ${actualDataDir}`
        );

        await this.withLogControl(async () => {
            this.actualInternal = await this.actualApi.init({
                dataDir: actualDataDir,
                serverURL: this.serverConfig.serverUrl,
                password: this.serverConfig.serverPassword,
            });
        });

        this.isInitialized = true;
    }

    async ensureInitialization() {
        if (!this.isInitialized) {
            await this.init();
        }
    }

    async sync() {
        await this.ensureInitialization();
        await this.withLogControl(async () => {
            await this.actualApi.sync();
        });
    }

    async getAccounts() {
        await this.ensureInitialization();
        const accounts = await this.withLogControl(async () => {
            return await this.actualApi.getAccounts();
        });
        return accounts;
    }

    async loadBudget(budgetId: string) {
        this.logger.debug(
            `Looking for budget configuration with syncId '${budgetId}'...`
        );

        const budgetConfig = this.serverConfig.budgets.find(
            (b) => b.syncId === budgetId
        );

        if (!budgetConfig) {
            throw new Error(`No budget with syncId '${budgetId}' found.`);
        }

        this.logger.debug(`Loading budget with syncId ${budgetId}...`);

        await this.withLogControl(async () => {
            await this.actualApi.downloadBudget(
                budgetConfig.syncId,
                budgetConfig.e2eEncryption.enabled
                    ? {
                          password: budgetConfig.e2eEncryption.password ?? '',
                      }
                    : undefined
            );
        });
    }

    importTransactions(
        accountId: string,
        transactions: ImportTransactionEntity[]
    ) {
        return this.withLogControl(() =>
            this.actualApi.importTransactions(accountId, transactions, {
                defaultCleared: false,
            })
        );
    }

    getTransactions(accountId: string) {
        const startDate = ACTUAL_TRANSACTION_HISTORY_START_DATE;
        const endDate = format(new Date(), 'yyyy-MM-dd');

        return this.withLogControl(() =>
            this.actualApi.getTransactions(accountId, startDate, endDate)
        );
    }

    async getTransactionsByIds(
        accountId: string,
        ids: string[]
    ): Promise<TransactionEntity[]> {
        if (ids.length === 0) {
            return [];
        }
        const idSet = new Set(ids);
        const all = await this.getTransactions(accountId);
        return all.filter((t) => idSet.has(t.id));
    }

    async getPayees(): Promise<
        Array<{ id: string; name: string; transfer_acct?: string }>
    > {
        await this.ensureInitialization();
        return this.withLogControl(() => this.actualApi.getPayees());
    }

    async getCategories(): Promise<APICategoryEntity[]> {
        await this.ensureInitialization();
        const categoryItems = await this.withLogControl(() =>
            this.actualApi.getCategories()
        );

        const categories = categoryItems.filter(
            (item): item is APICategoryEntity => {
                return 'group_id' in item;
            }
        );

        const filteredOutCount = categoryItems.length - categories.length;
        if (filteredOutCount > 0) {
            this.logger.debug(
                `Filtered out ${filteredOutCount} non-category entries from Actual getCategories() response.`
            );
        }

        return categories;
    }

    async getCategoryGroups(): Promise<APICategoryGroupEntity[]> {
        await this.ensureInitialization();
        return await this.withLogControl(() =>
            this.actualApi.getCategoryGroups()
        );
    }

    async updateTransaction(
        transactionId: string,
        fields: Partial<TransactionEntity>
    ) {
        await this.ensureInitialization();
        return await this.withLogControl(() =>
            this.actualApi.updateTransaction(transactionId, fields)
        );
    }

    async batchUpdateTransactions(changes: TransactionBatchUpdateChanges) {
        await this.ensureInitialization();

        const {
            updated = [],
            added = [],
            deleted = [],
            runTransfers = false,
        } = changes;

        if (added.length > 0 || deleted.length > 0) {
            throw new Error(
                'batchUpdateTransactions currently supports updated transactions only.'
            );
        }
        if (!this.actualInternal) {
            throw new Error('Actual API is not initialized.');
        }

        const api = this.actualInternal;

        return await this.withLogControl(() =>
            api.send('transactions-batch-update', {
                updated: updated.map(({ ...transaction }) => {
                    const { subtransactions: _subtransactions, ...clean } =
                        transaction as Record<string, unknown> & {
                            subtransactions?: unknown;
                        };
                    return clean;
                }),
                runTransfers,
            })
        );
    }

    async shutdown() {
        await this.ensureInitialization();
        await this.withLogControl(() => this.actualApi.shutdown());
    }

    private async getUserToken() {
        const responseData = await this.fetchJson<{
            data: { token: string | null };
        }>(
            `${this.serverConfig.serverUrl}/account/login`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    password: this.serverConfig.serverPassword,
                }),
            },
            'Could not get user token'
        );

        const userToken = responseData.data?.token;

        if (!userToken) {
            throw new Error(
                'Could not get user token: Invalid server password.'
            );
        }

        return userToken;
    }

    async getUserFiles() {
        const userToken = await this.getUserToken();

        const responseData = await this.fetchJson<GetUserFilesResponse>(
            `${this.serverConfig.serverUrl}/sync/list-user-files`,
            {
                headers: {
                    'X-Actual-Token': userToken,
                },
            },
            'Could not get user files'
        );

        return responseData.data.filter((f) => f.deleted === 0);
    }

    private async fetchJson<T>(
        url: string,
        init: Parameters<typeof fetch>[1] = {},
        context: string,
        timeoutMs = 30_000
    ): Promise<T> {
        const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
        const response = await this.fetchImpl(url, { ...init, signal });

        if (!response.ok) {
            throw new Error(
                `${context}: HTTP ${response.status} ${response.statusText}.`
            );
        }

        try {
            return (await response.json()) as T;
        } catch (error) {
            if (
                error instanceof SyntaxError ||
                (typeof error === 'object' &&
                    error !== null &&
                    'name' in error &&
                    error.name === 'SyntaxError')
            ) {
                throw new Error(`${context}: Server returned invalid JSON.`, {
                    cause: error,
                });
            }

            throw error;
        }
    }

    private async withLogControl<T>(callback: () => T | Promise<T>) {
        if (this.logger.logLevel >= LogLevel.ACTUAL) {
            return await callback();
        }
        return await withApiNoiseFilter(callback);
    }
}

export default ActualApi;
