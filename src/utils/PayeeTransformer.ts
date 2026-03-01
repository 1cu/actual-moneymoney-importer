import OpenAI from 'openai';
import Logger from './Logger.js';
import { PayeeTransformationConfig } from './config.js';

class PayeeTransformer {
    private openai: OpenAI;
    private validatedModel: string;

    private static availableModels: Array<string> | null = null;

    constructor(
        private config: PayeeTransformationConfig,
        private logger: Logger
    ) {
        if (!config.openAiApiKey) {
            throw new Error(
                'An OpenAPI API key is required for payee transformation. Please set the key in the configuration file.'
            );
        }

        this.openai = new OpenAI({
            apiKey: config.openAiApiKey,
        });
    }

    public async transformPayees(
        payeeList: string[],
        existingPayeeNames: string[] = []
    ) {
        const prompt = this.generatePrompt(existingPayeeNames);

        if (payeeList.length === 0) {
            this.logger.debug(
                'No payees to transform. Returning empty object.'
            );
            return {};
        }

        try {
            // Lazy validation - only validate model when we actually need to use it
            if (!this.validatedModel) {
                this.validatedModel = await this.getConfiguredModel();
            }

            this.logger.debug(`Starting payee transformation...`, [
                `Payees: ${payeeList.length}`,
                `Model: ${this.config.openAiModel}`,
            ]);

            const response = await this.openai.chat.completions.create({
                model: this.validatedModel,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: payeeList.join('\n') },
                ],
                response_format: {
                    type: 'json_object',
                },
                temperature: this.config.temperature,
            });

            const output = response.choices[0]?.message?.content as string;

            try {
                return JSON.parse(output) as { [key: string]: string };
            } catch (parseError) {
                this.logger.error(
                    `Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`
                );
                this.logger.debug(`Raw response: ${output}`);
                return null;
            }
        } catch (error) {
            if (error instanceof Error) {
                if (this.isModelUnavailableError(error)) {
                    throw this.createModelUnavailableError(
                        this.config.openAiModel,
                        error.message
                    );
                }

                // Check if it's a temperature incompatibility error
                if (
                    error.message.includes('temperature') &&
                    error.message.includes('does not support')
                ) {
                    throw new Error(
                        `Incompatible configuration: Model '${this.config.openAiModel}' does not support temperature=${this.config.temperature}. ` +
                            `Please update the 'temperature' setting in your configuration file. Error: ${error.message}`,
                        { cause: error }
                    );
                }

                this.logger.error(
                    `Error in payee transformation: ${error.message}`
                );
            }
            return null;
        }
    }

    private async getConfiguredModel() {
        let availableModels: Array<string>;
        if (PayeeTransformer.availableModels) {
            this.logger.debug('Found available models in cache.');
            availableModels = PayeeTransformer.availableModels;
        } else {
            this.logger.debug('Listing available models...');
            const modelsIterator = await this.openai.models.list();
            availableModels = (await Array.fromAsync(modelsIterator)).map(
                (m) => m.id
            );
            PayeeTransformer.availableModels = availableModels;
        }

        this.logger.debug(`Found ${availableModels.length} available models.`);

        if (!availableModels.includes(this.config.openAiModel)) {
            this.logger.error(
                `The specified model '${this.config.openAiModel}' is invalid. The following models are available:`,
                availableModels
            );
            throw this.createModelUnavailableError(this.config.openAiModel);
        }

        return this.config.openAiModel;
    }

    private generatePrompt(existingPayeeNames: string[] = []) {
        const existingPayeesSection =
            existingPayeeNames.length > 0
                ? `

            IMPORTANT: The following payee names already exist in the budget. When transforming payees,
            you MUST prefer using these existing names when they match the transaction. This helps maintain
            consistency in the budget.

            Existing payees:
            ${existingPayeeNames.join('\n')}

            For example:
            - If you see "AMAZON.COM/BILLWA" and "Amazon" already exists, use "Amazon"
            - If you see "COSTCO WHOLESALE" and "Costco" already exists, use "Costco"
            - If you see "STARBUCKS #12345" and "Starbucks" already exists, use "Starbucks"
            - Only create a new payee name if no existing payee is a clear match
            `
                : '';

        // If custom prompt is provided, append existing payees section to it
        if (this.config.prompt?.trim()) {
            return this.config.prompt + existingPayeesSection;
        }

        // Default prompt optimized for GPT 4o-mini/5.1-nano
        return `You are a transaction-classification specialist. You will receive a newline-separated list of raw payee strings (how they appear in MoneyMoney). Produce a JSON object that maps each original string to a single cleaned, human-readable merchant name. Always return valid JSON and never return "Unknown", "unknown", or any placeholder—if you cannot identify a distinct merchant, normalize the input (remove extraneous punctuation/ordering, fix capitalization) and return that normalized form as the cleaned name. Favor concise, canonical brand names (e.g., Amazon, Netflix, IKEA) and remove terminal IDs, country codes, or POS data. Do not include explanations, metadata, or anything outside the JSON object.${existingPayeesSection}

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
AMAZON.COM/BILLWA
AMAZON.COM
Output:
{"AMAZON.COM/BILLWA":"Amazon", "AMAZON.COM":"Amazon"}`;
    }

    private isModelUnavailableError(error: Error) {
        const message = error.message.toLowerCase();
        return (
            message.includes('model') &&
            (message.includes('does not exist') ||
                message.includes('not found') ||
                message.includes('invalid model') ||
                message.includes('unknown model'))
        );
    }

    private createModelUnavailableError(model: string, cause?: string) {
        return new Error(
            `OpenAI model '${model}' is unavailable. Set 'payeeTransformation.openAiModel' in your config to an available model and try again.${cause ? ` Original error: ${cause}` : ''}`
        );
    }
}

export default PayeeTransformer;
