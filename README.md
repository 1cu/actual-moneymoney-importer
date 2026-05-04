<p align="center">
    <img src="./assets/actual-moneymoney.png" height="150">
</p>
<h1 align="center">Actual-MoneyMoney Importer</h1>
<p align="center">
    A TypeScript CLI for importing <a href="https://moneymoney-app.com" target="_blanK">MoneyMoney</a> transactions into <a href="https://actualbudget.org">Actual Budget</a>.
</p>

<p align="center">
    <a href="https://github.com/1cu/actual-moneymoney-importer/actions/workflows/ci.yml">
        <img alt="CI" src="https://github.com/1cu/actual-moneymoney-importer/actions/workflows/ci.yml/badge.svg?branch=main">
    </a>
    <a href="https://www.npmjs.com/package/actual-moneymoney-importer">
        <img alt="npm version" src="https://img.shields.io/npm/v/actual-moneymoney-importer">
    </a>
</p>

> Originally based on [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney), `actual-moneymoney-importer` is maintained independently with added category sync, payee transformation, and richer import controls.

## Highlights

- 🏷️ **Category sync** – map MoneyMoney categories to Actual automatically, with backfill and conflict resolution
- 🗺️ **`categories map` CLI** – audit, plan, and write your category mapping from the terminal
- 🔬 **Scoped imports** – filter by server, budget, or account with repeatable `-s`/`-b`/`-a` flags
- ⚠️ **Auto-rule override detection** – get warned when Actual's rules silently change a synced category
- 🤖 **AI payee transformation** – configurable prompt, latest OpenAI models (`gpt-5-nano` default), temperature, and error-handling policy
- 💬 **Comment import** – carry MoneyMoney transaction comments into Actual notes (with configurable prefix)

## Installation

### Requirements

- macOS with [MoneyMoney](https://moneymoney-app.com) installed
- An [Actual Budget](https://actualbudget.org) server and budget
- Node.js 25+

Install with NPM:

```bash
npm i -g actual-moneymoney-importer
```

The installed CLI command is `actual-mmi`.

### Quick Start

1. Install the CLI.
2. Run `actual-mmi validate` to create an example config and print its path.
3. Fill in your Actual server, budget sync ID, and account mapping.
4. Run `actual-mmi import --dry-run` to preview the import before making changes.

## Configuration

Details on parameters are available by running `actual-mmi --help`.

The application uses a TOML configuration file.
Run `actual-mmi validate` to validate the configuration and, on first run, generate an example file and print its path.
You can pass a custom configuration file with `--config`.

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
# Tool-managed block: running `actual-mmi categories map --write-config`
# rewrites this section with annotated comments for readability.
# The key is the MoneyMoney category UUID and the value is the Actual category id.
"<monMonCategoryUuid>" = "<actualCategoryId>"
```

### Payee transformation

Converts cryptic payee names to human-readable formats using OpenAI (e.g. "AMAZN S.A.R.L" to "Amazon"). Requires an API key from [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys).

| Option             | Default      | Description                                                                     |
| ------------------ | ------------ | ------------------------------------------------------------------------------- |
| `enabled`          | `false`      | Enable/disable AI payee transformation                                          |
| `openAiApiKey`     | —            | Your OpenAI API key (required if enabled)                                       |
| `openAiModel`      | `gpt-5-nano` | OpenAI model to use                                                             |
| `temperature`      | `1`          | Temperature for API calls (0–2). Note: some models only support `1`             |
| `onTransformError` | `warn`       | Error handling: `warn` (use raw names) or `fail` (abort import)                 |
| `prompt`           | built-in     | Custom transformation instructions (existing payees are appended automatically) |

The AI receives existing payees from your budget to prefer matching over creating duplicates.

### Import settings

| Option                        | Default                  | Description                                                 |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| `importUncheckedTransactions` | `true`                   | Import transactions not yet checked in MoneyMoney           |
| `synchronizeClearedStatus`    | `true`                   | Sync MoneyMoney's cleared status to Actual                  |
| `synchronizeCategories`       | `false`                  | Enable category sync (see [Category Sync](#category-sync))  |
| `categorySyncOnExisting`      | `ask`                    | Policy for existing transactions: `ask`, `new`, or `always` |
| `importComments`              | `false`                  | Import MoneyMoney comments into Actual notes                |
| `commentPrefix`               | `"MoneyMoney Comment: "` | Prefix added to imported comments                           |

### Comment import

When `importComments = true`, MoneyMoney transaction comments are appended to the Actual notes field with the configured `commentPrefix`. This preserves the original purpose and adds the comment as additional context.

### Category sync policies

When `synchronizeCategories = true`, the `categorySyncOnExisting` option controls how conflicts are handled for transactions that already exist in Actual:

- **`ask`** (default): Prompt interactively for each conflict. Requires a TTY; use `-C=new` or `-C=always` in non-interactive environments.
- **`new`**: Only apply categories to newly imported transactions; leave existing transactions unchanged.
- **`always`**: Always apply the mapped category, overwriting any existing category in Actual.

You can override this at runtime with `--category-sync-on-existing` or `-C`.

### Servers, budgets, and account mapping

- **Actual servers** specify which servers should be imported to
- **Budget configurations** describe the budget files per server. The sync ID is in Actual → Settings → Advanced. If the budget is E2E encrypted, provide the password.
- **Account mapping** maps MoneyMoney accounts to Actual accounts. MoneyMoney accounts can be identified by UUID (AppleScript API only), account number (IBAN, etc.), or name (in that order). Actual accounts by UUID (from URL) or name. If names duplicate, the first match is used.

Once configured, run `actual-mmi validate` to verify the format.

## Usage

Once configured, importing is as simple as running `actual-mmi import`. Make sure the Actual servers are running and MoneyMoney is unlocked. By default, the importer processes the last month of transactions. Use `--from=YYYY-MM-DD` and optionally `--to=YYYY-MM-DD` to import a specific date range.

The importer will not track previous imports, so if you wait more than one month between imports, you might need to manually specify the last import date. Running the importer twice in the same month is no problem, as duplicate transactions will automatically be detected and skipped.

Imports can be scoped with `--server`, `--budget`, and `--account` options. Each flag is case-insensitive, can be repeated, and accepts comma-separated values.

```bash
# Import specific accounts
actual-mmi import -a "DKB Giro" -a "DKB Visa"
actual-mmi import -a "DKB Giro,DKB Visa"

# Restrict to server and budget
actual-mmi import -s myServerA -b HomeBudget

# Combine filters
actual-mmi import -s myServerA -b HomeBudget -a "Groceries,Utilities"
```

### Dry run

Use `--dry-run` to preview what would be imported without making any changes:

```bash
actual-mmi import --dry-run
```

### Category Sync

Category sync maps MoneyMoney categories to Actual categories during import. Enable it with `synchronizeCategories = true` in your config.

**How it works:**

1. **New transactions**: Categories are assigned based on your `[actualServers.budgets.categoryMapping]`
2. **Existing transactions (backfill)**: Uncategorised transactions in Actual get the mapped category applied
3. **Conflicts**: When an existing transaction has a different category, the `categorySyncOnExisting` policy applies
4. **Auto-rule override detection**: After import, the importer re-fetches new transactions and warns if Actual's auto-rules changed a synced category

**CLI override:**

```bash
# Override policy for this run
actual-mmi import -C=new      # Only new transactions
actual-mmi import -C=always   # Overwrite existing categories
```

Category mapping can be inspected and suggested with:

```bash
actual-mmi categories map -s http://localhost:5006 -b <syncId>
actual-mmi categories map -s http://localhost:5006 -b <syncId> --write-config
```

The audit report includes these sections:

- **Configured Mappings**: Current mappings from your config
- **Safe Suggestions**: High-confidence matches (identical category names)
- **Invalid**: Mappings pointing to non-existent Actual categories
- **Unresolved**: MoneyMoney categories without a mapping
- **Unused**: Mapped Actual categories not found in the budget
- **Next Actions**: Recommended steps to complete your mapping

With `--write-config`, the tool rewrites your `[actualServers.budgets.categoryMapping]` block with annotated comments for readability:

```toml
[actualServers.budgets.categoryMapping]
# MoneyMoney: Ausgaben > Lebenshaltung > Lebensmittel
# Actual: Lebenshaltung > 💳🧀 Lebensmittel
"7f5c..." = "8aa1..."
```

## Advanced Configuration

The following configuration options are optional.

### Ignore patterns

Ignore patterns let you specify payee names, comments, or purposes that should be ignored. Patterns are case-sensitive substring matches, not exact matches.

```toml
[import.ignorePatterns]
commentPatterns = ["[actual-ignore]"]
payeePatterns = []
purposePatterns = []
```

The above configuration ignores any transaction whose comment contains `[actual-ignore]`.

### Earliest import date

Each budget can specify an earliest import date. This can be useful when starting to use the importer with an already existing budget in order to prevent duplicates from being imported. The importer will ignore any transactions from before the specified date.

```toml
[[actualServers.budgets]]
earliestImportDate = "2024-01-01" # Format is YYYY-MM-DD
```

Note that the date is a string, not a TOML date.

## Bugs

If you notice any bugs or issues, please file an issue.

## Maintenance Notes

### Releases

Stable releases are cut from `main` and published here on GitHub and npm under the `actual-moneymoney-importer` package name.
