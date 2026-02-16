#!/usr/bin/env node

import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import importCommand from './commands/import.command.js';
import validateCommand from './commands/validate.command.js';
import Logger from './utils/Logger.js';
import { APPLICATION_DIRECTORY } from './utils/shared.js';

// Display version and fork information
console.log('🔀 Running on develop fork');
console.log('');

try {
    fs.accessSync(APPLICATION_DIRECTORY);
} catch (_err) {
    fs.mkdirSync(APPLICATION_DIRECTORY, { recursive: true });
}

yargs(hideBin(process.argv))
    .scriptName('actual-monmon')
    .usage('$0 <command> [options]')
    .option('config', {
        type: 'string',
        description: 'Path to the configuration file',
    })
    .option('logLevel', {
        type: 'number',
        description: 'The log level to use (0-4)',
        choices: [0, 1, 2, 3, 4],
    })
    .command(importCommand)
    .command(validateCommand)
    .strictCommands()
    .strictOptions()
    .recommendCommands()
    .demandCommand(1, 'Please specify a command.')
    .showHelpOnFail(false)
    .fail((msg, err, yargsInstance) => {
        const logger = new Logger();
        const isMissingCommand = !err && msg === 'Please specify a command.';

        yargsInstance.showHelp();
        console.log('');

        if (isMissingCommand) {
            process.exit(0);
        }

        if (err) {
            logger.error(err.message);
        } else {
            logger.error(msg);
        }

        process.exit(1);
    })
    .parseAsync();
