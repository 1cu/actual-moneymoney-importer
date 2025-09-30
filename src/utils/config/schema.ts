import { formatISO, isValid as isValidDate, parseISO } from 'date-fns';
import { ZodIssueCode, z } from 'zod';

const trimmedNonEmptyString = (message: string) => z.string().trim().min(1, message);

const isoDateSchema = z
    .string()
    .trim()
    .superRefine((value, ctx) => {
        const parsed = parseISO(value);

        if (!isValidDate(parsed)) {
            ctx.addIssue({
                code: ZodIssueCode.custom,
                message: 'Invalid earliest import date. Provide a valid ISO 8601 date (YYYY-MM-DD).',
            });
            return;
        }

        const canonical = formatISO(parsed, { representation: 'date' });
        if (canonical !== value) {
            ctx.addIssue({
                code: ZodIssueCode.custom,
                message: 'Invalid earliest import date. Provide a valid ISO 8601 date (YYYY-MM-DD).',
            });
        }
    });

export const DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS = 300_000;
export const FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS = 45_000;

const budgetSchema = z
    .object({
        syncId: trimmedNonEmptyString('Sync ID must not be empty'),
        earliestImportDate: isoDateSchema.optional(),
        e2eEncryption: z.object({
            enabled: z.boolean(),
            password: z.string().trim().optional(),
        }),
        accountMapping: z.record(z.string(), z.string()),
    })
    .superRefine((val, ctx) => {
        if (val.e2eEncryption.enabled && !val.e2eEncryption.password) {
            ctx.addIssue({
                code: ZodIssueCode.custom,
                message: 'Password must not be empty if end-to-end encryption is enabled',
                path: ['e2eEncryption', 'password'],
            });
        }
    });

const actualServerSchema = z.object({
    serverUrl: z.string().trim().url(),
    serverPassword: trimmedNonEmptyString('Server password must not be empty'),
    requestTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS, 'Actual server timeout must be 5 minutes (300000 ms) or less')
        .default(FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS),
    budgets: z.array(budgetSchema).min(1),
});

const payeeTransformationSchema = z.object({
    enabled: z.boolean(),
    openAiApiKey: trimmedNonEmptyString('OpenAI API key must not be empty').optional(),
    openAiModel: z.string().trim().optional().default('gpt-3.5-turbo'),
    skipModelValidation: z.boolean().default(false),
    maskPayeeNamesInLogs: z.boolean().default(true),
    customPrompt: z.string().optional(),
    modelConfig: z
        .object({
            temperature: z.number().min(0).max(2).optional(),
            maxTokens: z.number().positive().int().optional(),
            timeout: z.number().positive().int().optional(),
        })
        .optional(),
});

export const configSchema = z
    .object({
        payeeTransformation: payeeTransformationSchema,
        import: z.object({
            importUncheckedTransactions: z.boolean(),
            synchronizeClearedStatus: z.boolean().default(true),
            maskPayeeNamesInLogs: z.boolean().default(false),
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
        if (val.payeeTransformation.enabled && !val.payeeTransformation.openAiApiKey) {
            ctx.addIssue({
                code: ZodIssueCode.custom,
                message: 'OpenAI key must not be empty if payeeTransformation is enabled',
                path: ['payeeTransformation', 'openAiApiKey'],
            });
        }
    });

export type PayeeTransformationConfig = z.infer<typeof payeeTransformationSchema>;
export type ActualServerConfig = z.infer<typeof actualServerSchema>;
export type ActualBudgetConfig = z.infer<typeof budgetSchema>;
export type Config = z.infer<typeof configSchema>;
