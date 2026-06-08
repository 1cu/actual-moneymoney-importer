import Logger from './Logger.js';
import { PayeeTransformationConfig } from './config.js';
import {
    TransformationBackend,
    createTransformationBackend,
} from './TransformationBackend.js';

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
    private backend: TransformationBackend;

    constructor(
        private config: PayeeTransformationConfig,
        private logger: Logger,
        backend?: TransformationBackend
    ) {
        this.backend = backend ?? createTransformationBackend(config);
        this.logger.debug(`Payee transformation enabled`, [
            `Backend: ${this.backend.getLabel()}`,
            `Temperature: ${this.config.temperature}`,
            `Match threshold: ${this.config.payeeMatchThreshold}`,
            `Max existing payees in prompt: ${this.config.maxExistingPayeesInPrompt}`,
        ]);
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
                bestExistingPayee.score >= this.config.payeeMatchThreshold
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
            this.config.maxExistingPayeesInPrompt
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
                `Backend: ${this.backend.getLabel()}`,
            ]);

            const transformedPayees = await this.backend.transformPayees(
                prompt,
                unresolvedPayees,
                this.config.temperature
            );

            this.logger.debug(`AI payee transformation response`, [
                JSON.stringify(transformedPayees),
            ]);

            let snappedToExisting = 0;
            let aiKeptAsNew = 0;
            let keptRaw = 0;
            let missingKeys = 0;

            // Case-insensitive lookup: AI may return keys with different casing.
            const lowerKeys = new Map<string, string>();
            for (const key of Object.keys(transformedPayees)) {
                const lower = key.toLowerCase();
                if (key !== lower) {
                    lowerKeys.set(lower, key);
                }
            }

            const findAiResponseKey = (
                rawPayee: string
            ): string | undefined => {
                if (rawPayee in transformedPayees) return rawPayee;
                const lower = rawPayee.toLowerCase();
                if (lowerKeys.has(lower)) return lowerKeys.get(lower);
                if (lower in transformedPayees) return lower;
                return undefined;
            };

            for (const rawPayee of unresolvedPayees) {
                const aiResponseKey = findAiResponseKey(rawPayee);
                const transformedPayee = aiResponseKey
                    ? transformedPayees[aiResponseKey]?.trim()
                    : undefined;

                if (!aiResponseKey) {
                    missingKeys++;
                }
                const normalizedPayee = transformedPayee || rawPayee;
                const bestExistingPayee = findBestExistingPayee(
                    normalizedPayee,
                    existingPayeeNames
                );

                if (
                    bestExistingPayee &&
                    bestExistingPayee.score >= this.config.payeeMatchThreshold
                ) {
                    resolvedPayees.set(rawPayee, bestExistingPayee.payeeName);
                    if (transformedPayee) {
                        snappedToExisting++;
                    } else {
                        keptRaw++;
                    }
                } else {
                    resolvedPayees.set(rawPayee, normalizedPayee);
                    if (transformedPayee) {
                        aiKeptAsNew++;
                    } else {
                        keptRaw++;
                    }
                }
            }

            this.logger.debug(`Payee transformation results`, [
                `Local Dice matches (no AI): ${resolvedPayees.size - unresolvedPayees.length}`,
                `Sent to backend: ${unresolvedPayees.length}`,
                `Snapped to existing: ${snappedToExisting}`,
                `AI new names: ${aiKeptAsNew}`,
                `Kept raw: ${keptRaw}`,
                `Missing keys: ${missingKeys}`,
            ]);

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

        return `You are a transaction-classification specialist. You will receive a newline-separated list of raw payee strings (how they appear in MoneyMoney). Produce a JSON object where each key is the exact raw payee string and the value is a single cleaned, human-readable merchant name. Always return valid JSON and never return "Unknown", "unknown", or any placeholder—if you cannot identify a distinct merchant, normalize the input (remove extraneous punctuation/ordering, fix capitalization) and return that normalized form as the cleaned name. Favor concise, canonical brand names (e.g., Amazon, Netflix, IKEA) and remove terminal IDs, country codes, or POS data. Some raw payee strings may contain corrupted characters from encoding issues (e.g., '?' replacing German umlauts like 'ä', 'ö', 'ü'). When you see '?' in an unusual position, infer the intended word from context and use the corrected spelling in the cleaned name. Do not include explanations, metadata, or anything outside the JSON object.${existingPayeesSection}
${this.backend.getPromptExamples()}`;
    }

    private describeTransformationError(error: unknown) {
        if (!(error instanceof Error)) {
            return `Error in payee transformation: ${String(error)}`;
        }

        if (this.backend.isModelUnavailableError(error)) {
            return `Model '${this.backend.getLabel()}' is unavailable. Ensure the model is accessible and try again. Original error: ${error.message}`;
        }

        if (this.backend.isTemperatureError(error)) {
            return `Incompatible configuration: Model '${this.backend.getLabel()}' does not support temperature=${this.config.temperature}. Please update the 'temperature' setting in your configuration file. Error: ${error.message}`;
        }

        return `Error in payee transformation: ${error.message}`;
    }
}

export default PayeeTransformer;
