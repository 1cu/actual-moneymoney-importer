import fs from 'fs/promises';
import path from 'path';
import toml from 'toml';
import type { ArgumentsCamelCase } from 'yargs';
import { ZodError } from 'zod';

import { DEFAULT_CONFIG_FILE } from '../shared.js';
import { collectDefaultedConfigDecisions, type ConfigDefaultDecision } from './defaults.js';
import { configSchema, type Config } from './schema.js';

export interface LoadedConfig {
    config: Config;
    defaultDecisions: ConfigDefaultDecision[];
}

export const getConfigFile = (argv: ArgumentsCamelCase): string => {
    if (argv.config) {
        const argvConfigFile = path.resolve(argv.config as string);
        return argvConfigFile;
    }

    return DEFAULT_CONFIG_FILE;
};

export const loadConfig = async (argv: ArgumentsCamelCase): Promise<LoadedConfig> => {
    const configFile = getConfigFile(argv);

    let configContent: string;
    try {
        configContent = await fs.readFile(configFile, 'utf-8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(
                `Config file not found: '${configFile}'. Create it or use the --config option to specify a different path.`
            );
        }
        throw error;
    }

    try {
        const configData = toml.parse(configContent);
        const config = configSchema.parse(configData);
        const defaultDecisions = collectDefaultedConfigDecisions(configData, config);

        return {
            config,
            defaultDecisions,
        };
    } catch (e) {
        const parseError = e as Error & { line?: number; column?: number };
        if (parseError instanceof Error && parseError.name === 'SyntaxError') {
            const line = parseError.line ?? -1;
            const column = parseError.column ?? -1;

            throw new Error(
                `Failed to parse configuration file: ${parseError.message} (line ${line}, column ${column})`
            );
        }

        if (e instanceof ZodError) {
            const formattedIssues = e.issues
                .map((issue) => {
                    const path = issue.path.join('.') || '<root>';
                    return `${path}: ${issue.message}`;
                })
                .join('; ');

            throw new Error(`Invalid configuration: ${formattedIssues}`);
        }

        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Invalid configuration file format: ${msg}. Run 'validate' to see errors.`);
    }
};

export const getConfig = async (argv: ArgumentsCamelCase): Promise<Config> => {
    const { config } = await loadConfig(argv);
    return config;
};
