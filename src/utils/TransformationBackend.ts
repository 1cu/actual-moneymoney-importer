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

/**
 * Flat payee map schema used by the Apple Intelligence backend.
 *
 * The on-device model's `respondWithJsonSchema` hangs with nested schemas
 * (e.g., `{ mappings: [{ rawPayee, cleanedPayee }] }`). A flat record
 * schema avoids this. OpenAI's strict structured output requires the
 * nested version above.
 */
const FlatPayeeMapSchema = z.record(z.string(), z.string());

/**
 * Flat JSON schema matching FlatPayeeMapSchema. Used as the
 * `jsonSchema` argument for Apple's `respondWithJsonSchema`.
 */
const PAYEE_MAP_JSON_SCHEMA = {
    type: 'object' as const,
    additionalProperties: { type: 'string' as const },
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
    // Lazy-initialised: model is created once and reused across calls.

    private _sdkPromise?:
        | Promise<{
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              SystemLanguageModel: any;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              LanguageModelSession: any;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              model: any;
          }>
        | undefined;

    constructor(_config: PayeeTransformationConfig) {
        // No API key needed – on-device processing
    }

    private async _getSdk() {
        if (!this._sdkPromise) {
            this._sdkPromise = this._initSdk();
        }
        return this._sdkPromise;
    }

    private async _initSdk() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let SystemLanguageModel: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let LanguageModelSession: any;

        try {
            const mod = await import('tsfm-sdk');
            SystemLanguageModel = mod.SystemLanguageModel;
            LanguageModelSession = mod.LanguageModelSession;
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
        let model: any;

        try {
            model = new SystemLanguageModel({ guardrails: 1 });
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

        return { SystemLanguageModel, LanguageModelSession, model };
    }

    async transformPayees(
        prompt: string,
        payees: string[],
        temperature: number
    ): Promise<Record<string, string>> {
        const { LanguageModelSession, model } = await this._getSdk();

        const session = new LanguageModelSession({
            instructions: prompt,
            model,
        });

        try {
            const content = await session.respondWithJsonSchema(
                payees.join('\n'),
                PAYEE_MAP_JSON_SCHEMA,
                { options: { temperature } }
            );

            let json: unknown;
            try {
                json = JSON.parse(content.toJson());
            } catch {
                throw new Error(
                    'Apple Intelligence returned invalid JSON. Raw response: ' +
                        content.toJson().slice(0, 200)
                );
            }

            const validationResult = FlatPayeeMapSchema.safeParse(json);
            if (!validationResult.success) {
                throw new Error(
                    'Apple Intelligence returned unexpected response format: ' +
                        validationResult.error.message
                );
            }

            return validationResult.data;
        } finally {
            session.dispose();
        }
    }

    getLabel(): string {
        return 'Apple Intelligence (on-device)';
    }

    /** Release the underlying on-device model. Safe to call multiple times. */
    async dispose() {
        if (this._sdkPromise) {
            try {
                const { model } = await this._sdkPromise;
                model?.dispose?.();
            } catch {
                // Best effort — the model may already be gone
            }
            this._sdkPromise = undefined;
        }
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
