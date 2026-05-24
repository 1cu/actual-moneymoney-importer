import { parse } from 'date-fns';
import { checkDatabaseUnlocked } from 'moneymoney';
import { ArgumentsCamelCase, CommandModule } from 'yargs';
import { AccountMap } from '../utils/AccountMap.js';
import ActualApi from '../utils/ActualApi.js';
import { includesRef, toRefList, CommonArgs } from '../utils/cliArgs.js';
import CategoryMap from '../utils/CategoryMap.js';
import Importer from '../utils/Importer.js';
import Logger, { LogLevel } from '../utils/Logger.js';
import PayeeTransformer from '../utils/PayeeTransformer.js';
import { withApiNoiseFilter } from '../utils/ActualApiLogControl.js';
import { getConfig } from '../utils/config.js';
import { DATE_FORMAT } from '../utils/shared.js';

export const buildBudgetNameBySyncIdMap = async (
    actualApi: Pick<ActualApi, 'getUserFiles'>,
    serverUrl: string
) => {
    try {
        const userFiles = await actualApi.getUserFiles();

        return new Map(userFiles.map((file) => [file.fileId, file.name]));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(
            `Failed to list Actual user files for server '${serverUrl}': ${reason}`,
            { cause: error }
        );
    }
};

export const getImportExitCode = (encounteredImportErrors: boolean) =>
    encounteredImportErrors ? 1 : 0;

type ImportArgs = CommonArgs & {
    'dry-run'?: boolean;
    account?: string | string[];
    server?: string | string[];
    budget?: string | string[];
    'category-sync-on-existing'?: 'ask' | 'new' | 'always';
    from?: string;
    to?: string;
};

const handleCommand = async (argv: ArgumentsCamelCase<ImportArgs>) => {
    const config = await getConfig(argv);

    const logLevel = argv.logLevel ?? argv.loglevel ?? LogLevel.INFO;
    const logger = new Logger(logLevel);

    const payeeTransformer = config.payeeTransformation.enabled
        ? new PayeeTransformer(config.payeeTransformation, logger)
        : undefined;

    if (config.actualServers.length === 0) {
        throw new Error(
            'No Actual servers configured. Refer to the docs on how to a new server with in the configuration file.'
        );
    }

    const isDryRun = argv.dryRun || false;
    const fromDate = argv.from
        ? parse(argv.from, DATE_FORMAT, new Date())
        : undefined;
    const toDate = argv.to
        ? parse(argv.to, DATE_FORMAT, new Date())
        : undefined;

    const accountRefs = toRefList(argv.account);
    const serverRefs = toRefList(argv.server);
    const budgetRefs = toRefList(argv.budget);

    const categorySyncOnExisting =
        argv.categorySyncOnExisting ?? config.import.categorySyncOnExisting;

    if (
        config.import.synchronizeCategories &&
        categorySyncOnExisting === 'ask' &&
        !process.stdin.isTTY
    ) {
        throw new Error(
            `Category sync policy 'ask' requires an interactive terminal. Use --category-sync-on-existing=new|always for non-interactive runs.`
        );
    }

    if (fromDate && isNaN(fromDate.getTime())) {
        throw new Error(
            `Invalid 'from' date: '${argv.from}'. Expected a date in the format: ${DATE_FORMAT}`
        );
    }

    if (toDate && isNaN(toDate.getTime())) {
        throw new Error(
            `Invalid 'to' date: '${argv.to}'. Expected a date in the format: ${DATE_FORMAT}`
        );
    }

    if (fromDate && toDate && fromDate > toDate) {
        throw new Error(
            `Invalid date range: 'from' (${argv.from}) must be on or before 'to' (${argv.to}).`
        );
    }

    const selectedServerConfigs = config.actualServers.filter(
        (serverConfig) => {
            return includesRef(serverRefs, serverConfig.serverUrl);
        }
    );

    if (selectedServerConfigs.length === 0) {
        throw new Error(
            'No matching Actual servers found for --server filter.'
        );
    }

    logger.debug(`Checking MoneyMoney database access...`);
    const isUnlocked = await checkDatabaseUnlocked();
    if (!isUnlocked) {
        throw new Error(
            `MoneyMoney database is locked. Please unlock it and try again.`
        );
    }
    logger.debug(`MoneyMoney database is accessible.`);

    const mainImport = async () => {
        let encounteredImportErrors = false;

        for (const serverConfig of selectedServerConfigs) {
            const selectedBudgetConfigs = serverConfig.budgets.filter(
                (budgetConfig) => includesRef(budgetRefs, budgetConfig.syncId)
            );

            if (selectedBudgetConfigs.length === 0) {
                logger.warn(
                    `No matching budgets found for server '${serverConfig.serverUrl}'. Skipping.`
                );
                continue;
            }

            logger.debug(`Creating Actual API instance...`, [
                `Server URL: ${serverConfig.serverUrl}`,
                `Budgets: ${selectedBudgetConfigs
                    .map((budget) => budget.syncId)
                    .join(', ')}`,
            ]);
            const actualApi = new ActualApi(serverConfig, logger);

            logger.debug(`Initializing Actual API...`);
            await actualApi.init();

            try {
                let budgetNameBySyncId = new Map<string, string>();

                try {
                    budgetNameBySyncId = await buildBudgetNameBySyncIdMap(
                        actualApi,
                        serverConfig.serverUrl
                    );
                } catch (error) {
                    const reason =
                        error instanceof Error ? error.message : String(error);

                    logger.warn(
                        `Could not list Actual user files for server '${serverConfig.serverUrl}'. Continuing without budget names.`,
                        reason
                    );
                }

                for (const budgetConfig of selectedBudgetConfigs) {
                    const budgetName = budgetNameBySyncId.get(
                        budgetConfig.syncId
                    );
                    const budgetLabel = budgetName
                        ? `${budgetName} (${budgetConfig.syncId})`
                        : budgetConfig.syncId;

                    logger.debug(`Loading budget...`, `Budget: ${budgetLabel}`);
                    await actualApi.loadBudget(budgetConfig.syncId);

                    logger.debug(`Loading accounts...`);
                    const accountMap = new AccountMap(
                        budgetConfig,
                        logger,
                        actualApi
                    );
                    await accountMap.loadFromConfig();

                    const categoryMap = new CategoryMap(
                        budgetConfig,
                        actualApi,
                        logger
                    );
                    if (
                        config.import.synchronizeCategories ||
                        config.import.transfers.enabled
                    ) {
                        await categoryMap.load();
                    }

                    const importer = new Importer(
                        config,
                        budgetConfig,
                        actualApi,
                        logger,
                        accountMap,
                        categoryMap,
                        payeeTransformer
                    );

                    logger.debug(
                        `Preparing transaction import...`,
                        `Budget: ${budgetLabel}`
                    );

                    const importOptions: {
                        accountRefs?: string[];
                        from?: Date;
                        to?: Date;
                        isDryRun: boolean;
                        categorySyncOnExisting?: 'ask' | 'new' | 'always';
                    } = {
                        isDryRun,
                        categorySyncOnExisting,
                    };

                    if (accountRefs) {
                        importOptions.accountRefs = accountRefs;
                    }
                    if (fromDate) {
                        importOptions.from = fromDate;
                    }
                    if (toDate) {
                        importOptions.to = toDate;
                    }

                    await importer.importTransactions(importOptions);
                    encounteredImportErrors ||= importer.hasImportErrors();
                }
            } finally {
                try {
                    await actualApi.shutdown();
                } catch (shutdownError) {
                    encounteredImportErrors = true;
                    logger.error(
                        `Failed to shutdown Actual API: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`
                    );
                }
            }
        }

        process.exit(getImportExitCode(encounteredImportErrors));
    };

    await (logLevel < LogLevel.ACTUAL
        ? withApiNoiseFilter(mainImport)
        : mainImport());
};

export default {
    command: 'import',
    describe: 'Import data from MoneyMoney',
    builder: (yargs) => {
        return yargs
            .boolean('dry-run')
            .describe('dry-run', 'Do not import data')
            .string('account')
            .alias('account', 'a')
            .describe(
                'account',
                'Import only transactions from the specified MoneyMoney account identifier'
            )
            .string('server')
            .alias('server', 's')
            .describe(
                'server',
                'Import only to the specified Actual server URL'
            )
            .string('budget')
            .alias('budget', 'b')
            .describe(
                'budget',
                'Import only to the specified Actual budget identifier (syncId)'
            )
            .string('category-sync-on-existing')
            .alias('category-sync-on-existing', 'C')
            .choices('category-sync-on-existing', ['ask', 'new', 'always'])
            .describe(
                'category-sync-on-existing',
                'How category sync handles existing imported transactions: ask|new|always'
            )
            .string('from')
            .alias('from', 'f')
            .describe(
                'from',
                `Import transactions on or after this date (${DATE_FORMAT})`
            )
            .string('to')
            .alias('to', 't')
            .describe(
                'to',
                `Import transactions up to this date (${DATE_FORMAT})`
            );
    },
    handler: (argv) => handleCommand(argv),
} as CommandModule;
