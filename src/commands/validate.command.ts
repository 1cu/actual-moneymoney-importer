import toml from 'toml';
import { z } from 'zod';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import path from 'node:path';
import fs from 'node:fs/promises';
import Logger, { LogLevel } from '../utils/Logger.js';
import { configSchema, getConfigFile } from '../utils/config.js';
import { EXAMPLE_CONFIG } from '../utils/shared.js';

const createDefaultConfig = async (configPath: string, logger: Logger): Promise<void> => {
    try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, EXAMPLE_CONFIG, { encoding: 'utf-8', mode: 0o600 });
        logger.warn(`Configuration file not found. Created default configuration at: ${configPath}`);
    } catch (createError) {
        logger.error(
            `Failed to create configuration file: ${createError instanceof Error ? createError.message : String(createError)}`
        );
        throw createError;
    }
};

const handleZodError = (error: z.ZodError, logger: Logger): void => {
    logger.error('Configuration file is invalid:');
    for (const issue of error.issues) {
        const issuePath = issue.path.length ? issue.path.join('.') : '<root>';
        logger.error(`Code ${issue.code} at path [${issuePath}]: ${issue.message}`);
    }
};

const handleValidate = async (argv: ArgumentsCamelCase) => {
    const configPath = await getConfigFile(argv);
    const logLevel = (argv.logLevel ?? LogLevel.INFO) as number;
    const logger = new Logger(logLevel);

    logger.info(`Current configuration file: ${configPath}`);

    try {
        const configContent = await fs.readFile(configPath, 'utf-8');

        let configData: Record<string, unknown>;
        try {
            configData = toml.parse(configContent) as Record<string, unknown>;
        } catch (tomlError) {
            logger.error(`TOML syntax error: ${tomlError instanceof Error ? tomlError.message : String(tomlError)}`);
            throw tomlError;
        }

        const config = configSchema.parse(configData);

        // Debug: Log effective configuration at debug level (excluding sensitive data)
        if (logLevel >= LogLevel.DEBUG) {
            const sanitizedConfig = JSON.parse(
                JSON.stringify(config, (key: string, value: unknown) => {
                    if (key === 'serverPassword' || key === 'password' || key === 'openAiApiKey') {
                        return '[REDACTED]';
                    }
                    return value;
                })
            ) as Record<string, unknown>;
            logger.debug('Effective configuration loaded', JSON.stringify(sanitizedConfig, null, 2));
        }

        logger.info('Configuration is valid.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await createDefaultConfig(configPath, logger);
            return;
        }

        if (error instanceof z.ZodError) {
            handleZodError(error, logger);
        } else {
            logger.error(`Configuration validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
    }
};

export default {
    command: 'validate',
    describe: 'View information about and validate the current configuration',
    handler: handleValidate,
} as CommandModule<ArgumentsCamelCase>;
