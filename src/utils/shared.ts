import os from 'os';
import path from 'path';
import type { Transaction as MonMonTransaction } from 'moneymoney';

export const DATE_FORMAT = 'yyyy-MM-dd';

export const getIdForMoneyMoneyTransaction = (
    transaction: Pick<MonMonTransaction, 'accountUuid' | 'id'>
): string => `${transaction.accountUuid}-${transaction.id}`;

export const buildTransactionNotes = (
    transaction: MonMonTransaction,
    importComments: boolean,
    commentPrefix: string
): string => {
    return [
        transaction.purpose,
        transaction.comment && importComments
            ? `${commentPrefix}${transaction.comment}`
            : undefined,
    ]
        .filter(Boolean)
        .join(' | ');
};

export const APPLICATION_DIRECTORY = path.resolve(os.homedir(), '.actually');

export const DEFAULT_DATA_DIR = path.resolve(
    APPLICATION_DIRECTORY,
    'actual-data'
);

export const DEFAULT_CONFIG_FILE = path.resolve(
    APPLICATION_DIRECTORY,
    'config.toml'
);

export const EXAMPLE_CONFIG = `
# Payee transformation
[payeeTransformation]
enabled = false
openAiApiKey = "<openAiKey>"
# openAiModel = "gpt-4o-mini"  # Optional: OpenAI model (default: gpt-5.4-nano)
# temperature = 1  # Optional: Temperature for OpenAI API (0–2 inclusive, default: 1)
# onTransformError = "warn"  # Optional: "warn" (default) or "fail"
# prompt = "<custom prompt>"  # Optional: Override the default payee transformation instructions

# Import settings
[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
synchronizeCategories = false
categorySyncOnExisting = "ask" # ask|new|always
importComments = false
commentPrefix = "MoneyMoney Comment: "

[import.transfers]
enabled = false
categoryRefs = ["Umbuchungen > Echte Umbuchungen"]
matchWindowDays = 0

# Ignore patterns (optional)
# [import.ignorePatterns]
# commentPatterns = ["[actual-ignore]"]
# payeePatterns = []
# purposePatterns = []

# Actual servers, you can add multiple servers
[[actualServers]]
serverUrl = "http://localhost:5006"
serverPassword = "<password>"

# Budgets for the server, you can add multiple budgets
[[actualServers.budgets]]
syncId = "<syncId>" # Get this value from the Actual advanced settings
# earliestImportDate = "2024-01-01" # Optional, only import transactions from this date

# E2E encryption for the budget, if enabled
[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

# Account map for the budget
[actualServers.budgets.accountMapping]
# The key is either the account name, or the account number of a MoneyMoney account
# The value is the account name or the account id (from the url) of the Actual account
"<monMonAcc>" = "<actualAcc>"

# Category map for the budget (optional)
# Tool-managed block: running actual-mmi categories map --write-config
# rewrites this section with annotated comments for readability.
# The key is a MoneyMoney category UUID, the value is an Actual category ID.
[actualServers.budgets.categoryMapping]
"<monMonCategoryUuid>" = "<actualCategoryId>"
`;
