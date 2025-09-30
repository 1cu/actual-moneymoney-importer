import OpenAI from 'openai';
import Logger from './Logger.js';
import type { PayeeTransformationConfig } from './config.js';

type ExtendedChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;

class PayeeTransformer {
    private openai: OpenAI;
    private availableModels: Array<string> | null = null;
    private transformationCache = new Map<string, string>();

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
            this.logger.error(
                `Payee transformation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
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

    private buildResponse(payees: Array<string>): Record<string, string> {
        return payees.reduce(
            (acc, payee) => {
                acc[payee] = this.transformationCache.get(payee) ?? payee;
                return acc;
            },
            {} as Record<string, string>
        );
    }
}

export default PayeeTransformer;
