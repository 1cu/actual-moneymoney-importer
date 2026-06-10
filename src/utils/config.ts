import fs from 'fs/promises';
import path from 'path';
import toml from 'toml';
import { ArgumentsCamelCase } from 'yargs';
import { CommonArgs } from './cliArgs.js';
import { z, ZodError } from 'zod';
import { DEFAULT_CONFIG_FILE } from './shared.js';

const WHOLE_VALUE_ENV_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Error thrown when an environment variable referenced in the config is
 * not set. Distinct from other config errors so callers can surface the
 * specific variable name.
 */
export class EnvVarResolutionError extends Error {
    constructor(varName: string) {
        super(
            `Environment variable '${varName}' referenced in config but not set`
        );
        this.name = 'EnvVarResolutionError';
    }
}

/**
 * Recursively walk a parsed config object. When a string value is exactly
 * `\${ENV_VAR}`, replace it with the corresponding environment variable.
 *
 * Strings that contain `\${...}` as partial content are left unchanged;
 * only whole-value references are resolved.
 *
 * Throws {@link EnvVarResolutionError} if a referenced environment
 * variable is not set.
 */
export const resolveEnvVars = (obj: unknown): unknown => {
    if (typeof obj === 'string') {
        const match = obj.match(WHOLE_VALUE_ENV_PATTERN);
        if (match) {
            const varName = match[1] as string;
            const value = process.env[varName];
            if (value === undefined) {
                throw new EnvVarResolutionError(varName);
            }
            return value;
        }
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(resolveEnvVars);
    }
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(
            obj as Record<string, unknown>
        )) {
            result[key] = resolveEnvVars(value);
        }
        return result;
    }
    return obj;
};

const isValidCalendarDate = (dateString: string) => {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dateRegex.test(dateString)) {
        return false;
    }

    const [yearString, monthString, dayString] = dateString.split('-');
    const year = Number(yearString);
    const month = Number(monthString);
    const day = Number(dayString);

    const parsedDate = new Date(Date.UTC(year, month - 1, day));

    return (
        parsedDate.getUTCFullYear() === year &&
        parsedDate.getUTCMonth() === month - 1 &&
        parsedDate.getUTCDate() === day
    );
};

const budgetSchema = z
    .object({
        syncId: z.string(),
        earliestImportDate: z.string().optional(),
        e2eEncryption: z.strictObject({
            enabled: z.boolean(),
            password: z.string().optional(),
        }),
        accountMapping: z.record(z.string(), z.string()),
        categoryMapping: z.record(z.string(), z.string()).optional(),
        /**
         * MoneyMoney category refs to intentionally leave unmapped.
         *
         * Categories listed here will not appear as "unresolved" in the
         * mapping report. Use this for transfer categories or categories
         * that should never receive category assignments.
         *
         * Accepts "path:"-prefixed refs (e.g. "path:Umbuchungen > Echte
         * Umbuchungen"), bare paths, bare UUIDs, or leaf names.
         */
        ignoredMoneyMoneyCategoryRefs: z.array(z.string()).default([]),
    })
    .check((payload) => {
        if (
            payload.value.e2eEncryption.enabled &&
            !payload.value.e2eEncryption.password
        ) {
            payload.issues.push({
                code: 'custom',
                message:
                    'Password must not be empty if end-to-end encryption is enabled',
                input: payload.value,
                continue: true,
            });
        }

        if (payload.value.earliestImportDate) {
            if (!isValidCalendarDate(payload.value.earliestImportDate)) {
                payload.issues.push({
                    code: 'custom',
                    path: ['earliestImportDate'],
                    message:
                        'Invalid earliest import date (required format is YYYY-MM-DD and must be a real calendar date)',
                    input: payload.value,
                    continue: true,
                });
            }
        }
    });

const actualServerSchema = z.object({
    serverUrl: z.string().url(),
    serverPassword: z.string(),
    budgets: z.array(budgetSchema).min(1),
});

const payeeTransformationSchema = z.object({
    enabled: z.boolean(),
    backend: z
        .enum(['openai', 'apple-intelligence'])
        .optional()
        .default('openai'),
    openAiApiKey: z.string().optional(),
    openAiModel: z.string().optional().default('gpt-5.4-nano'),
    temperature: z.number().min(0).max(2).optional().default(0),
    onTransformError: z.enum(['warn', 'fail']).optional().default('warn'),
    prompt: z.string().optional(),
    /**
     * Maximum number of existing payees included in the AI prompt.
     *
     * The importer selects the existing budget payees most similar to the
     * unresolved raw payee names (by Dice bigram coefficient) and includes
     * them in the prompt so the model can prefer exact matches. Higher
     * values give the model more context but increase prompt size and
     * token usage. Set to 0 to omit existing payees entirely.
     *
     * @default 100
     */
    maxExistingPayeesInPrompt: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(100),
    /**
     * Dice bigram coefficient threshold for snapping a payee to an
     * existing budget payee. Applied both before the AI call (local
     * pre-filter) and after (post-AI snap-back).
     *
     * 1.0 = exact match only (after normalization: unicode NFKD,
     * lowercase, strip non-alphanumeric). 0.0 = match anything.
     *
     * Lower values catch more partial-name matches (e.g. "Munch Energie
     * GmbH" → "Munch Energie" at ~0.73) but may produce false snaps on
     * short, generic names. Values below 0.6 are rarely useful.
     *
     * @default 0.7
     */
    payeeMatchThreshold: z.number().min(0).max(1).optional().default(0.7),
});

const transferImportSchema = z.object({
    enabled: z.boolean().default(false),
    categoryRefs: z.array(z.string()).default([]),
    matchWindowDays: z.number().int().nonnegative().default(0),
});
const defaultTransferImportConfig = transferImportSchema.parse({});

/**
 * Resolve the effective category sync policy from config.
 *
 * Prefers the new unified `categorySync` field when present. Falls back to
 * deriving from the legacy `synchronizeCategories` and
 * `categorySyncOnExisting` fields for backward compatibility.
 *
 * Legacy `ask` policy is treated as `new` (sync only new imports; never
 * overwrite existing transactions without explicit user action).
 */
export const resolveCategorySyncPolicy = (
    imp: z.infer<typeof importSchema>
): 'off' | 'new' | 'all' => {
    if (imp.categorySync !== undefined) {
        return imp.categorySync;
    }
    // Derive from legacy fields for backward compat
    if (!imp.synchronizeCategories) {
        return 'off';
    }
    switch (imp.categorySyncOnExisting) {
        case 'always':
            return 'all';
        default:
            // 'ask' and 'new' both map to 'new'
            return 'new';
    }
};

const importSchema = z.object({
    importUncheckedTransactions: z.boolean(),
    synchronizeClearedStatus: z.boolean().default(true),
    /**
     * Legacy: replaced by `categorySync`.
     * @deprecated Use `categorySync` instead.
     */
    synchronizeCategories: z.boolean().default(false),
    /**
     * Legacy: replaced by `categorySync`.
     * @deprecated Use `categorySync` instead.
     */
    categorySyncOnExisting: z.enum(['ask', 'new', 'always']).default('ask'),
    /**
     * Unified category sync policy controlling both new imports and
     * existing transactions.
     *
     * - `off`: never apply category mappings
     * - `new`: apply category mappings to newly imported transactions only
     * - `all`: also update previously imported transactions
     */
    categorySync: z.enum(['off', 'new', 'all']).optional(),
    importComments: z.boolean().default(false),
    commentPrefix: z.string().default('MoneyMoney Comment: '),
    transfers: transferImportSchema.default(defaultTransferImportConfig),
    ignorePatterns: z
        .object({
            commentPatterns: z.array(z.string()).optional(),
            payeePatterns: z.array(z.string()).optional(),
            purposePatterns: z.array(z.string()).optional(),
        })
        .optional(),
});

export const configSchema = z
    .object({
        payeeTransformation: payeeTransformationSchema,
        import: importSchema,
        actualServers: z.array(actualServerSchema).min(1),
    })
    .check((payload) => {
        // Check OpenAI key if payeeTransformation is enabled and using OpenAI backend
        if (
            payload.value.payeeTransformation.enabled &&
            payload.value.payeeTransformation.backend === 'openai'
        ) {
            const apiKey = payload.value.payeeTransformation.openAiApiKey;
            if (!apiKey || apiKey.trim().length === 0) {
                payload.issues.push({
                    code: 'custom',
                    path: ['payeeTransformation', 'openAiApiKey'],
                    message:
                        'OpenAI key must not be empty if payeeTransformation is enabled with the openai backend',
                    input: payload.value,
                    continue: true,
                });
            }
        }

        if (
            payload.value.import.transfers.enabled &&
            payload.value.import.transfers.categoryRefs.length === 0
        ) {
            payload.issues.push({
                code: 'custom',
                message:
                    'At least one transfer category ref must be configured if automatic transfers are enabled',
                path: ['import', 'transfers', 'categoryRefs'],
                input: payload.value,
                continue: true,
            });
        }
    });

export type PayeeTransformationConfig = z.infer<
    typeof payeeTransformationSchema
>;
export type ActualServerConfig = z.infer<typeof actualServerSchema>;
export type ActualBudgetConfig = z.infer<typeof budgetSchema>;
export type Config = z.infer<typeof configSchema>;

const isLocalhostServerUrl = (serverUrl: string) => {
    try {
        const url = new URL(serverUrl);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');

        return (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1'
        );
    } catch {
        return false;
    }
};

export const warnOnCleartextActualServers = (
    actualServers: ActualServerConfig[]
) => {
    for (const server of actualServers) {
        try {
            const url = new URL(server.serverUrl);
            if (url.protocol === 'http:' && !isLocalhostServerUrl(url.href)) {
                console.error(
                    `WARNING: Actual server '${server.serverUrl}' uses cleartext HTTP. Server passwords will be sent in plain text. Use HTTPS instead.`
                );
            }
        } catch {
            continue;
        }
    }
};

export const parseConfigData = (configData: unknown): Config => {
    const config = configSchema.parse(configData);

    warnOnCleartextActualServers(config.actualServers);

    return config;
};

/**
 * Parse a TOML config string into a validated {@link Config}, including
 * environment variable resolution.
 *
 * This is the canonical parsing pipeline used by both `getConfig` and
 * the `validate` command. It performs:
 *
 * 1. TOML parsing
 * 2. Environment variable interpolation ({@link resolveEnvVars})
 * 3. Zod schema validation + cleartext server warnings
 */
export const parseConfigContent = (configContent: string): Config => {
    const configData = resolveEnvVars(toml.parse(configContent));
    return parseConfigData(configData);
};

export const getConfigFile = (argv: ArgumentsCamelCase<CommonArgs>) => {
    if (argv.config) {
        const argvConfigFile = path.resolve(argv.config);
        return argvConfigFile;
    }

    return DEFAULT_CONFIG_FILE;
};

export const getConfig = async (argv: ArgumentsCamelCase<CommonArgs>) => {
    const configFile = getConfigFile(argv);

    const configFileExists = await fs
        .access(configFile)
        .then(() => true)
        .catch(() => false);

    if (!configFileExists) {
        throw new Error(
            `Config file not found: '${configFile}'. Create it or use the --config option to specify a different path.`
        );
    }

    const configContent = await fs.readFile(configFile, 'utf-8');

    try {
        return parseConfigContent(configContent);
    } catch (e) {
        if (e instanceof Error && e.name === 'SyntaxError') {
            const line = 'line' in e ? e.line : -1;
            const column = 'column' in e ? e.column : -1;

            throw new Error(
                `Failed to parse configuration file: ${e.message} (line ${line}, column ${column})`,
                { cause: e }
            );
        }

        // Let environment variable resolution errors pass through with
        // their original message.
        if (e instanceof EnvVarResolutionError) {
            throw e;
        }

        if (e instanceof ZodError) {
            const issues = e.issues
                .map((issue) => {
                    const pathLabel =
                        issue.path.length > 0 ? issue.path.join('.') : '(root)';

                    return `- ${pathLabel}: ${issue.message}`;
                })
                .join('\n');

            throw new Error(`Invalid configuration file:\n${issues}`, {
                cause: e,
            });
        }

        throw new Error(
            `Invalid configuration file format. Run 'validate' to see errors.`,
            {
                cause: e,
            }
        );
    }
};
