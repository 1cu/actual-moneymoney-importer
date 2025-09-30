import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import Logger from './Logger.js';
import type { PayeeTransformationConfig } from './config.js';
import { DEFAULT_DATA_DIR } from './shared.js';

interface ModelCapabilities {
    supportsTemperature: boolean;
    supportsMaxTokens: boolean;
    defaultTemperature: number;
}

interface ModelCache {
    models: Array<string>;
    expiresAt: number;
}

const MODEL_CACHE_FILENAME = 'openai-model-cache.json';
const MODEL_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const MAX_LOG_ENTRIES = 50;

type ExtendedChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;

class PayeeTransformer {
    private openai: OpenAI;
    private availableModels: Array<string> | null = null;
    private modelListInitialized = false;
    private modelCapabilities: Map<string, ModelCapabilities> = new Map();
    private transformationCache = new Map<string, string>();

    private static modelCache: ModelCache | null = null;

    private static getCacheFilePath(): string {
        return path.join(DEFAULT_DATA_DIR, MODEL_CACHE_FILENAME);
    }

    private static async ensureCacheDirExists(): Promise<void> {
        await fs.mkdir(DEFAULT_DATA_DIR, { recursive: true });
    }

    private static async deleteModelCacheFile(): Promise<void> {
        try {
            const cacheFile = PayeeTransformer.getCacheFilePath();
            await fs.rm(cacheFile, { force: true });
        } catch (_error) {
            // Ignore cache deletion errors; a fresh cache will be written later.
        }
    }

    private static async readModelCacheFromDisk(logger?: Logger): Promise<ModelCache | null> {
        try {
            const cacheFile = PayeeTransformer.getCacheFilePath();
            const cacheContent = await fs.readFile(cacheFile, 'utf-8');
            const parsed = JSON.parse(cacheContent) as ModelCache;
            if (!Array.isArray(parsed.models) || typeof parsed.expiresAt !== 'number') {
                return null;
            }

            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                return null;
            }

            if (error instanceof SyntaxError) {
                const cacheFile = PayeeTransformer.getCacheFilePath();
                logger?.warn('OpenAI model cache was corrupted and has been reset.', [
                    `Path: ${cacheFile}`,
                    `Parse error: ${error.message}`,
                ]);
                await PayeeTransformer.deleteModelCacheFile();
            }

            return null;
        }
    }

    private static async writeModelCacheToDisk(cache: ModelCache): Promise<void> {
        try {
            await PayeeTransformer.ensureCacheDirExists();
            const cacheFile = PayeeTransformer.getCacheFilePath();
            const tmpFile = `${cacheFile}.tmp`;
            await fs.writeFile(tmpFile, JSON.stringify(cache, null, 2), { encoding: 'utf-8', mode: 0o600 });
            await fs.rename(tmpFile, cacheFile);
        } catch (_error) {
            // Ignore cache write errors but log in debug environments if needed
        }
    }

    public constructor(
        private config: PayeeTransformationConfig,
        private logger: Logger
    ) {
        if (!config.openAiApiKey) {
            throw new Error(
                'An OpenAI API key is required for payee transformation. Please set the key in the configuration file.'
            );
        }

        this.openai = new OpenAI({
            apiKey: config.openAiApiKey,
            timeout: config.modelConfig?.timeout || 30000, // 30 seconds default
            maxRetries: 0,
        });
    }

    public async transformPayees(payeeList: string[]): Promise<Record<string, string> | null> {
        if (payeeList.length === 0) return {};

        const uniquePayees = Array.from(new Set(payeeList));
        const uncachedPayees = uniquePayees.filter((payee) => !this.transformationCache.has(payee));

        if (uncachedPayees.length === 0) {
            return this.buildResponse(uniquePayees);
        }

        try {
            const model = await this.getConfiguredModel();
            const response = await this.makeOpenAIRequest(this.generatePrompt(), uncachedPayees, model);

            if (!response?.choices[0]?.message?.content) {
                this.logger.error('Invalid response from OpenAI API');
                return null;
            }

            const output = response.choices[0].message.content;
            const parsed = JSON.parse(output) as Record<string, string>;

            // Simple validation and caching
            for (const [original, transformed] of Object.entries(parsed)) {
                if (typeof transformed === 'string') {
                    this.transformationCache.set(original, transformed);
                }
            }

            return this.buildResponse(uniquePayees);
        } catch (error) {
            this.logger.error(`Payee transformation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
    }

    private async makeOpenAIRequest(
        prompt: string,
        payeeList: string[],
        model: string
    ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const requestConfig: ExtendedChatCompletionCreateParams = {
            model,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: payeeList.join('\n') },
            ],
            response_format: {
                type: 'json_object',
            },
        };

        // Simple parameter handling
        if (this.config.modelConfig?.temperature !== undefined) {
            requestConfig.temperature = Math.min(2, Math.max(0, this.config.modelConfig.temperature));
        }

        if (this.config.modelConfig?.maxTokens !== undefined) {
            requestConfig.max_tokens = Math.min(4096, Math.max(64, this.config.modelConfig.maxTokens));
        }

        return await this.openai.chat.completions.create(requestConfig);
    }

    private getModelCapabilities(_model: string): ModelCapabilities {
        return {
            supportsTemperature: true,
            supportsMaxTokens: true,
            defaultTemperature: 0.7,
        };
    }

    private async getConfiguredModel(): Promise<string> {
        if (this.config.skipModelValidation) {
            return this.config.openAiModel;
        }

        const availableModels = await this.getAvailableModels();
        if (!availableModels.includes(this.config.openAiModel)) {
            throw new Error(`Invalid OpenAI model: ${this.config.openAiModel}`);
        }

        return this.config.openAiModel;
    }

    private async getAvailableModels(): Promise<Array<string>> {
        if (this.availableModels) {
            return this.availableModels;
        }

        const response = await this.openai.models.list();
        this.availableModels = response.data.map((m) => m.id);
        return this.availableModels;
    }

    private generatePrompt(): string {
        // Use custom prompt if provided, otherwise use default
        if (this.config.customPrompt) {
            this.logger.debug('Using custom prompt from configuration');
            return this.config.customPrompt;
        }

        this.logger.debug('Using default prompt');
        return `You are a financial transaction classifier. Your task is to standardize payee names from bank transactions.

TASK: Convert raw payee names into clean, human-readable names.

RULES:
- Return ONLY valid JSON objects
- Map original payee names to standardized names
- Make names concise and recognizable
- Use consistent naming conventions
- Only transform names that would benefit from standardization
- Keep original names unchanged if they are already clear and meaningful
- For corporate/company names, remove unnecessary suffixes (GmbH, AG, Inc., etc.) when it makes the name cleaner
- For personal names, keep them as-is unless they contain obvious typos or formatting issues
- Return empty object {} if no input

EXAMPLES:
Input: "Amzn Mktp US*1234567890"
Output: {"Amzn Mktp US*1234567890": "Amazon"}

Input: "AMAZON.COM/BILLWA\nAMAZON.COM"
Output: {"AMAZON.COM/BILLWA": "Amazon", "AMAZON.COM": "Amazon"}

Input: "Max Müller"
Output: {"Max Müller": "Max Müller"}

Input: "HanseMerkur Speziale Krankenversicherung AG"
Output: {"HanseMerkur Speziale Krankenversicherung AG": "HanseMerkur"}

Input: ""
Output: {}

CRITICAL: Return ONLY valid JSON. No explanations or additional text.`;
    }

    private handleError(error: unknown): void {
        if (error instanceof Error) {
            // Handle specific OpenAI errors
            if ('status' in error && typeof (error as { status?: number }).status === 'number') {
                const status = (error as { status?: number }).status;
                switch (status) {
                    case 401:
                        this.logger.error('OpenAI API key is invalid or expired');
                        break;
                    case 403:
                        this.logger.error('OpenAI API access forbidden - check your API key permissions');
                        break;
                    case 429:
                        this.logger.error('OpenAI API rate limit exceeded - try again later');
                        break;
                    case 500:
                        this.logger.error('OpenAI API server error - try again later');
                        break;
                    case 502:
                    case 503:
                    case 504:
                        this.logger.error('OpenAI API service temporarily unavailable - try again later');
                        break;
                    default:
                        this.logger.error(`OpenAI API error (${status}): ${error.message}`);
                }
            } else {
                this.logger.error(`Error in payee transformation: ${error.message}`);
                if (error.stack) {
                    this.logger.debug(error.stack);
                }
            }
        } else {
            this.logger.error('Unknown error in payee transformation');
        }
    }

    private shouldMaskPayeeLogs(): boolean {
        return this.config.maskPayeeNamesInLogs;
    }

    private formatPayeeListForLog(payees: Array<string>): Array<string> {
        const prepared = this.shouldMaskPayeeLogs() ? payees.map((payee) => this.obfuscatePayeeName(payee)) : payees;

        return this.summarizeLogEntries(prepared);
    }

    private formatPayeeMappingForLog(mappings: Record<string, string>): Array<string> {
        const shouldMask = this.shouldMaskPayeeLogs();

        const formatted = Object.entries(mappings).map(([original, transformed]) => {
            const displayOriginal = shouldMask ? this.obfuscatePayeeName(original) : original;
            const displayTransformed = shouldMask ? this.obfuscatePayeeName(transformed) : transformed;

            return `  "${displayOriginal}" → "${displayTransformed}"`;
        });

        return this.summarizeLogEntries(formatted);
    }

    private summarizeLogEntries(entries: Array<string>): Array<string> {
        if (entries.length <= MAX_LOG_ENTRIES) {
            return entries;
        }

        const visibleEntries = entries.slice(0, MAX_LOG_ENTRIES);
        const remaining = entries.length - MAX_LOG_ENTRIES;
        return [...visibleEntries, `…and ${remaining} more`];
    }

    private obfuscatePayeeName(payee: string): string {
        const chars = Array.from(payee); // code point–aware
        if (chars.length <= 2) {
            return '•'.repeat(Math.max(chars.length, 1));
        }
        const firstChar = chars[0];
        const lastChar = chars[chars.length - 1];
        const middle = '•'.repeat(chars.length - 2);
        return `${firstChar}${middle}${lastChar}`;
    }

    private buildResponse(payees: Array<string>): Record<string, string> {
        return payees.reduce(
            (acc, payee) => {
                acc[payee] = this.transformationCache.get(payee) ?? payee;
                return acc;
            },
            {} as Record<string, string>
        );
    }

    private extractKeysFromJsonString(jsonString: string): string[] {
        // Simple regex to extract keys from JSON string
        // This matches quoted strings followed by a colon
        const keyRegex = /"([^"]+)":/g;
        const keys: string[] = [];
        let match;

        while ((match = keyRegex.exec(jsonString)) !== null) {
            if (match[1]) {
                keys.push(match[1]);
            }
        }

        return keys;
    }
}

export default PayeeTransformer;
