import { ArgumentsCamelCase, CommandModule } from 'yargs';
import {
    EnvVarResolutionError,
    getConfigFile,
    parseConfigContent,
    resolveCategorySyncPolicy,
} from '../utils/config.js';
import { CommonArgs } from '../utils/cliArgs.js';
import fs from 'fs/promises';
import path from 'path';
import Logger, { LogLevel } from '../utils/Logger.js';
import { ZodError } from 'zod';
import { EXAMPLE_CONFIG } from '../utils/shared.js';

const handleValidate = async (argv: ArgumentsCamelCase<CommonArgs>) => {
    const configPath = await getConfigFile(argv);

    const logLevel = argv.logLevel ?? argv.loglevel ?? LogLevel.INFO;
    const logger = new Logger(logLevel);

    logger.info(`Current configuration file: ${configPath}`);

    const configFileExists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);

    if (!configFileExists) {
        // Create path to file and file itself if it doesn't exist
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, EXAMPLE_CONFIG, 'utf8');

        logger.warn('Configuration file not found.');
        logger.info(
            `Created default configuration file at: ${configPath}. Please edit it with your preferred settings.`
        );

        process.exit(0);
    } else {
        logger.info('Validating configuration...');

        try {
            logger.debug(`Reading configuration file...`);
            const configContent = await fs.readFile(configPath, 'utf-8');

            logger.debug(`Parsing configuration file...`);
            const config = parseConfigContent(configContent);

            // Soft warning: categorySync is 'off' but mappings exist
            if (resolveCategorySyncPolicy(config.import) === 'off') {
                const hasMappings = config.actualServers.some((server) =>
                    server.budgets.some(
                        (budget) =>
                            budget.categoryMapping !== undefined &&
                            Object.keys(budget.categoryMapping).length > 0
                    )
                );
                if (hasMappings) {
                    logger.warn(
                        'categorySync is "off" but one or more budgets have categoryMapping entries.'
                    );
                    logger.warn(
                        'These mappings will be ignored during import.'
                    );
                    logger.warn(
                        'Set categorySync to "new" or "all" in [import] to activate them.'
                    );
                }
            }
        } catch (e) {
            if (e instanceof EnvVarResolutionError) {
                logger.error(e.message);
            } else if (e instanceof ZodError) {
                logger.error('Configuration file is invalid:');
                for (const error of e.issues) {
                    logger.error(
                        `Path [${error.path.join('.')}]: ${error.message}`
                    );
                }
            } else if (e instanceof Error && e.name === 'SyntaxError') {
                const line = 'line' in e ? e.line : -1;
                const column = 'column' in e ? e.column : -1;

                logger.error(
                    `Failed to parse configuration file: ${e.message} (line ${line}, column ${column})`
                );
            } else {
                logger.error(`An unexpected error occurred: ${e}`);
            }

            process.exit(1);
        }

        logger.info('Configuration file is valid.');
    }
};

export default {
    command: 'validate',
    describe: 'View information about and validate the current configuration',
    handler: handleValidate,
} as CommandModule;
