<p align="center">
    <img src="./assets/actual-moneymoney.png" height="150">
</p>
<h1 align="center">Actual-MoneyMoney (Fork)</h1>
<p align="center">
A CLI to import <a href="https://moneymoney-app.com" target="_blanK">MoneyMoney</a> transactions into <a href="https://actualbudget.org">Actual Budget</a>, written in TypeScript
<p>

> **This is a fork of [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney) with additional features and improvements.**
>
> **Upstream repository**: [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney)

<p align="center">
<img src="https://badgers.space/github/checks/NikxDa/actual-moneymoney/main">
</p>

## Installation

Install with NPM:

```bash
npm i -g actual-moneymoney
```

The application will be accessible as a CLI tool with the name `actual-monmon`.

## Fork releases

This fork publishes releases from the `develop` branch.

Release notes are generated automatically by `semantic-release` from
conventional commits.

- `feat`: minor version bump
- `fix`: patch version bump
- `BREAKING CHANGE` footer or `!`: major version bump

To preview the next release version and notes locally:

```bash
npm run release:dry-run
```

## Configuration

Details on parameters are available by running `actual-monmon --help`.

The application needs to be configured with a TOML document in order to function. You can validate the configuration details by running `actual-monmon validate`. Running this for the first time will create an example configuration and print the path. You can pass a custom configuration with the `--config` parameter.

A configuration document looks like this:

```toml
# Payee transformation
[payeeTransformation]
enabled = false
openAiApiKey = "<openAiKey>"  # Your OpenAI API key
openAiModel = "gpt-5-nano"  # Optional: Specify the OpenAI model to use (default: gpt-5-nano)
temperature = 1  # Optional: Temperature for OpenAI API (0-2, default: 1). Note: gpt-5-nano only supports temperature=1
onTransformError = "warn"  # Optional: How to handle transformation errors: "warn" (default) or "fail"
prompt = "<custom prompt>"  # Optional: Override the default payee transformation instructions

# Import settings
[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
synchronizeCategories = false  # Optional: category sync is opt-in
categorySyncOnExisting = "ask" # ask|new|always
importComments = false # Optional: Import MoneyMoney comments into Actual 
commentPrefix = "MoneyMoney Comment: " # Optional: Set a prefix for MoneyMoney comments inside the notes

# Actual servers, you can add multiple servers
[[actualServers]]
serverUrl = "http://localhost:5006"
serverPassword = "<password>"

# Budgets for the server, you can add multiple budgets
[[actualServers.budgets]]
syncId = "<syncId>" # Get this value from the Actual advanced settings

# E2E encryption for the budget, if enabled
[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

# Account map for the budget
[actualServers.budgets.accountMapping]
# The key is either the account name, or the account number of a MoneyMoney account
# The value is the account name or the account id (from the url) of the Actual account
"<monMonAcc>" = "<actualAcc>"

# Optional category mapping
[actualServers.budgets.categoryMapping]
# Tool-managed block: running `actual-monmon categories map --write-config`
# rewrites this section with annotated comments for readability.
# The key is the MoneyMoney category UUID and the value is the Actual category id.
"<monMonCategoryUuid>" = "<actualCategoryId>"
```

A short summary:

- **Payee transformation** converts payee names to human-readable formats using AI (e.g. "AMAZN S.A.R.L" to "Amazon"). Requires an OpenAI API key from [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys). The AI is provided with existing payees from your budget to prefer matching existing names over creating duplicates. Custom prompts, `temperature` (0-2, model-dependent), and `onTransformError` ("warn" or "fail") can be configured.
- **Import settings** allow you to customize the import behavior, e.g. whether unchecked transactions should be imported.
- **Category sync is opt-in**: set `import.synchronizeCategories = true` to enable category assignment/update during import.
- **Actual servers** specify which servers should be imported to
- **Budget configurations** describe the budget files per server which are import targets. The sync ID can be grabbed from the Actual web interface by navigating to settings, then advanced settings. If the budget file is end-to-end encrypted, the details need to be provided here.
- **Account mapping** maps each MoneyMoney account to an Actual account. MoneyMoney accounts can be described by their UUID (accessible via the AppleScript API of MoneyMoney only, at this time), account number (IBAN, credit card no, etc.) or their name (in this order). Actual accounts can be described by their UUID (can be copied from the URL in a browser window) or their name (in that order). If a name occurs multiple times, the first one will be used. Invalid mappings or additional accounts are ignored.

Once you have configured your importer, run `actual-monmon validate` again to verify that the configuration has the correct format.

## Usage

Once configured, importing is as simple as running `actual-monmon import`. Make sure that the Actual servers are running and that MoneyMoney is unlocked. By default, the importer will import 1 month worth of transactions. You can override this by passing the `--from` property, like so: `actual-monmon import --from=2024-01-01`. Similarly, a `--to` property is available in case you want to import a specific date range.

The importer will not track previous imports, so if you wait more than one month between imports, you might need to manually specify the last import date. Running the importer twice in the same month is no problem, as duplicate transactions will automatically be detected and skipped.

Imports can be scoped with `--server`, `--budget`, and `--account` options. Each flag is case-insensitive, can be repeated, and accepts comma-separated values.

```bash
# Import specific accounts
actual-monmon import -a "DKB Giro" -a "DKB Visa"
actual-monmon import -a "DKB Giro,DKB Visa"

# Restrict to server and budget
actual-monmon import -s myServerA -b HomeBudget

# Combine filters
actual-monmon import -s myServerA -b HomeBudget -a "Groceries,Utilities"
```

Category mapping can be inspected and suggested with:

```bash
actual-monmon categories map -s http://localhost:5006 -b <syncId>
actual-monmon categories map -s http://localhost:5006 -b <syncId> --write-config
```

`--write-config` writes an annotated mapping block so humans can read it, for example:

```toml
[actualServers.budgets.categoryMapping]
# MoneyMoney: Ausgaben > Lebenshaltung > Lebensmittel
# Actual: Lebenshaltung > 💳🧀 Lebensmittel
"7f5c..." = "8aa1..."
```

## Advanced Configuration

The following configuration options can optionally be added

### Ignore patterns

Ignore patterns allow you to specify payee names, comments, or purposes which should be ignored. _Note:_ Currently, the strings are treated as is, meaning they are case-sensitive, and will be checked for inclusion, not exact matches.

```toml
[import.ignorePatterns]
commentPatterns = ["[actual-ignore]"]
payeePatterns = []
purposePatterns = []
```

The above configuration would ignore all transactions that have a comment containing the string `[actual-ignore]`.

### Earliest import date

Each budget can specify an earliest import date. This can be useful when starting to use the importer with an already existing budget in order to prevent duplicates from being imported. The importer will ignore any transactions from before the specified date.

```toml
[[actualServers.budgets]]
earliestImportDate = "2024-01-01" # Format is YYYY-MM-DD
```

Note that the date is a string, not a TOML date.

## Bugs

If you notice any bugs or issues, please file an issue.
