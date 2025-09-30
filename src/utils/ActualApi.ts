import actual from '@actual-app/api';
import fs from 'fs/promises';
import type { ActualServerConfig } from './config.js';
import Logger from './Logger.js';
import { DEFAULT_DATA_DIR } from './shared.js';

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

class ActualApi {
    private initialized = false;
    private dataDir: string = DEFAULT_DATA_DIR;

    public constructor(
        private readonly serverConfig: ActualServerConfig,
        private readonly logger: Logger
    ) {}

    private async ensureDataDir(): Promise<void> {
        await fs.mkdir(this.dataDir, { recursive: true });
    }

    private async ensureSession(): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.ensureDataDir();

        await actual.init({
            dataDir: this.dataDir,
            serverURL: this.serverConfig.serverUrl,
            password: this.serverConfig.serverPassword,
        });

        this.initialized = true;
        this.logger.debug(`Connected to Actual server ${this.serverConfig.serverUrl}`);
    }

    public async init(customDataDir?: string): Promise<void> {
        if (customDataDir) {
            this.dataDir = customDataDir;
        }

        await this.ensureSession();
    }

    public async loadBudget(budgetId: string): Promise<void> {
        const budgetConfig = this.serverConfig.budgets.find((budget) => budget.syncId === budgetId);

        if (!budgetConfig) {
            throw new Error(`No budget with syncId '${budgetId}' found for server ${this.serverConfig.serverUrl}.`);
        }

        await this.ensureSession();

        const encryption =
            budgetConfig.e2eEncryption.enabled && budgetConfig.e2eEncryption.password
                ? { password: budgetConfig.e2eEncryption.password }
                : undefined;

        this.logger.debug(`Preparing budget ${budgetConfig.syncId} for import`);
        await actual.downloadBudget(budgetConfig.syncId, encryption);
        await actual.loadBudget(budgetConfig.syncId);
    }

    public async getAccounts(): ReturnType<typeof actual.getAccounts> {
        await this.ensureSession();
        return actual.getAccounts();
    }

    public async getTransactions(
        accountId: string,
        options?: { from?: Date; to?: Date }
    ): ReturnType<typeof actual.getTransactions> {
        await this.ensureSession();

        const from = options?.from ?? new Date(2000, 0, 1);
        const to = options?.to ?? null;

        if (to) {
            return actual.getTransactions(accountId, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
        }

        return actual.getTransactions(accountId, from.toISOString().slice(0, 10));
    }

    public async importTransactions(
        accountId: string,
        transactions: ImportTransaction[]
    ): ReturnType<typeof actual.importTransactions> {
        await this.ensureSession();

        this.logger.debug(`Importing ${transactions.length} transactions into account ${accountId}`);

        return actual.importTransactions(accountId, transactions, { defaultCleared: false });
    }

    public async shutdown(): Promise<void> {
        if (!this.initialized) {
            return;
        }

        await actual.shutdown();
        this.logger.debug(`Disconnected from Actual server ${this.serverConfig.serverUrl}`);
        this.initialized = false;
    }
}

export default ActualApi;
