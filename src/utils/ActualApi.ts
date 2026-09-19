import fs from 'node:fs/promises';
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
import { withApiNoiseFilter } from './ActualApiLogControl.js';
import type { ActualServerConfig } from './config.js';
import type Logger from './Logger.js';
import { LogLevel } from './Logger.js';
import { DEFAULT_DATA_DIR } from './shared.js';

/**
 * Detect whether an unknown thrown value represents an Actual API
 * `file-has-reset` error.  Checks both the structured shape
 * (`reason === 'file-has-reset'`) and a message string fallback.
 */
function isActualFileHasResetError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;

    const record = error as Record<string, unknown>;

    if (record.reason === 'file-has-reset') {
        return true;
    }

    if (
        typeof record.message === 'string' &&
        record.message.toLowerCase().includes('file-has-reset')
    ) {
        return true;
    }

    return false;
}

/**
 * Build a user-facing Error for `file-has-reset` with actionable guidance.
 * The original error is preserved as `.cause` for diagnosis.
 */
function buildFileHasResetError(error: unknown): Error {
    const message = [
        'Syncing has been reset on this cloud file (reason: file-has-reset).',
        '',
        `Local cached budget data at: ${DEFAULT_DATA_DIR}`,
        "This directory is the tool's Actual cache and may contain cached data for",
        'multiple budgets. It is out of sync with the server because sync was reset',
        'from another device.',
        '',
        'Recommended action: quit this command, delete or move this cache directory,',
        'then rerun this command. The tool will download a fresh copy of the budget.',
        '',
        'Alternative: if you intentionally want the local data to become canonical,',
        "use Actual's desktop/web UI to upload that file, then rerun this command.",
        'The CLI will not upload data automatically.',
    ].join('\n');

    return new Error(message, { cause: error });
}

/**
 * Node.js network error codes that indicate the host cannot be reached at
 * the IP layer. These are the codes macOS reports when the Local Network
 * privacy setting blocks a process from reaching a host on the LAN.
 */
const UNREACHABLE_NETWORK_ERROR_CODES = new Set([
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

/** Timeout for the reachability probe run when Actual login fails. */
const SERVER_PROBE_TIMEOUT_MS = 5_000;

export type ActualServerProbeResult =
    | { reachable: true }
    | { reachable: false; code: string | null };

/**
 * Detect whether an error thrown by `@actual-app/api` represents a failed
 * login caused by the server being unreachable.
 *
 * `@actual-app/api` collapses every transport-level failure during `init()`
 * into `Error('Authentication failed: network-failure')` with
 * `code === 'network-failure'`, discarding the underlying cause.
 */
export function isActualNetworkFailureError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;

    const record = error as Record<string, unknown>;

    if (record.code === 'network-failure') {
        return true;
    }

    return (
        typeof record.message === 'string' &&
        record.message.toLowerCase().includes('network-failure')
    );
}

/**
 * Extract a machine readable network error code from a thrown fetch error.
 *
 * Handles the `error.cause.code` shape used by `node:fetch`/undici and maps
 * aborted requests to `timeout`.
 */
export function extractNetworkErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;

    const record = error as Record<string, unknown>;

    if (typeof record.code === 'string' && record.code.length > 0) {
        return record.code;
    }

    if (record.name === 'TimeoutError' || record.name === 'AbortError') {
        return 'timeout';
    }

    const cause = record.cause;
    if (typeof cause === 'object' && cause !== null) {
        const causeCode = (cause as Record<string, unknown>).code;
        if (typeof causeCode === 'string' && causeCode.length > 0) {
            return causeCode;
        }
    }

    return null;
}

/**
 * Build a user-facing Error for a failed Actual login caused by
 * `network-failure`.
 *
 * The message includes concrete diagnostics based on whether the server
 * answered a follow-up probe: an unreachable host gets connectivity advice
 * (including the macOS Local Network setting that commonly causes this),
 * while a reachable host points at the login endpoint or a reverse proxy.
 * The original error is preserved as `.cause`.
 */
export function buildActualNetworkFailureError({
    serverUrl,
    probe,
    platform,
    error,
}: {
    serverUrl: string;
    probe: ActualServerProbeResult;
    platform: string;
    error: unknown;
}): Error {
    const lines = ['Authentication failed: network-failure', ''];

    if (probe.reachable) {
        lines.push(
            `The Actual server at ${serverUrl} responded, but the login request failed.`,
            'Check that the server URL points to an Actual sync server and that a',
            'reverse proxy in front of it forwards POST /account/login instead of',
            'returning an HTML error page.'
        );
    } else {
        lines.push(
            `The Actual server at ${serverUrl} is not reachable from this process.`
        );

        if (probe.code) {
            lines.push(`Network error: ${probe.code}`);
        }

        if (
            platform === 'darwin' &&
            probe.code !== null &&
            UNREACHABLE_NETWORK_ERROR_CODES.has(probe.code)
        ) {
            lines.push(
                '',
                'On macOS this is usually the "Local Network" privacy setting blocking',
                'the Node.js process from reaching a server on the local network. Grant',
                'the terminal app access under:',
                '  System Settings → Privacy & Security → Local Network',
                'Then quit and reopen the terminal app before rerunning this command.',
                '',
                'A browser can still reach the server in this situation, so the server',
                'itself may be healthy.'
            );
        }

        lines.push(
            '',
            'Check connectivity from this terminal with:',
            `  node -e "fetch('${serverUrl}/').then(r => console.log(r.status)).catch(e => console.log(e.cause?.code ?? e.message))"`
        );
    }

    return new Error(lines.join('\n'), { cause: error });
}

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

        try {
            await this.withLogControl(async () => {
                this.actualInternal = await this.actualApi.init({
                    dataDir: actualDataDir,
                    serverURL: this.serverConfig.serverUrl,
                    password: this.serverConfig.serverPassword,
                });
            });
        } catch (error) {
            if (isActualNetworkFailureError(error)) {
                throw buildActualNetworkFailureError({
                    serverUrl: this.serverConfig.serverUrl,
                    probe: await this.probeServerReachability(),
                    platform: process.platform,
                    error,
                });
            }
            throw error;
        }

        this.isInitialized = true;
    }

    /**
     * Probe whether the configured Actual server answers at all. Used to tell
     * a blocked or unreachable host apart from a reachable server that
     * rejected the login request. Never throws.
     */
    private async probeServerReachability(): Promise<ActualServerProbeResult> {
        try {
            await this.fetchImpl(this.serverConfig.serverUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
            });
            return { reachable: true };
        } catch (error) {
            return { reachable: false, code: extractNetworkErrorCode(error) };
        }
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
            b => b.syncId === budgetId
        );

        if (!budgetConfig) {
            throw new Error(`No budget with syncId '${budgetId}' found.`);
        }

        this.logger.debug(`Loading budget with syncId ${budgetId}...`);

        try {
            await this.withLogControl(async () => {
                await this.actualApi.downloadBudget(
                    budgetConfig.syncId,
                    budgetConfig.e2eEncryption.enabled
                        ? {
                              password:
                                  budgetConfig.e2eEncryption.password ?? '',
                          }
                        : undefined
                );
            });
        } catch (error) {
            if (isActualFileHasResetError(error)) {
                throw buildFileHasResetError(error);
            }
            throw error;
        }
    }

    async importTransactions(
        accountId: string,
        transactions: ImportTransactionEntity[]
    ) {
        await this.ensureInitialization();
        return this.withLogControl(() =>
            this.actualApi.importTransactions(accountId, transactions, {
                defaultCleared: false,
            })
        );
    }

    async getTransactions(accountId: string) {
        await this.ensureInitialization();
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
        return all.filter(t => idSet.has(t.id));
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
        if (!this.isInitialized) {
            return;
        }
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

        return responseData.data.filter(f => f.deleted === 0);
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
