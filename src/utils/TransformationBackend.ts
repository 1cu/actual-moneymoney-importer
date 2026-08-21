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
import type { PayeeTransformationConfig } from './config.js';

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
 * Build the closed JSON schema used by Apple's `respondWithJsonSchema`.
 *
 * Foundation Models requires `additionalProperties` to be a boolean. Defining
 * each raw payee as a property preserves the flat response format while
 * allowing the model to return only the exact input keys.
 */
export const buildApplePayeeMapJsonSchema = (payees: string[]) => {
    const uniquePayees = [...new Set(payees)];

    return {
        type: 'object' as const,
        properties: Object.fromEntries(
            uniquePayees.map(payee => [payee, { type: 'string' as const }])
        ),
        required: uniquePayees,
        additionalProperties: false,
    };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const mappingsToRecord = (
    mappings: Array<{ rawPayee: string; cleanedPayee: string }>
): Record<string, string> =>
    Object.fromEntries(mappings.map(m => [m.rawPayee, m.cleanedPayee]));

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

    /**
     * Backend-specific JSON format examples for the AI prompt.
     * Each backend enforces a different schema (OpenAI: nested mappings,
     * Apple Intelligence: flat record). The examples must match.
     */
    getPromptExamples(): string;

    /** Backend-specific system instruction for the AI model (core instruction only, no existing payees or examples) */
    getSystemInstruction(): string;

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

    getSystemInstruction(): string {
        return `You are a transaction-classification specialist. You will receive a newline-separated list of raw payee strings from MoneyMoney. Return only a valid JSON object.

Critical JSON rules:
- The JSON object keys MUST be copied exactly from the input lines.
- Copy each key character-for-character, including punctuation, spaces, casing, numbers, country codes, and suffixes.
- Do not clean, normalize, shorten, reorder, or modify JSON keys.
- Return exactly one JSON property for each input line.
- Only clean the JSON values.

Value-cleaning rules:
- The JSON value is the cleaned payee name.
- Prefer an existing payee name exactly when it clearly matches.
- Remove terminal IDs, phone numbers, POS metadata, country codes, and payment noise from the value.
- Favor concise, canonical merchant names (e.g., Amazon, Netflix, IKEA).
- Never return "Unknown", "unknown", or any placeholder.
- If you cannot identify a distinct merchant, use a lightly normalized version of the raw input as the JSON value.
- Some raw payee strings may contain corrupted characters from encoding issues (e.g., '?' replacing German umlauts like 'ä', 'ö', 'ü'). When you see '?' in an unusual position, infer the intended word from context and use the corrected spelling in the JSON value.

Do not include explanations, metadata, or anything outside the JSON object.`;
    }

    getLabel(): string {
        return this.model;
    }

    getPromptExamples(): string {
        return `
Examples (input separated by newline, output shown as JSON):

Input:
-
Output:
{"mappings": []}

Input:
AMZN Mktp US*1234567890
Output:
{"mappings": [{"rawPayee": "AMZN Mktp US*1234567890", "cleanedPayee": "Amazon"}]}

Input:
Example Store, 800-5550100 Us
Output:
{"mappings": [{"rawPayee": "Example Store, 800-5550100 Us", "cleanedPayee": "Example Store"}]}

Input:
AMAZON.COM/BILLWA
AMAZON.COM
Output:
{"mappings": [{"rawPayee": "AMAZON.COM/BILLWA", "cleanedPayee": "Amazon"}, {"rawPayee": "AMAZON.COM", "cleanedPayee": "Amazon"}]}`;
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

type AppleLanguageModel = {
    dispose(): void;
};

type AppleLanguageModelSession = {
    respondWithJsonSchema(
        prompt: string,
        schema: unknown,
        options: { options: { temperature: number } }
    ): Promise<{ toJson(): string }>;
    dispose(): void;
};

type AppleIntelligenceModule = {
    SystemLanguageModel: new (options?: {
        guardrails?: number;
    }) => AppleLanguageModel;
    LanguageModelSession: new (options?: {
        instructions?: string;
        model?: AppleLanguageModel;
    }) => AppleLanguageModelSession;
};

type AppleIntelligenceSdk = AppleIntelligenceModule & {
    model: AppleLanguageModel;
};

export class AppleIntelligenceBackend implements TransformationBackend {
    // Lazy-initialised: model is created once and reused across calls.

    private _sdkPromise?: Promise<AppleIntelligenceSdk>;

    private async _getSdk() {
        if (!this._sdkPromise) {
            this._sdkPromise = this._initSdk();
        }
        return this._sdkPromise;
    }

    private async _initSdk(): Promise<AppleIntelligenceSdk> {
        let sdk: AppleIntelligenceModule;
        try {
            sdk = (await import('tsfm-sdk')) as AppleIntelligenceModule;
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

        try {
            const model = new sdk.SystemLanguageModel({ guardrails: 1 });
            return { ...sdk, model };
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
                buildApplePayeeMapJsonSchema(payees),
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

    getSystemInstruction(): string {
        return `You are a payee name cleaner. You receive raw bank transaction payee names, one per line. Clean each name by stripping receipt noise and legal suffixes. Return only a JSON object.

Rules:
- JSON keys: copy each input line exactly, character-for-character.
- JSON values: the cleaned payee name.
- Prefer an existing payee name exactly when it clearly matches the same merchant.
- Remove noise: thank-you tags, location suffixes, legal form suffixes (AG, GmbH, Ltd, Inc), terminal/receipt IDs, phone numbers.
- Keep the core merchant or bank name.
- Never return "Unknown", empty, or placeholder values.
- When you cannot identify a distinct merchant, lightly normalize the raw input.

Do not include explanations, metadata, or anything outside the JSON object.`;
    }

    getLabel(): string {
        return 'Apple Intelligence (on-device)';
    }

    getPromptExamples(): string {
        return `
Examples (input separated by newline, output shown as JSON):

Input:
-
Output:
{}

Input:
AMZN Mktp US*1234567890
Output:
{"AMZN Mktp US*1234567890": "Amazon"}

Input:
Example Store, 800-5550100 Us
Output:
{"Example Store, 800-5550100 Us": "Example Store"}

Input:
AMAZON.COM/BILLWA
AMAZON.COM
Output:
{"AMAZON.COM/BILLWA": "Amazon", "AMAZON.COM": "Amazon"}`;
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
            delete this._sdkPromise;
        }
    }

    isModelUnavailableError(error: Error): boolean {
        const unavailableErrorNames = new Set([
            'AssetsUnavailableError',
            'ModelNotReadyError',
            'ServiceCrashedError',
        ]);
        if (unavailableErrorNames.has(error.constructor?.name)) {
            return true;
        }
        const message = error.message.toLowerCase();
        return (
            (message.includes('apple intelligence') &&
                (message.includes('not available') ||
                    message.includes('not ready') ||
                    message.includes('not enabled'))) ||
            message.includes('unavailable') ||
            message.includes('modelmanagererror code=1008') ||
            message.includes('modelmanagererror code=1013')
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
        return new AppleIntelligenceBackend();
    }

    return new OpenAIBackend(config);
};
