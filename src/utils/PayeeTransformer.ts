import OpenAI from 'openai';
import Logger from './Logger.js';
import { PayeeTransformationConfig } from './config.js';

type OpenAICompletionResponse = {
    choices: Array<{
        message?: {
            content?: string | null;
        };
    }>;
};

type OpenAIClient = {
    chat: {
        completions: {
            create: (options: {
                model: string;
                messages: Array<{
                    role: 'system' | 'user';
                    content: string;
                }>;
                response_format: {
                    type: 'json_object';
                };
                temperature: number;
            }) => Promise<OpenAICompletionResponse>;
        };
    };
};

const MAX_EXISTING_PAYEES_IN_PROMPT = 100;
const EXISTING_PAYEE_MATCH_THRESHOLD = 0.75;

const normalizePayee = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');

const buildBigramCounts = (value: string) => {
    const normalized = normalizePayee(value);
    const counts = new Map<string, number>();

    for (let i = 0; i < normalized.length - 1; i++) {
        const bigram = normalized.slice(i, i + 2);
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }

    return counts;
};

const diceCoefficient = (left: string, right: string) => {
    const normalizedLeft = normalizePayee(left);
    const normalizedRight = normalizePayee(right);

    if (!normalizedLeft && !normalizedRight) {
        return 1;
    }

    if (!normalizedLeft || !normalizedRight) {
        return 0;
    }

    if (normalizedLeft === normalizedRight) {
        return 1;
    }

    if (normalizedLeft.length < 2 || normalizedRight.length < 2) {
        return 0;
    }

    const leftCounts = buildBigramCounts(normalizedLeft);
    const rightCounts = buildBigramCounts(normalizedRight);
    let intersection = 0;

    for (const [bigram, leftCount] of leftCounts.entries()) {
        const rightCount = rightCounts.get(bigram) ?? 0;
        intersection += Math.min(leftCount, rightCount);
    }

    const total = normalizedLeft.length - 1 + (normalizedRight.length - 1);
    return total > 0 ? (2 * intersection) / total : 0;
};

const findBestExistingPayee = (payee: string, existingPayeeNames: string[]) => {
    let bestMatch: { payeeName: string; score: number } | null = null;

    for (const existingPayeeName of existingPayeeNames) {
        const score = diceCoefficient(payee, existingPayeeName);

        if (
            !bestMatch ||
            score > bestMatch.score ||
            (score === bestMatch.score &&
                existingPayeeName.localeCompare(bestMatch.payeeName) < 0)
        ) {
            bestMatch = {
                payeeName: existingPayeeName,
                score,
            };
        }
    }

    return bestMatch;
};

const selectRelevantExistingPayees = (
    existingPayeeNames: string[],
    unresolvedPayees: string[],
    maxExistingPayeesInPrompt: number
) => {
    if (existingPayeeNames.length === 0 || unresolvedPayees.length === 0) {
        return [] as string[];
    }

    return existingPayeeNames
        .map((existingPayeeName) => {
            const bestScore = unresolvedPayees.reduce((score, payee) => {
                return Math.max(
                    score,
                    diceCoefficient(payee, existingPayeeName)
                );
            }, 0);

            return {
                existingPayeeName,
                bestScore,
            };
        })
        .filter(({ bestScore }) => bestScore > 0)
        .sort(
            (a, b) =>
                b.bestScore - a.bestScore ||
                a.existingPayeeName.localeCompare(b.existingPayeeName)
        )
        .slice(0, maxExistingPayeesInPrompt)
        .map(({ existingPayeeName }) => existingPayeeName);
};

class PayeeTransformer {
    private openai: OpenAIClient;

    constructor(
        private config: PayeeTransformationConfig,
        private logger: Logger,
        openai?: OpenAIClient
    ) {
        if (!config.openAiApiKey) {
            throw new Error(
                'An OpenAPI API key is required for payee transformation. Please set the key in the configuration file.'
            );
        }

        this.openai = openai ?? new OpenAI({ apiKey: config.openAiApiKey });
    }

    public async transformPayees(
        payeeList: string[],
        existingPayeeNames: string[] = []
    ) {
        const uniquePayees = [
            ...new Set(payeeList.map((payee) => payee.trim())),
        ]
            .filter((payee) => payee.length > 0)
            .sort((a, b) => a.localeCompare(b));

        if (uniquePayees.length === 0) {
            this.logger.debug(
                'No payees to transform. Returning empty object.'
            );
            return {};
        }

        const resolvedPayees = new Map<string, string>();
        const unresolvedPayees = uniquePayees.filter((payee) => {
            const bestExistingPayee = findBestExistingPayee(
                payee,
                existingPayeeNames
            );

            if (
                bestExistingPayee &&
                bestExistingPayee.score >= EXISTING_PAYEE_MATCH_THRESHOLD
            ) {
                resolvedPayees.set(payee, bestExistingPayee.payeeName);
                return false;
            }

            return true;
        });

        if (unresolvedPayees.length === 0) {
            this.logger.debug(
                'All payees matched existing payees locally. Returning existing payee names.'
            );
            return Object.fromEntries(resolvedPayees);
        }

        const relevantExistingPayees = selectRelevantExistingPayees(
            existingPayeeNames,
            unresolvedPayees,
            MAX_EXISTING_PAYEES_IN_PROMPT
        );
        const prompt = this.generatePrompt(
            relevantExistingPayees,
            existingPayeeNames.length
        );

        try {
            this.logger.debug(`Starting payee transformation...`, [
                `Payees: ${unresolvedPayees.length}`,
                `Locally matched payees: ${resolvedPayees.size}`,
                `Existing payees used in prompt: ${relevantExistingPayees.length}${existingPayeeNames.length > relevantExistingPayees.length ? ` of ${existingPayeeNames.length}` : ''}`,
                `Model: ${this.config.openAiModel}`,
            ]);

            const response = await this.openai.chat.completions.create({
                model: this.config.openAiModel,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: unresolvedPayees.join('\n') },
                ],
                response_format: {
                    type: 'json_object',
                },
                temperature: this.config.temperature,
            });

            const output = response.choices[0]?.message?.content ?? '';
            let parsed: unknown;

            try {
                parsed = JSON.parse(output);
            } catch (parseError) {
                this.logger.error(
                    `Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`
                );
                this.logger.debug(`Raw response: ${output}`);
                throw parseError;
            }

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
            ) {
                throw new Error('OpenAI response was not a JSON object.');
            }

            const transformedPayees = parsed as Record<string, unknown>;

            for (const rawPayee of unresolvedPayees) {
                const transformedPayee = transformedPayees[rawPayee];
                const normalizedPayee =
                    typeof transformedPayee === 'string' &&
                    transformedPayee.trim()
                        ? transformedPayee.trim()
                        : rawPayee;
                const bestExistingPayee = findBestExistingPayee(
                    normalizedPayee,
                    existingPayeeNames
                );

                resolvedPayees.set(
                    rawPayee,
                    bestExistingPayee &&
                        bestExistingPayee.score >=
                            EXISTING_PAYEE_MATCH_THRESHOLD
                        ? bestExistingPayee.payeeName
                        : normalizedPayee
                );
            }

            return Object.fromEntries(resolvedPayees);
        } catch (error) {
            this.logger.error(this.describeTransformationError(error));

            if (error instanceof Error) {
                this.logger.debug(
                    `Raw payee transformation error: ${error.stack ?? error.message}`
                );
            }

            return null;
        }
    }

    private generatePrompt(
        existingPayeeNames: string[] = [],
        totalExistingPayees = existingPayeeNames.length
    ) {
        const existingPayeesSection =
            existingPayeeNames.length > 0
                ? `

            Existing payees already in the budget (prefer these exact names when they clearly match):
            ${existingPayeeNames.join('\n')}

            ${totalExistingPayees > existingPayeeNames.length ? `Showing ${existingPayeeNames.length} relevant existing payees out of ${totalExistingPayees}.` : ''}
            `
                : '';

        if (this.config.prompt?.trim()) {
            return this.config.prompt + existingPayeesSection;
        }

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

    private describeTransformationError(error: unknown) {
        if (!(error instanceof Error)) {
            return `Error in payee transformation: ${String(error)}`;
        }

        if (this.isModelUnavailableError(error)) {
            return `OpenAI model '${this.config.openAiModel}' is unavailable. Set 'payeeTransformation.openAiModel' in your config to an available model and try again. Original error: ${error.message}`;
        }

        if (
            error.message.includes('temperature') &&
            error.message.includes('does not support')
        ) {
            return `Incompatible configuration: Model '${this.config.openAiModel}' does not support temperature=${this.config.temperature}. Please update the 'temperature' setting in your configuration file. Error: ${error.message}`;
        }

        return `Error in payee transformation: ${error.message}`;
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
}

export default PayeeTransformer;
