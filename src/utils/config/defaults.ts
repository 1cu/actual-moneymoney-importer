import Logger from '../Logger.js';
import {
    DEFAULT_DECISION_LOG_MAX_HINTS,
    createDefaultDecisionLog,
    type ConfigDefaultDecision,
} from '../config-format.js';
import { FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS, type Config } from './schema.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export const collectDefaultedConfigDecisions = (rawConfig: unknown, parsedConfig: Config): ConfigDefaultDecision[] => {
    if (!isRecord(rawConfig)) {
        return [];
    }

    const decisions: ConfigDefaultDecision[] = [];

    const importConfig = isRecord(rawConfig.import) ? rawConfig.import : {};
    if (!hasOwn(importConfig, 'synchronizeClearedStatus')) {
        decisions.push({
            path: 'import.synchronizeClearedStatus',
            value: parsedConfig.import.synchronizeClearedStatus,
        });
    }
    if (!hasOwn(importConfig, 'maskPayeeNamesInLogs')) {
        decisions.push({
            path: 'import.maskPayeeNamesInLogs',
            value: parsedConfig.import.maskPayeeNamesInLogs,
        });
    }

    const payeeTransformationConfig = isRecord(rawConfig.payeeTransformation) ? rawConfig.payeeTransformation : {};
    if (!hasOwn(payeeTransformationConfig, 'openAiModel')) {
        decisions.push({
            path: 'payeeTransformation.openAiModel',
            value: parsedConfig.payeeTransformation.openAiModel,
        });
    }
    if (!hasOwn(payeeTransformationConfig, 'skipModelValidation')) {
        decisions.push({
            path: 'payeeTransformation.skipModelValidation',
            value: parsedConfig.payeeTransformation.skipModelValidation,
        });
    }
    if (!hasOwn(payeeTransformationConfig, 'maskPayeeNamesInLogs')) {
        decisions.push({
            path: 'payeeTransformation.maskPayeeNamesInLogs',
            value: parsedConfig.payeeTransformation.maskPayeeNamesInLogs,
        });
    }

    const actualServersRaw = Array.isArray(rawConfig.actualServers) ? rawConfig.actualServers : [];
    for (const [index, server] of actualServersRaw.entries()) {
        if (!isRecord(server) || hasOwn(server, 'requestTimeoutMs')) {
            continue;
        }

        const parsedServer = parsedConfig.actualServers[index];
        const hints = parsedServer?.serverUrl ? [`Server URL: ${parsedServer.serverUrl}`] : undefined;
        decisions.push({
            path: `actualServers[${index}].requestTimeoutMs`,
            value: parsedServer?.requestTimeoutMs ?? FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS,
            hints,
        });
    }

    return decisions;
};

const MAX_AGGREGATED_DECISION_HINTS = DEFAULT_DECISION_LOG_MAX_HINTS;

export const logDefaultedConfigDecisions = (logger: Logger, decisions: ConfigDefaultDecision[]) => {
    const entry = createDefaultDecisionLog(decisions, {
        maxHints: MAX_AGGREGATED_DECISION_HINTS,
    });

    if (!entry) {
        return;
    }

    logger.debug(entry.message, entry.hints);
};

export type { ConfigDefaultDecision } from '../config-format.js';
