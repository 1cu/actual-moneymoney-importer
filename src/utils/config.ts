import fs from 'fs/promises';
import path from 'path';
import toml from 'toml';
import { ArgumentsCamelCase } from 'yargs';
import { CommonArgs } from './cliArgs.js';
import { z } from 'zod';
import { DEFAULT_CONFIG_FILE } from './shared.js';

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
        e2eEncryption: z.object({
            enabled: z.boolean(),
            password: z.string().optional(),
        }),
        accountMapping: z.record(z.string(), z.string()),
        categoryMapping: z.record(z.string(), z.string()).optional(),
    })
    .superRefine((val, ctx) => {
        if (val.e2eEncryption.enabled && !val.e2eEncryption.password) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'Password must not be empty if end-to-end encryption is enabled',
            });
        }

        if (val.earliestImportDate) {
            if (!isValidCalendarDate(val.earliestImportDate)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['earliestImportDate'],
                    message:
                        'Invalid earliest import date (required format is YYYY-MM-DD and must be a real calendar date)',
                });
            }
        }
    });

const actualServerSchema = z.object({
    serverUrl: z.string(),
    serverPassword: z.string(),
    budgets: z.array(budgetSchema).min(1),
});

const payeeTransformationSchema = z.object({
    enabled: z.boolean(),
    openAiApiKey: z.string().optional(),
    openAiModel: z.string().optional().default('gpt-5-nano'),
    temperature: z.number().min(0).max(2).optional().default(1),
    onTransformError: z.enum(['warn', 'fail']).optional().default('warn'),
    prompt: z.string().optional(),
});

const transferImportSchema = z.object({
    enabled: z.boolean().default(false),
    categoryRefs: z.array(z.string()).default([]),
    matchWindowDays: z.number().int().nonnegative().default(0),
});
const defaultTransferImportConfig = transferImportSchema.parse({});

export const configSchema = z
    .object({
        payeeTransformation: payeeTransformationSchema,
        import: z.object({
            importUncheckedTransactions: z.boolean(),
            synchronizeClearedStatus: z.boolean().default(true),
            synchronizeCategories: z.boolean().default(false),
            categorySyncOnExisting: z
                .enum(['ask', 'new', 'always'])
                .default('ask'),
            importComments: z.boolean().default(false),
            commentPrefix: z.string().default('MoneyMoney Comment: '),
            transfers: transferImportSchema.default(
                defaultTransferImportConfig
            ),
            ignorePatterns: z
                .object({
                    commentPatterns: z.array(z.string()).optional(),
                    payeePatterns: z.array(z.string()).optional(),
                    purposePatterns: z.array(z.string()).optional(),
                })
                .optional(),
        }),
        actualServers: z.array(actualServerSchema).min(1),
    })
    .superRefine((val, ctx) => {
        // Check openAI key if payeeTransformation is enabled
        if (
            val.payeeTransformation.enabled &&
            !val.payeeTransformation.openAiApiKey
        ) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'OpenAI key must not be empty if payeeTransformation is enabled',
            });
        }

        if (
            val.import.transfers.enabled &&
            val.import.transfers.categoryRefs.length === 0
        ) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'At least one transfer category ref must be configured if automatic transfers are enabled',
                path: ['import', 'transfers', 'categoryRefs'],
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
        const configData = toml.parse(configContent);
        return parseConfigData(configData);
    } catch (e) {
        if (e instanceof Error && e.name === 'SyntaxError') {
            const line = 'line' in e ? e.line : -1;
            const column = 'column' in e ? e.column : -1;

            throw new Error(
                `Failed to parse configuration file: ${e.message} (line ${line}, column ${column})`,
                { cause: e }
            );
        }

        if (e instanceof z.ZodError) {
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
