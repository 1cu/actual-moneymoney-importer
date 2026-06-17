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

const normalizePayeeTokens = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);

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

const scoreExistingPayeeMatch = (payee: string, existingPayeeName: string) => {
    const normalizedPayee = normalizePayee(payee);
    const normalizedExistingPayee = normalizePayee(existingPayeeName);
    const payeeTokens = normalizePayeeTokens(payee);
    const existingPayeeTokens = normalizePayeeTokens(existingPayeeName);

    if (!normalizedPayee || !normalizedExistingPayee) {
        return diceCoefficient(payee, existingPayeeName);
    }

    if (normalizedPayee === normalizedExistingPayee) {
        return 1;
    }

    if (
        normalizedExistingPayee.length >= 5 &&
        existingPayeeTokens.length > 0 &&
        existingPayeeTokens.length <= payeeTokens.length &&
        existingPayeeTokens.every(
            (token, index) => payeeTokens[index] === token
        )
    ) {
        return 1;
    }

    return diceCoefficient(payee, existingPayeeName);
};

const findBestExistingPayee = (payee: string, existingPayeeNames: string[]) => {
    let bestMatch: { payeeName: string; score: number } | null = null;

    for (const existingPayeeName of existingPayeeNames) {
        const score = scoreExistingPayeeMatch(payee, existingPayeeName);

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

const MAX_EXISTING_PAYEES_IN_RAW_LOG = 10;

const formatRawPayeeLog = (payees: string[]) => {
    return [`User message (${payees.length} payees): ${payees.join('\n')}`];
};

const formatRawResponseLog = (transformedPayees: Record<string, string>) => {
    return [
        `Response JSON (${Object.keys(transformedPayees).length} mappings): ${JSON.stringify(transformedPayees, null, 2)}`,
    ];
};

const formatExistingPayeeLog = (
    existingPayeeNames: string[],
    totalExistingPayees: number
) => {
    if (existingPayeeNames.length === 0) {
        return ['Existing payees in prompt: 0'];
    }

    const visiblePayees = existingPayeeNames.slice(
        0,
        MAX_EXISTING_PAYEES_IN_RAW_LOG
    );
    const hiddenCount = existingPayeeNames.length - visiblePayees.length;

    return [
        `Existing payees in prompt (first ${visiblePayees.length} of ${existingPayeeNames.length}${totalExistingPayees > existingPayeeNames.length ? ` relevant, ${totalExistingPayees} total` : ''}): ${visiblePayees.join('\n')}`,
        ...(hiddenCount > 0
            ? [`... ${hiddenCount} more existing payees omitted from log`]
            : []),
    ];
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
        const locallyMatchedPayees = resolvedPayees.size;

        if (unresolvedPayees.length === 0) {
            this.logger.debug('Payee transformation completed locally', [
                `Unique input payees: ${uniquePayees.length}`,
                `Matched locally: ${locallyMatchedPayees}`,
                `Sent to backend: 0`,
            ]);
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
        const promptLogExistingPayees = relevantExistingPayees.slice(
            0,
            MAX_EXISTING_PAYEES_IN_RAW_LOG
        );
        const systemPromptLog = this.generateInstructionPrompt();
        const systemPromptPreviewLog = this.generatePrompt(
            promptLogExistingPayees,
            existingPayeeNames.length
        );

        const existingPayeeLog = formatExistingPayeeLog(
            relevantExistingPayees,
            existingPayeeNames.length
        );

        try {
            this.logger.debug(`Starting payee transformation...`, [
                `Unique input payees: ${uniquePayees.length}`,
                `Matched locally before AI: ${locallyMatchedPayees}`,
                `Sent to backend: ${unresolvedPayees.length}`,
                `Existing payees used in prompt: ${relevantExistingPayees.length}${existingPayeeNames.length > relevantExistingPayees.length ? ` of ${existingPayeeNames.length}` : ''}`,
                `Backend: ${this.backend.getLabel()}`,
            ]);

            this.logger.debug('Raw payee transformation request', [
                `Base system message: ${systemPromptLog}`,
                ...existingPayeeLog,
                `System message preview (${promptLogExistingPayees.length} of ${relevantExistingPayees.length} existing payees included): ${systemPromptPreviewLog}`,
                ...formatRawPayeeLog(unresolvedPayees),
            ]);

            const transformedPayees = await this.backend.transformPayees(
                prompt,
                unresolvedPayees,
                this.config.temperature
            );

            this.logger.debug(
                'Raw payee transformation response',
                formatRawResponseLog(transformedPayees)
            );

            this.logger.debug(`AI payee transformation completed`, [
                `Received ${Object.keys(transformedPayees).length} mappings`,
            ]);

            let snappedToExisting = 0;
            let aiKeptAsNew = 0;
            let keptRaw = 0;
            let missingKeys = 0;

            // Build a case-insensitive lookup from AI response keys.
            // Maps lowercase(key) → original key, avoiding prototype
            // poisoning from the `in` operator on plain objects.
            const keyMap = new Map<string, string>();
            for (const key of Object.keys(transformedPayees)) {
                keyMap.set(key.toLowerCase(), key);
            }

            const findAiResponseKey = (
                rawPayee: string
            ): string | undefined => {
                // Exact match first (preserves original casing if it exists).
                const original = keyMap.get(rawPayee.toLowerCase());
                if (original === rawPayee) return rawPayee;
                if (original !== undefined) return original;

                const normalizedRawPayee = normalizePayee(rawPayee);
                const matchingKeys = Object.keys(transformedPayees).filter(
                    (key) => {
                        const normalizedKey = normalizePayee(key);
                        return (
                            normalizedKey.length > 0 &&
                            normalizedRawPayee.length > 0 &&
                            (normalizedRawPayee.startsWith(normalizedKey) ||
                                normalizedKey.startsWith(normalizedRawPayee))
                        );
                    }
                );

                if (matchingKeys.length === 1) return matchingKeys[0];

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
                `Unique input payees: ${uniquePayees.length}`,
                `Matched locally before AI: ${locallyMatchedPayees}`,
                `Sent to backend: ${unresolvedPayees.length}`,
                `Backend responses matched to requests: ${unresolvedPayees.length - missingKeys}`,
                `Backend responses missing/unusable: ${missingKeys}`,
                `Backend results snapped to existing payees: ${snappedToExisting}`,
                `Backend results kept as new payee names: ${aiKeptAsNew}`,
                `Backend requests kept raw: ${keptRaw}`,
                `Final mappings returned: ${resolvedPayees.size}`,
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
        return `${this.generateBasePrompt(existingPayeeNames, totalExistingPayees)}
${this.backend.getPromptExamples()}`;
    }

    private generateBasePrompt(
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

        return `${this.generateInstructionPrompt()}${existingPayeesSection}`;
    }

    private generateInstructionPrompt() {
        if (this.config.prompt?.trim()) {
            return this.config.prompt;
        }

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
