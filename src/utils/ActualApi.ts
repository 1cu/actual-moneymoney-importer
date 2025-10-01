import actual from '@actual-app/api';
// Type for transaction import - matches the ImportTransactionEntity interface
export type ImportTransaction = {
    account: string; // Required for ImportTransactionEntity
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
import { format } from 'date-fns';
import fs from 'fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { format as utilFormat } from 'node:util';

import type { ActualServerConfig } from './config.js';
import { DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS, FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS } from './config.js';
import Logger from './Logger.js';
import { DEFAULT_DATA_DIR } from './shared.js';

// Simple console filtering - just suppress common Actual SDK noise
const SUPPRESSED_PATTERNS = [
    /^Got messages from server/i,
    /^Syncing since/i,
    /^SENT -------/i,
    /^RECEIVED -------/i,
    /^Performing transaction reconciliation/i,
    /^Loading budget/i,
    /^Budget loaded/i,
    /^Saving budget/i,
    /^Budget saved/i,
    /^Applying migration/i,
    /^Migration applied/i,
    /^Debug data for the operations:/i,
];

// Simple console filtering - no caching needed

// Legacy support removed - using regex patterns only

// Complex types removed - using simple boolean logic

// Simple console filtering - just check if message matches suppressed patterns
const shouldSuppressConsoleOutput = (args: unknown[]): boolean => {
    if (args.length === 0) return false;

    const message = utilFormat(...(args as [unknown, ...unknown[]]));
    return SUPPRESSED_PATTERNS.some((pattern) => pattern.test(message));
};

// Simple console interceptor - just suppress or pass through
const createConsoleInterceptor =
    <TArgs extends unknown[]>(original: (...args: TArgs) => void) =>
    (...args: TArgs): void => {
        if (shouldSuppressConsoleOutput(args)) {
            return;
        }
        original.apply(console, args);
    };

type BudgetMetadata = {
    id: string;
    groupId?: string;
    [key: string]: unknown;
};

type BudgetDirectoryResolution = {
    directory: string;
    metadata: BudgetMetadata;
    metadataPath: string;
};

export class ActualApiTimeoutError extends Error {
    public constructor(operation: string, timeoutMs: number) {
        super(`Actual API operation '${operation}' timed out after ${timeoutMs}ms`);
        this.name = 'ActualApiTimeoutError';
    }
}

class ActualApi {
    protected isInitialized = false;
    private currentDataDir: string | null = null;
    private static consolePatchDepth = 0;
    private static originalConsole: null | {
        log: typeof console.log;
        info: typeof console.info;
        debug: typeof console.debug;
        warn: typeof console.warn;
    } = null;

    public constructor(
        private readonly serverConfig: ActualServerConfig,
        private readonly logger: Logger
    ) {}

    private getRequestTimeoutMs(): number {
        const ms = this.serverConfig.requestTimeoutMs;
        if (typeof ms === 'number' && ms > 0) {
            return Math.min(ms, DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS);
        }
        return FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS;
    }

    private createContextHints(additional?: string | string[]): string[] {
        const extras = Array.isArray(additional) ? additional : additional ? [additional] : [];

        return [`Server URL: ${this.serverConfig.serverUrl}`, ...extras];
    }

    private async runActualRequest<T>(
        operation: string,
        callback: () => Promise<T>,
        additionalHints?: string | string[]
    ): Promise<T> {
        const timeoutMs = this.getRequestTimeoutMs();
        const hints = this.createContextHints(additionalHints);
        const unpatch = this.patchConsole();

        try {
            return await this.withCancellableTimeout(callback, timeoutMs, operation);
        } catch (error) {
            if (error instanceof ActualApiTimeoutError) {
                this.logger.error(error.message, hints);
                throw error;
            }
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Actual API operation '${operation}' failed: ${message}`, hints);
            throw error;
        } finally {
            unpatch();
        }
    }

    private async withCancellableTimeout<T>(
        callback: () => Promise<T>,
        timeoutMs: number,
        operation: string
    ): Promise<T> {
        let timeoutId: NodeJS.Timeout | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new ActualApiTimeoutError(operation, timeoutMs));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([callback(), timeoutPromise]);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            return result;
        } catch (error) {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            throw error;
        }
    }

    public async init(customDataDir?: string): Promise<void> {
        const actualDataDir = customDataDir ?? DEFAULT_DATA_DIR;

        try {
            await fs.access(actualDataDir);
        } catch {
            await fs.mkdir(actualDataDir, { recursive: true });
        }

        await this.runActualRequest('initialize session', () =>
            actual.init({
                dataDir: actualDataDir,
                serverURL: this.serverConfig.serverUrl,
                password: this.serverConfig.serverPassword,
            })
        );

        this.isInitialized = true;
        this.currentDataDir = actualDataDir;
    }

    public async ensureInitialization(customDataDir?: string): Promise<void> {
        const desiredDataDir = customDataDir ?? this.currentDataDir ?? DEFAULT_DATA_DIR;
        if (!this.isInitialized || this.currentDataDir !== desiredDataDir) {
            if (this.isInitialized) await this.shutdown();
            await this.init(desiredDataDir);
        }
    }

    public async sync(additionalHints?: string | string[]): Promise<void> {
        await this.ensureInitialization();
        await this.runActualRequest('sync budget', () => actual.sync(), additionalHints);
    }

    public async getAccounts(): ReturnType<typeof actual.getAccounts> {
        await this.ensureInitialization();
        return await this.runActualRequest('fetch accounts', () => actual.getAccounts());
    }

    public async loadBudget(budgetId: string): Promise<void> {
        const budgetConfig = this.serverConfig.budgets.find((b) => b.syncId === budgetId);

        if (!budgetConfig) {
            throw new Error(`No budget with syncId '${budgetId}' found.`);
        }

        const budgetHints = [`Budget sync ID: ${budgetConfig.syncId}`];
        const rootDataDir = this.currentDataDir ?? DEFAULT_DATA_DIR;
        const encryptionPassword =
            budgetConfig.e2eEncryption.enabled && budgetConfig.e2eEncryption.password
                ? { password: budgetConfig.e2eEncryption.password }
                : undefined;

        // Simple budget loading - no complex retry logic
        await this.ensureInitialization(rootDataDir);

        this.logger.debug(`Downloading budget with syncId '${budgetConfig.syncId}'...`);
        await this.runActualRequest(
            `download budget '${budgetConfig.syncId}'`,
            () => actual.downloadBudget(budgetConfig.syncId, encryptionPassword),
            budgetHints
        );

        // Simple budget resolution
        const resolvedBudget = await this.resolveBudgetDataDir(budgetConfig.syncId, this.currentDataDir ?? rootDataDir);

        this.logger.debug(
            `Using budget directory: ${path.basename(resolvedBudget.directory)} for syncId ${budgetConfig.syncId}`
        );

        // Simple validation
        if (!resolvedBudget.metadata.id || resolvedBudget.metadata.groupId !== budgetConfig.syncId) {
            throw new Error(
                `Budget metadata mismatch: expected groupId '${budgetConfig.syncId}', got '${resolvedBudget.metadata.groupId}'`
            );
        }

        await this.ensureInitialization(path.dirname(resolvedBudget.directory));

        // Load and sync budget
        this.logger.debug(
            `Loading budget with syncId '${budgetConfig.syncId}' from local id '${resolvedBudget.metadata.id}'...`
        );
        await this.runActualRequest(
            `load budget '${budgetConfig.syncId}'`,
            () => actual.loadBudget(resolvedBudget.metadata.id),
            budgetHints
        );

        this.logger.debug(`Synchronizing budget with syncId '${budgetConfig.syncId}'...`);
        await this.sync(budgetHints);
    }

    public async importTransactions(
        accountId: string,
        transactions: ImportTransaction[]
    ): ReturnType<typeof actual.importTransactions> {
        await this.ensureInitialization();
        const dedupedTransactions = this.normalizeAndDeduplicateTransactions(accountId, transactions);
        return await this.runActualRequest(
            `import transactions for account '${accountId}'`,
            () => actual.importTransactions(accountId, dedupedTransactions, { defaultCleared: false }),
            [`Account ID: ${accountId}`]
        );
    }

    private normalizeAndDeduplicateTransactions(
        accountId: string,
        transactions: ImportTransaction[]
    ): ImportTransaction[] {
        return transactions.map((transaction) => this.ensureImportedId(accountId, transaction));
    }

    public async getTransactions(
        accountId: string,
        options?: { from?: Date; to?: Date }
    ): ReturnType<typeof actual.getTransactions> {
        const from = options?.from ?? new Date(2000, 0, 1);
        const to = options?.to ?? null;
        const startDate = format(from, 'yyyy-MM-dd');
        const endDate = to ? format(to, 'yyyy-MM-dd') : null;

        await this.ensureInitialization();
        return await this.runActualRequest(
            `fetch transactions for account '${accountId}'`,
            () => actual.getTransactions(accountId, startDate, endDate ?? undefined),
            [`Account ID: ${accountId}`]
        );
    }

    public async shutdown(): Promise<void> {
        if (!this.isInitialized) return;

        try {
            await this.runActualRequest('shutdown session', () => actual.shutdown());
        } finally {
            this.isInitialized = false;
            this.currentDataDir = null;
        }
    }

    private ensureImportedId(accountId: string, transaction: ImportTransaction): ImportTransaction {
        if (transaction.imported_id) {
            return transaction;
        }
        return {
            ...transaction,
            imported_id: this.createFallbackImportedId(accountId, transaction),
        };
    }

    private async resolveBudgetDataDir(syncId: string, rootDir?: string): Promise<BudgetDirectoryResolution> {
        const actualDataDir = rootDir ?? this.currentDataDir ?? DEFAULT_DATA_DIR;
        const entries = await fs.readdir(actualDataDir, { withFileTypes: true });

        for (const entry of entries.filter((e) => e.isDirectory())) {
            const metadataPath = path.join(actualDataDir, entry.name, 'metadata.json');
            try {
                const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
                    groupId?: string;
                    id?: string;
                };
                if (metadata?.groupId === syncId) {
                    return {
                        directory: path.join(actualDataDir, entry.name),
                        metadata: { ...metadata, id: metadata.id || entry.name, groupId: syncId },
                        metadataPath,
                    };
                }
            } catch {
                continue;
            }
        }
        throw new Error(`No Actual budget directory found for syncId '${syncId}' in '${actualDataDir}'`);
    }

    private createFallbackImportedId(accountId: string, transaction: ImportTransaction): string {
        const parts = {
            accountId,
            date: transaction.date ?? '',
            amount: transaction.amount ?? 0,
            payee: transaction.imported_payee ?? transaction.payee_name ?? transaction.payee ?? '',
            transfer_id: transaction.transfer_id ?? '',
            notes: transaction.notes ?? '',
        };
        const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
        return `mm-sync-${hash}`;
    }

    private patchConsole(): () => void {
        // Re-entrant console patching with depth tracking
        ActualApi.consolePatchDepth++;

        if (ActualApi.consolePatchDepth === 1) {
            // Only patch on first call - store originals in static state
            ActualApi.originalConsole = {
                log: console.log,
                info: console.info,
                debug: console.debug,
                warn: console.warn,
            };

            console.log = createConsoleInterceptor(ActualApi.originalConsole.log);
            console.info = createConsoleInterceptor(ActualApi.originalConsole.info);
            console.debug = createConsoleInterceptor(ActualApi.originalConsole.debug);
            console.warn = createConsoleInterceptor(ActualApi.originalConsole.warn);
        }

        return () => {
            // Guard against underflow
            if (ActualApi.consolePatchDepth === 0) {
                return;
            }
            ActualApi.consolePatchDepth--;

            if (ActualApi.consolePatchDepth === 0 && ActualApi.originalConsole) {
                const { log, info, debug, warn } = ActualApi.originalConsole;
                console.log = log;
                console.info = info;
                console.debug = debug;
                console.warn = warn;
                ActualApi.originalConsole = null;
            }
        };
    }
}
export default ActualApi;
