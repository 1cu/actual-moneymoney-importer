/**
 * Payee transformation backends.
 *
 * This importer is **macOS-only**. It depends on the `moneymoney` npm package
 * which requires macOS with MoneyMoney.app installed and unlocked.
 *
 * ## Backends
 *
 * - **openai** (default): Cloud-based; requires an OpenAI API key.
 * - **apple-intelligence**: On-device processing via Apple's Foundation Models.
 *   Requires macOS 26+ (Tahoe), Apple Silicon (M1 or later), Apple Intelligence
 *   enabled in System Settings, and the `tsfm-sdk` npm package installed.
 *
 * Apple Intelligence processes all data locally. No API key or network call is
 * needed beyond the initial `tsfm-sdk` install.
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { PayeeTransformationConfig } from './config.js';

export const PayeeMapSchema = z.object({
    mappings: z.array(
        z.object({
            rawPayee: z.string(),
            cleanedPayee: z.string(),
        })
    ),
});

const PAYEE_MAP_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {
        mappings: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    rawPayee: { type: 'string' as const },
                    cleanedPayee: { type: 'string' as const },
                },
                required: ['rawPayee', 'cleanedPayee'],
            },
        },
    },
    required: ['mappings'],
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const mappingsToRecord = (
    mappings: Array<{ rawPayee: string; cleanedPayee: string }>
): Record<string, string> =>
    Object.fromEntries(mappings.map((m) => [m.rawPayee, m.cleanedPayee]));

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface TransformationBackend {
    /**
     * Transform payee names. Takes raw payee strings and returns cleaned names.
     * @throws On API/network errors
     */
    transformPayees(
        prompt: string,
        payees: string[],
        temperature: number
    ): Promise<Record<string, string>>;

    /** Human-readable label for logging (e.g., model name) */
    getLabel(): string;

    /** Check if error indicates the model is unavailable / doesn't exist */
    isModelUnavailableError(error: Error): boolean;

    /** Check if error indicates a temperature incompatibility */
    isTemperatureError(error: Error): boolean;
}

// ---------------------------------------------------------------------------
// OpenAI backend
// ---------------------------------------------------------------------------

export class OpenAIBackend implements TransformationBackend {
    private client: OpenAI;
    private model: string;

    constructor(config: PayeeTransformationConfig, client?: OpenAI) {
        if (!config.openAiApiKey) {
            throw new Error(
                'An OpenAI API key is required for payee transformation with the OpenAI backend. Please set the key in the configuration file.'
            );
        }
        this.client = client ?? new OpenAI({ apiKey: config.openAiApiKey });
        this.model = config.openAiModel;
    }

    async transformPayees(
        prompt: string,
        payees: string[],
        temperature: number
    ): Promise<Record<string, string>> {
        const completion = await this.client.chat.completions.parse({
            model: this.model,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: payees.join('\n') },
            ],
            response_format: zodResponseFormat(PayeeMapSchema, 'payee_map'),
            temperature,
        });

        const parsed = completion.choices[0]?.message?.parsed;
        if (!parsed) {
            throw new Error('OpenAI returned no payee transformation result');
        }

        return mappingsToRecord(parsed.mappings);
    }

    getLabel(): string {
        return this.model;
    }

    isModelUnavailableError(error: Error): boolean {
        const message = error.message.toLowerCase();
        return (
            message.includes('model') &&
            (message.includes('does not exist') ||
                message.includes('not found') ||
                message.includes('invalid model') ||
                message.includes('unknown model'))
        );
    }

    isTemperatureError(error: Error): boolean {
        return (
            error.message.includes('temperature') &&
            error.message.includes('does not support')
        );
    }
}

// ---------------------------------------------------------------------------
// Apple Intelligence backend
// ---------------------------------------------------------------------------

export class AppleIntelligenceBackend implements TransformationBackend {
    constructor(_config: PayeeTransformationConfig) {
        // No API key needed – on-device processing
    }

    async transformPayees(
        prompt: string,
        payees: string[],
        temperature: number
    ): Promise<Record<string, string>> {
        // Dynamic import so tsfm-sdk is only loaded when this backend is used.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let Client: any;

        try {
            const mod: { default: unknown } = await import('tsfm-sdk/chat');
            Client = mod.default;
        } catch (importError) {
            const cause =
                importError instanceof Error
                    ? importError.message
                    : String(importError);
            throw new Error(
                'Apple Intelligence backend requires the `tsfm-sdk` npm package.\n' +
                    'Run: npm install tsfm-sdk\n' +
                    `Import error: ${cause}`,
                { cause: importError }
            );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let client: any;

        try {
            client = new Client();
        } catch (clientError) {
            const cause =
                clientError instanceof Error
                    ? clientError.message
                    : String(clientError);
            throw new Error(
                'Apple Intelligence backend is unavailable.\n' +
                    'Requires macOS 26+ (Tahoe) with Apple Silicon and Apple Intelligence enabled in System Settings.\n' +
                    `Initialization error: ${cause}`,
                { cause: clientError }
            );
        }

        try {
            const completion = (await client.chat.completions.create({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: payees.join('\n') },
                ],
                response_format: {
                    type: 'json_schema' as const,
                    json_schema: {
                        name: 'payee_map',
                        schema: PAYEE_MAP_JSON_SCHEMA,
                    },
                },
                temperature,
            })) as {
                choices: Array<{
                    message?: { content?: string | null };
                }>;
            };

            const content = completion.choices[0]?.message?.content;
            if (!content) {
                throw new Error(
                    'Apple Intelligence returned no payee transformation result'
                );
            }

            let json: unknown;
            try {
                json = JSON.parse(content);
            } catch {
                throw new Error(
                    'Apple Intelligence returned invalid JSON. Raw response: ' +
                        content.slice(0, 200)
                );
            }

            const validationResult = PayeeMapSchema.safeParse(json);
            if (!validationResult.success) {
                throw new Error(
                    'Apple Intelligence returned unexpected response format: ' +
                        validationResult.error.message
                );
            }

            return mappingsToRecord(validationResult.data.mappings);
        } finally {
            client?.close();
        }
    }

    getLabel(): string {
        return 'Apple Intelligence (on-device)';
    }

    isModelUnavailableError(error: Error): boolean {
        if (error.constructor?.name === 'ModelNotReadyError') {
            return true;
        }
        const message = error.message.toLowerCase();
        return (
            (message.includes('apple intelligence') &&
                (message.includes('not available') ||
                    message.includes('not ready') ||
                    message.includes('not enabled'))) ||
            message.includes('unavailable')
        );
    }

    isTemperatureError(_error: Error): boolean {
        // Apple's on-device model doesn't reject temperature values
        return false;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createTransformationBackend = (
    config: PayeeTransformationConfig
): TransformationBackend => {
    if (config.backend === 'apple-intelligence') {
        return new AppleIntelligenceBackend(config);
    }

    return new OpenAIBackend(config);
};
