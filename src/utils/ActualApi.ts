import actual from '@actual-app/api';
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
import { format } from 'date-fns';
import fs from 'fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import util from 'node:util';

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
];

// Simple console filtering - no caching needed

// Legacy support removed - using regex patterns only

// Complex types removed - using simple boolean logic

// Simple console filtering - just check if message matches suppressed patterns
const shouldSuppressConsoleOutput = (args: unknown[]): boolean => {
    if (args.length === 0) return false;

    const message = util.format(...(args as [unknown, ...unknown[]]));
    return SUPPRESSED_PATTERNS.some(pattern => pattern.test(message));
};

// Simple console interceptor - just suppress or pass through
const createConsoleInterceptor = <TArgs extends unknown[]>(
    _logger: Logger,
    original: (...args: TArgs) => void
) => (...args: TArgs): void => {
    if (shouldSuppressConsoleOutput(args)) {
        // Just suppress - no complex logging logic needed
        return;
    }
    original.apply(console, args);
};

const normalizeForHash = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeForHash(item));
    }

    if (value && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>).sort(([leftKey], [rightKey]) =>
            leftKey.localeCompare(rightKey)
        );

        return sortedEntries.reduce<Record<string, unknown>>((accumulator, [key, nestedValue]) => {
            accumulator[key] = normalizeForHash(nestedValue);
            return accumulator;
        }, {});
    }

    return value;
};

const createErrorWithCause = (message: string, cause: Error): Error => {
    const ErrorCtor = Error as ErrorConstructor & {
        new (message?: string, options?: { cause?: unknown }): Error;
    };
    try {
        return new ErrorCtor(message, { cause });
    } catch {
        const fallback = new Error(message);
        (fallback as Error & { cause?: Error }).cause = cause;
        return fallback;
    }
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

    public constructor(
        private readonly serverConfig: ActualServerConfig,
        private readonly logger: Logger
    ) {}

    private getRequestTimeoutMs(): number {
        const ms = this.serverConfig.requestTimeoutMs;
        if (typeof ms === 'number') {
            if (ms > 0) {
                const cappedMs = Math.min(ms, DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS);
                if (cappedMs !== ms) {
                    this.logger.warn(`requestTimeoutMs capped at ${DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS}ms`);
                }
                return cappedMs;
            }
            this.logger.warn(`requestTimeoutMs must be > 0; falling back to ${FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS}ms`);
            return FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS;
        }
        return FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS;
    }

    private createContextHints(additional?: string | string[]): string[] {
        const extras = Array.isArray(additional) ? additional : additional ? [additional] : [];

        return [`Server URL: ${this.serverConfig.serverUrl}`, ...extras];
    }

    private isNetworkError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const { code, cause } = error as {
            code?: unknown;
            cause?: unknown;
        };

        const codeValue = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;

        const knownCodes = new Set([
            'ECONNREFUSED',
            'ECONNRESET',
            'ENOTFOUND',
            'EHOSTUNREACH',
            'ETIMEDOUT',
            'EAI_AGAIN',
        ]);

        if (codeValue && knownCodes.has(codeValue.toUpperCase())) {
            return true;
        }

        const message =
            error instanceof Error
                ? error.message
                : typeof (error as { message?: unknown }).message === 'string'
                  ? String((error as { message?: unknown }).message)
                  : '';

        if (message && /(connect\s+)?ECONNREFUSED|ECONNRESET|network\s+timeout|fetch\s+failed/i.test(message)) {
            return true;
        }

        if (cause) {
            return this.isNetworkError(cause);
        }

        return false;
    }

    private isAuthenticationError(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;

        const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message || '');
        if (/invalid\s+password|authentication\s+failed|unauthori[sz]ed/i.test(message)) {
            return true;
        }

        const details = error as { status?: unknown; response?: { status?: unknown } };
        const status = typeof details.status === 'number' ? details.status : undefined;
        const responseStatus = typeof details.response?.status === 'number' ? details.response.status : undefined;

        return status === 401 || responseStatus === 401;
    }

    private getFriendlyErrorMessage(operation: string, error: unknown): string | null {
        if (this.isNetworkError(error)) {
            return (
                'Unable to reach Actual server. ' +
                'Check your network connection and verify the Actual server is running.'
            );
        }

        if (this.isAuthenticationError(error)) {
            return (
                'Actual server rejected the provided password. ' +
                'Update the credentials in your configuration and try again.'
            );
        }

        if (!error || typeof error !== 'object') {
            return null;
        }

        if (!operation.startsWith('download budget')) {
            return null;
        }

        const details = error as {
            type?: unknown;
            reason?: unknown;
        };

        const reason = typeof details.reason === 'string' ? details.reason : '';

        if (
            details.type === 'PostError' &&
            /(^|[-\s])file[-\s]?not[-\s]?found$|group[-\s]?not[-\s]?found/i.test(reason)
        ) {
            return (
                'The Actual server could not find the requested budget file. ' +
                'Open the budget in Actual Desktop so it can re-upload the file before retrying.'
            );
        }

        return null;
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
            // Simple timeout with Promise.race
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new ActualApiTimeoutError(operation, timeoutMs));
                }, timeoutMs);
            });

            const result = await Promise.race([callback(), timeoutPromise]);
            return result;
        } catch (error) {
            if (error instanceof ActualApiTimeoutError) {
                this.logger.error(error.message, hints);
                throw error;
            }

            const friendlyMessage = this.getFriendlyErrorMessage(operation, error);
            const message = friendlyMessage || (error instanceof Error ? error.message : 'Unknown error');

            const wrappedError = error instanceof Error
                ? createErrorWithCause(`Actual API operation '${operation}' failed: ${message}`, error)
                : new Error(`Actual API operation '${operation}' failed: ${message}`);

            this.logger.error(wrappedError.message, hints);
            throw wrappedError;
        } finally {
            unpatch();
        }
    }

    public async init(customDataDir?: string): Promise<void> {
        const actualDataDir = customDataDir ?? DEFAULT_DATA_DIR;

        const dataDirExists = await fs
            .access(actualDataDir)
            .then(() => true)
            .catch(() => false);

        if (!dataDirExists) {
            await fs.mkdir(actualDataDir, { recursive: true });
            this.logger.debug(`Created Actual data directory at ${actualDataDir}`);
        }

        this.logger.debug(
            `Initializing Actual instance for server ${this.serverConfig.serverUrl} with data directory ${actualDataDir}`
        );

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

        if (!this.isInitialized) {
            await this.init(desiredDataDir);
            return;
        }

        if (this.currentDataDir !== desiredDataDir) {
            this.logger.debug(
                `Reinitialising Actual data directory: ${this.currentDataDir ?? '(none)'} -> ${desiredDataDir}`
            );
            await this.shutdown();
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

        this.logger.debug(`Using budget directory: ${path.basename(resolvedBudget.directory)} for syncId ${budgetConfig.syncId}`);

        // Simple validation
        if (!resolvedBudget.metadata.id || resolvedBudget.metadata.groupId !== budgetConfig.syncId) {
            throw new Error(`Budget metadata mismatch: expected groupId '${budgetConfig.syncId}', got '${resolvedBudget.metadata.groupId}'`);
        }

        await this.ensureInitialization(path.dirname(resolvedBudget.directory));

        // Load and sync budget
        this.logger.debug(`Loading budget with syncId '${budgetConfig.syncId}' from local id '${resolvedBudget.metadata.id}'...`);
        await this.runActualRequest(
            `load budget '${budgetConfig.syncId}'`,
            () => actual.loadBudget(resolvedBudget.metadata.id),
            budgetHints
        );

        this.logger.debug(`Synchronizing budget with syncId '${budgetConfig.syncId}'...`);
        await this.sync(budgetHints);
    }

    private async tryResolveBudgetDirectory(
        syncId: string,
        rootDir: string
    ): Promise<BudgetDirectoryResolution | null> {
        try {
            return await this.resolveBudgetDataDir(syncId, rootDir);
        } catch (error) {
            const errorLower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
            const shouldRetry = errorLower && [
                'budget directory does not exist',
                'budget-not-found',
                'no actual budget directory found',
                'not accessible',
                'enoent',
                'eisdir',
            ].some(pattern => errorLower.includes(pattern));

            if (shouldRetry) {
                return null;
            }

            if (error instanceof Error && error.message.includes('No Actual budget directory found')) {
                return null;
            }

            throw error;
        }
    }

    private async readBudgetMetadataByPath(metadataPath: string): Promise<BudgetMetadata> {
        const metadataRaw = await fs.readFile(metadataPath, 'utf8');
        const parsed = JSON.parse(metadataRaw);

        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`Budget metadata at '${metadataPath}' is not an object`);
        }

        const record = parsed as Record<string, unknown>;
        const directoryName = path.basename(path.dirname(metadataPath));
        const idRaw = record.id;
        const id = typeof idRaw === 'string' && idRaw.trim().length > 0 ? idRaw.trim() : directoryName;
        const groupIdRaw = record.groupId;
        const groupId = typeof groupIdRaw === 'string' && groupIdRaw.trim().length > 0 ? groupIdRaw.trim() : undefined;

        const metadata: BudgetMetadata = {
            ...(record as BudgetMetadata),
            id,
        };

        if (groupId) {
            metadata.groupId = groupId;
        } else {
            delete metadata.groupId;
        }

        return metadata;
    }




    private async shutdownSilently(contextHints: string[]): Promise<void> {
        try {
            await this.shutdown();
        } catch (error) {
            const hints: Array<string | Error> = [...this.createContextHints(contextHints)];
            if (error instanceof Error) {
                hints.push(error);
            } else {
                hints.push(String(error));
            }

            this.logger.warn('Failed to shutdown Actual client cleanly after budget load failure', hints);
        }
    }


    public async importTransactions(
        accountId: string,
        transactions: ImportTransaction[]
    ): ReturnType<typeof actual.importTransactions> {
        await this.ensureInitialization();
        const dedupedTransactions = this.normalizeAndDeduplicateTransactions(accountId, transactions);
        const importOptions = { defaultCleared: false };
        const removed = transactions.length - dedupedTransactions.length;
        if (removed > 0) {
            this.logger.debug(`Deduplicated ${removed} duplicate transactions before import`, [
                `Account ID: ${accountId}`,
            ]);
        }

        return await this.runActualRequest(
            `import transactions for account '${accountId}'`,
            () => actual.importTransactions(accountId, dedupedTransactions, importOptions),
            [`Account ID: ${accountId}`]
        );
    }

    private normalizeAndDeduplicateTransactions(
        accountId: string,
        transactions: ImportTransaction[]
    ): ImportTransaction[] {
        const dedupedTransactions: ImportTransaction[] = [];
        const seenImportedIds = new Set<string>();

        for (const transaction of transactions) {
            const normalized = this.ensureImportedId(accountId, transaction);
            const importedId = normalized.imported_id;

            if (importedId && seenImportedIds.has(importedId)) {
                continue;
            }

            if (importedId) {
                seenImportedIds.add(importedId);
            }

            dedupedTransactions.push(normalized);
        }

        return dedupedTransactions;
    }

    public async getTransactions(
        accountId: string,
        options?: { from?: Date; to?: Date }
    ): ReturnType<typeof actual.getTransactions> {
        let from = options?.from ?? new Date(2000, 0, 1);
        let to = options?.to ?? null;
        if (to && from > to) {
            [from, to] = [to, from];
        }
        const startDate = format(from, 'yyyy-MM-dd');
        const endDate = to ? format(to, 'yyyy-MM-dd') : null;

        await this.ensureInitialization();
        const rangeHint = endDate ? `Date range: ${startDate} – ${endDate}` : `Date range: ${startDate} onwards`;

        return await this.runActualRequest(
            `fetch transactions for account '${accountId}'`,
            () =>
                endDate
                    ? actual.getTransactions(accountId, startDate, endDate)
                    : actual.getTransactions(accountId, startDate),
            [`Account ID: ${accountId}`, rangeHint]
        );
    }

    public async shutdown(): Promise<void> {
        if (!this.isInitialized) {
            return;
        }

        try {
            await this.runActualRequest('shutdown session', async () => {
                try {
                    await actual.shutdown();
                } catch (error) {
                    if (error instanceof TypeError && error.message.includes("Cannot read properties of null (reading 'prepare')")) {
                        const hints: Array<string | Error> = [
                            ...this.createContextHints('Operation: shutdown session'),
                        ];
                        if (error instanceof Error) {
                            hints.push(error);
                        } else {
                            hints.push(String(error));
                        }

                        this.logger.warn(
                            'Actual client shutdown completed despite a missing database connection',
                            hints
                        );
                        return;
                    }

                    throw error;
                }
            });
        } finally {
            this.isInitialized = false;
            this.currentDataDir = null;
        }
    }

    private static suppressDepth = 0;
    private static originals: {
        log: typeof console.log;
        info: typeof console.info;
        debug: typeof console.debug;
        warn: typeof console.warn;
    } | null = null;

    private ensureImportedId(accountId: string, transaction: ImportTransaction): ImportTransaction {
        const importedId = transaction.imported_id;

        if (typeof importedId === 'string') {
            const trimmedImportedId = importedId.trim();

            if (trimmedImportedId.length > 0) {
                if (trimmedImportedId === importedId) {
                    return transaction;
                }

                return {
                    ...transaction,
                    imported_id: trimmedImportedId,
                };
            }
        }

        return {
            ...transaction,
            imported_id: this.createFallbackImportedId(accountId, transaction),
        };
    }


    private async resolveBudgetDataDir(
        syncId: string,
        rootDir?: string
    ): Promise<BudgetDirectoryResolution> {
        const actualDataDir = rootDir ?? this.currentDataDir ?? DEFAULT_DATA_DIR;

        const entries = await fs.readdir(actualDataDir, { withFileTypes: true });
        const dirs = entries.filter(entry => entry.isDirectory());

        for (const entry of dirs) {
            const metadataPath = path.join(actualDataDir, entry.name, 'metadata.json');

            try {
                const metadataRaw = await fs.readFile(metadataPath, 'utf8');
                const parsed = JSON.parse(metadataRaw);

                if (parsed?.groupId === syncId) {
                    const resolvedDir = path.join(actualDataDir, entry.name);
                    const metadata: BudgetMetadata = {
                        ...(parsed as BudgetMetadata),
                        id: parsed.id || entry.name,
                        groupId: syncId,
                    };

                    return {
                        directory: resolvedDir,
                        metadata,
                        metadataPath,
                    };
                }
            } catch {
                // Skip invalid metadata files
                continue;
            }
        }

        throw new Error(`No Actual budget directory found for syncId '${syncId}' in '${actualDataDir}'`);
    }

    private createFallbackImportedId(accountId: string, transaction: ImportTransaction): string {
        const payeeId = (transaction as { payee_id?: string }).payee_id ?? '';
        const payee = (transaction as { payee?: string }).payee ?? '';
        const rawSubtransactions = (
            transaction as {
                subtransactions?: unknown;
            }
        ).subtransactions;
        const normalizedSubtransactions = Array.isArray(rawSubtransactions)
            ? (normalizeForHash(rawSubtransactions) as unknown[])
            : [];

        const normalized = {
            accountId,
            date: transaction.date,
            amount: transaction.amount,
            imported_payee: (transaction as { imported_payee?: string }).imported_payee ?? '',
            category: (transaction as { category?: string }).category ?? '',
            notes: transaction.notes ?? '',
            transfer_id: (transaction as { transfer_id?: string }).transfer_id ?? '',
            cleared: typeof transaction.cleared === 'boolean' ? String(transaction.cleared) : '',
            payee_id: payeeId,
            payee,
            subtransactions: normalizedSubtransactions,
        };

        const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

        return `mm-sync-${hash}`;
    }

    private patchConsole(): () => void {
        // Simple console patching - just suppress common Actual SDK noise
        if (ActualApi.suppressDepth === 0) {
            ActualApi.originals = {
                log: console.log,
                info: console.info,
                debug: console.debug,
                warn: console.warn,
            };

            const originals = ActualApi.originals;
            console.log = createConsoleInterceptor(this.logger, originals.log);
            console.info = createConsoleInterceptor(this.logger, originals.info);
            console.debug = createConsoleInterceptor(this.logger, originals.debug);
            console.warn = createConsoleInterceptor(this.logger, originals.warn);
        }

        ActualApi.suppressDepth++;
        return () => {
            ActualApi.suppressDepth--;
            if (ActualApi.suppressDepth === 0 && ActualApi.originals) {
                console.log = ActualApi.originals.log;
                console.info = ActualApi.originals.info;
                console.debug = ActualApi.originals.debug;
                console.warn = ActualApi.originals.warn;
                ActualApi.originals = null;
            }
        };
    }
}

export default ActualApi;
