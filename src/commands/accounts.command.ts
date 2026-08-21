import type { APIAccountEntity } from '@actual-app/api/models';
import type { Account as MonMonAccount } from 'moneymoney';
import { checkDatabaseUnlocked, getAccounts } from 'moneymoney';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import ActualApi from '../utils/ActualApi.js';
import { selectTargets } from '../utils/actualTargets.js';
import { type CommonArgs, toRefList } from '../utils/cliArgs.js';
import {
    type ActualBudgetConfig,
    type ActualServerConfig,
    getConfig,
} from '../utils/config.js';
import Logger, { LogLevel } from '../utils/Logger.js';
import { renderTextTable } from '../utils/textTable.js';

type ListFormat = 'table' | 'json' | 'toml';

type ListSide = 'both' | 'moneymoney' | 'actual';

type AccountsListArgs = CommonArgs & {
    server?: string | string[];
    budget?: string | string[];
    format?: string;
    side?: string;
};

type MonMonAccountRow = {
    uuid: string;
    name: string;
    iban: string;
    currency: string;
    type: string;
};

type ActualAccountRow = {
    id: string;
    name: string;
    offbudget: boolean;
    closed: boolean;
    serverUrl: string;
    syncId: string;
};

type AccountsReport = {
    moneyMoney: MonMonAccountRow[];
    actual: ActualAccountRow[];
};

const buildMonMonRows = (accounts: MonMonAccount[]): MonMonAccountRow[] =>
    accounts.map(a => ({
        uuid: a.uuid,
        name: a.name,
        iban: a.accountNumber,
        currency: a.currency,
        type: a.type,
    }));

const buildActualRows = (
    accounts: APIAccountEntity[],
    serverUrl: string,
    syncId: string
): ActualAccountRow[] =>
    accounts.map(a => ({
        id: a.id,
        name: a.name,
        offbudget: a.offbudget ?? false,
        closed: a.closed ?? false,
        serverUrl,
        syncId,
    }));

const formatMoneyMoneyTable = (
    rows: MonMonAccountRow[],
    maxWidth: number
): string[] => {
    const headers = ['UUID', 'Name', 'IBAN', 'Currency', 'Type'];

    if (rows.length === 0) {
        return [
            '╔══════════════════════════════════════════╗',
            '║                  None                    ║',
            '╚══════════════════════════════════════════╝',
        ];
    }

    const dataRows = rows.map(r => [
        r.uuid,
        r.name,
        r.iban,
        r.currency,
        r.type,
    ]);

    return renderTextTable([headers, ...dataRows], {
        columns: [
            { width: 36, alignment: 'left', truncatePriority: 1 },
            { width: 24, alignment: 'left', truncatePriority: 2 },
            { width: 24, alignment: 'left', truncatePriority: 3 },
            { width: 6, alignment: 'left', truncatePriority: 5 },
            { width: 16, alignment: 'left', truncatePriority: 4 },
        ],
        maxWidth,
    });
};

const formatActualTable = (
    rows: ActualAccountRow[],
    maxWidth: number
): string[] => {
    const headers = ['ID', 'Name', 'Off-Budget', 'Closed', 'Server', 'Budget'];

    if (rows.length === 0) {
        return [
            '╔══════════════════════════════════════════╗',
            '║                  None                    ║',
            '╚══════════════════════════════════════════╝',
        ];
    }

    const dataRows = rows.map(r => [
        r.id,
        r.name,
        r.offbudget ? 'yes' : 'no',
        r.closed ? 'yes' : 'no',
        r.serverUrl,
        r.syncId,
    ]);

    return renderTextTable([headers, ...dataRows], {
        columns: [
            { width: 36, alignment: 'left', truncatePriority: 1 },
            { width: 24, alignment: 'left', truncatePriority: 2 },
            { width: 10, alignment: 'left', truncatePriority: 5 },
            { width: 6, alignment: 'left', truncatePriority: 6 },
            { width: 24, alignment: 'left', truncatePriority: 3 },
            { width: 36, alignment: 'left', truncatePriority: 4 },
        ],
        maxWidth,
    });
};

const formatTomlReport = (report: AccountsReport, side: ListSide): string[] => {
    const lines: string[] = [];

    if (side !== 'actual') {
        if (report.moneyMoney.length > 0) {
            lines.push(
                '# MoneyMoney accounts (copy a key into accountMapping)'
            );
            for (const row of report.moneyMoney) {
                const iban = row.iban || 'no IBAN';
                const label = `${row.name} (${iban})`;
                lines.push(
                    `# "${row.uuid}" = "<actual-account-id>"  # ${label}`
                );
            }
        } else {
            lines.push('# No MoneyMoney accounts found.');
        }
    }

    if (side !== 'moneymoney') {
        if (lines.length > 0) {
            lines.push('');
        }
        if (report.actual.length > 0) {
            lines.push('# Actual accounts (copy a value into accountMapping)');
            for (const row of report.actual) {
                lines.push(`# "<monmon-ref>" = "${row.id}"  # ${row.name}`);
            }
        } else {
            lines.push('# No Actual accounts found.');
        }
    }

    lines.push('');
    return lines;
};

const printTableReport = (report: AccountsReport, side: ListSide) => {
    const maxWidth = (process.stdout.columns ?? 142) - 2;

    if (side !== 'actual') {
        console.log('MoneyMoney Accounts:');
        console.log('');
        const monMonLines = formatMoneyMoneyTable(report.moneyMoney, maxWidth);
        for (const line of monMonLines) {
            console.log(line);
        }
    }

    if (side !== 'moneymoney') {
        if (side !== 'actual') {
            console.log('');
        }
        console.log('Actual Accounts:');
        console.log('');
        const actualLines = formatActualTable(report.actual, maxWidth);
        for (const line of actualLines) {
            console.log(line);
        }
    }
};

const fetchActualAccounts = async (
    config: Awaited<ReturnType<typeof getConfig>>,
    serverRefs: string[] | undefined,
    budgetRefs: string[] | undefined,
    logger: Logger
): Promise<{ rows: ActualAccountRow[]; shutdownFailed: boolean }> => {
    const matchingTargets = selectTargets(
        config.actualServers,
        serverRefs,
        budgetRefs
    );

    if (matchingTargets.length === 0) {
        throw new Error('No matching server/budget targets found.');
    }

    const targetsByServer = new Map<ActualServerConfig, ActualBudgetConfig[]>();
    for (const target of matchingTargets) {
        const budgets = targetsByServer.get(target.server) ?? [];
        budgets.push(target.budget);
        targetsByServer.set(target.server, budgets);
    }

    const actualRows: ActualAccountRow[] = [];
    let shutdownFailed = false;

    for (const [serverConfig, budgets] of targetsByServer.entries()) {
        const actualApi = new ActualApi(serverConfig, logger);
        await actualApi.init();

        try {
            for (const budgetConfig of budgets) {
                await actualApi.loadBudget(budgetConfig.syncId);

                const accounts = await actualApi.getAccounts();
                logger.debug(
                    `Found ${accounts.length} accounts in Actual budget '${budgetConfig.syncId}'.`
                );

                actualRows.push(
                    ...buildActualRows(
                        accounts,
                        serverConfig.serverUrl,
                        budgetConfig.syncId
                    )
                );
            }
        } finally {
            try {
                await actualApi.shutdown();
            } catch (shutdownError) {
                shutdownFailed = true;
                logger.warn(
                    `Failed to shutdown Actual API: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`
                );
            }
        }
    }

    return { rows: actualRows, shutdownFailed };
};

const handleListCommand = async (
    argv: ArgumentsCamelCase<AccountsListArgs>
) => {
    const logLevel = argv.logLevel ?? argv.loglevel ?? LogLevel.INFO;
    const logger = new Logger(logLevel);
    const format = (argv.format ?? 'table') as ListFormat;
    const side = (argv.side ?? 'both') as ListSide;

    // --- MoneyMoney accounts ---
    let monMonAccounts: MonMonAccount[] = [];
    if (side !== 'actual') {
        const isUnlocked = await checkDatabaseUnlocked();
        if (!isUnlocked) {
            throw new Error(
                'MoneyMoney database is locked. Please unlock it and try again.'
            );
        }

        monMonAccounts = await getAccounts();
        const groupAccounts = monMonAccounts.filter(a => a.group);
        monMonAccounts = monMonAccounts.filter(a => !a.group);
        logger.debug(
            `Found ${monMonAccounts.length} accounts in MoneyMoney (${groupAccounts.length} account groups excluded).`
        );
    }

    // --- Actual accounts ---
    let actualRows: ActualAccountRow[] = [];
    let shutdownFailed = false;
    if (side !== 'moneymoney') {
        const config = await getConfig(argv);
        const serverRefs = toRefList(argv.server);
        const budgetRefs = toRefList(argv.budget);

        const result = await fetchActualAccounts(
            config,
            serverRefs,
            budgetRefs,
            logger
        );
        actualRows = result.rows;
        shutdownFailed = result.shutdownFailed;
    }

    if (shutdownFailed) {
        process.exitCode = 1;
    }

    const report: AccountsReport = {
        moneyMoney: buildMonMonRows(monMonAccounts),
        actual: actualRows,
    };

    if (format === 'json') {
        console.log(JSON.stringify(report, null, 4));
    } else if (format === 'toml') {
        for (const line of formatTomlReport(report, side)) {
            console.log(line);
        }
    } else {
        printTableReport(report, side);
    }
};

const listSubcommand: CommandModule = {
    command: 'list',
    describe:
        'List MoneyMoney and Actual accounts with IDs for accountMapping config',
    builder: yargs => {
        return yargs
            .string('server')
            .alias('server', 's')
            .describe('server', 'Filter by Actual server URL')
            .string('budget')
            .alias('budget', 'b')
            .describe('budget', 'Filter by Actual budget syncId')
            .string('side')
            .choices('side', ['both', 'moneymoney', 'actual'])
            .default('side', 'both')
            .describe('side', 'Which accounts to list')
            .string('format')
            .choices('format', ['table', 'json', 'toml'])
            .default('format', 'table')
            .describe('format', 'Output format');
    },
    handler: argv => handleListCommand(argv),
};

export default {
    command: 'accounts',
    describe: 'Account discovery tools',
    builder: yargs => {
        return yargs.command(listSubcommand).strictCommands();
    },
    handler: () => {
        console.log('Use `actual-mmi accounts list --help` for options.');
        process.exit(0);
    },
} as CommandModule;
