<p align="center">
    <img src="./assets/actual-moneymoney.png" height="150" alt="Actual-MoneyMoney Importer">
</p>
<h1 align="center">Actual-MoneyMoney Importer</h1>
<p align="center">
    A TypeScript CLI for importing <a href="https://moneymoney-app.com" target="_blank">MoneyMoney</a> transactions into <a href="https://actualbudget.org">Actual Budget</a>.
</p>

<p align="center">
    <a href="https://github.com/1cu/actual-moneymoney-importer/actions/workflows/ci.yml">
        <img alt="CI" src="https://github.com/1cu/actual-moneymoney-importer/actions/workflows/ci.yml/badge.svg?branch=main">
    </a>
    <a href="https://www.npmjs.com/package/actual-moneymoney-importer">
        <img alt="npm version" src="https://img.shields.io/npm/v/actual-moneymoney-importer">
    </a>
</p>

> `actual-moneymoney-importer` started as a fork of [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney) and is now actively maintained and published with added category sync, payee transformation, and richer import controls.

Run `actual-mmi --help` at any time for a full list of commands and options. For per-command help, use `actual-mmi import --help` or `actual-mmi categories map --help`.

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Required configuration](#required-configuration)
  - [Import settings](#import-settings)
  - [Comment import](#comment-import)
- [Usage](#usage)
  - [Date ranges](#date-ranges)
  - [Scoped imports](#scoped-imports)
  - [Dry run](#dry-run)
  - [Verbose logging](#verbose-logging)
  - [Validate command](#validate-command)
- [Features](#features)
  - [Category sync](#category-sync)
  - [Payee transformation](#payee-transformation)
  - [Automatic transfers](#automatic-transfers)
- [Advanced configuration](#advanced-configuration)
  - [Ignore patterns](#ignore-patterns)
  - [Earliest import date](#earliest-import-date)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Support](#support)
- [Contributing and releases](#contributing-and-releases)

## Highlights

- 🏷️ **Category sync** – map MoneyMoney categories to Actual automatically, with backfill and conflict resolution
- 🗺️ **`categories map` CLI** – audit, plan, and write your category mapping from the terminal
- ⚠️ **Auto-rule override detection** – get warned when Actual's rules silently change a synced category
- 🔬 **Scoped imports** – filter by server, budget, or account with repeatable `-s`/`-b`/`-a` flags
- 🤖 **AI payee transformation** – configurable prompt, OpenAI or on-device Apple Intelligence, temperature, and error-handling policy
- 💬 **Comment import** – carry MoneyMoney transaction comments into Actual notes (with configurable prefix)

## Requirements

- macOS with [MoneyMoney](https://moneymoney-app.com) installed
- An [Actual Budget](https://actualbudget.org) server and budget
- Node.js >= 22

## Installation

```bash
npm i -g actual-moneymoney-importer
```

The installed CLI command is `actual-mmi`.

## Quick Start

1. Install the CLI:

    ```bash
    npm i -g actual-moneymoney-importer
    ```

2. Generate an example config and print its path:

    ```bash
    actual-mmi validate
    ```

3. Open the printed config file and fill in:
    - Actual server URL
    - Budget sync ID (from Actual → Settings → Advanced)
    - Account mapping

4. Validate your config:

    ```bash
    actual-mmi validate
    ```

5. Preview the import:

    ```bash
    actual-mmi import --dry-run
    ```

6. Run the import:

    ```bash
    actual-mmi import
    ```

## Configuration

The application uses a TOML configuration file. Run `actual-mmi validate` to create or check the config. Pass a custom path with `--config` (alias `-c`).

See [assets/config.example.toml](assets/config.example.toml) for a full annotated example.

### Environment variables

Any string config value can reference an environment variable with whole-value substitution like `${ENV_VAR}`. Partial interpolation is not supported, and missing variables fail validation and import. This is the recommended way to provide secrets:

```toml
serverPassword = "${ACTUAL_PASSWORD}"
openAiApiKey = "${MMI_OPENAI_KEY}"
```

### Required configuration

- **Actual servers** specify which servers should be imported to
- **Budget configurations** describe the budget files per server. The sync ID is in Actual → Settings → Advanced. If the budget is E2E encrypted, provide the password.
- **Account mapping** maps MoneyMoney accounts to Actual accounts. MoneyMoney accounts can be identified by UUID (AppleScript API only), account number (IBAN, etc.), or name (in that order). Actual accounts by UUID (from URL) or name. If names duplicate, the first match is used.

Once configured, run `actual-mmi validate` to verify the format.

### Import settings

| Option                        | Default                  | Description                                                 |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| `importUncheckedTransactions` | `true`                   | Import transactions not yet checked in MoneyMoney           |
| `synchronizeClearedStatus`    | `true`                   | Sync MoneyMoney's cleared status to Actual                  |
| `synchronizeCategories`       | `false`                  | Enable [category sync](#category-sync)                      |
| `categorySyncOnExisting`      | `ask`                    | Policy for existing transactions: `ask`, `new`, or `always` |
| `importComments`              | `false`                  | Import MoneyMoney comments into Actual notes                |
| `commentPrefix`               | `"MoneyMoney Comment: "` | Prefix added to imported comments                           |

### Comment import

The MoneyMoney transaction `purpose` is always written to the Actual notes field when present. When `importComments = true`, the MoneyMoney comment is appended after `|` using the configured `commentPrefix`.

## Usage

Once configured, importing is as simple as running `actual-mmi import`. Make sure the Actual servers are running and MoneyMoney is unlocked. By default, the importer processes the last month of transactions.

### Date ranges

Use `--from=YYYY-MM-DD` (alias `-f`) and optionally `--to=YYYY-MM-DD` (alias `-t`) to import a specific date range. The importer does not remember the last successful run date, so if you wait more than one month between imports, specify `--from`. Re-running overlapping ranges is safe because imported transactions use deterministic IDs and duplicates are skipped.

If a mapped Actual account has no existing transactions, the importer creates a synthetic cleared `Starting balance` transaction so the account balance matches MoneyMoney. Its `imported_id` is `{MoneyMoney account UUID}-start`.

### Scoped imports

Imports can be scoped with `--server` (alias `-s`), `--budget` (alias `-b`), and `--account` (alias `-a`). Each flag is case-insensitive, can be repeated, and accepts comma-separated values. Server filtering matches against the **server URL** and budget filtering matches against the **sync ID** from your config.

```bash
# Import specific accounts
actual-mmi import -a "Checking" -a "Credit Card"
actual-mmi import -a "Checking,Credit Card"

# Restrict to server and budget
actual-mmi import -s http://localhost:5006 -b <syncId>

# Combine filters
actual-mmi import -s http://localhost:5006 -b <syncId> -a "Groceries,Utilities"
```

### Dry run

Use `--dry-run` to preview what would be imported without making any changes:

```bash
actual-mmi import --dry-run
```

### Verbose logging

Use `--log-level` (alias `-l`) to control output verbosity. Levels range from 0 (errors only) to 4 (Actual API progress/debug output):

```bash
# Show debug output for troubleshooting
actual-mmi import --dry-run -l 3
```

### Validate command

`actual-mmi validate` checks your config file's TOML syntax and schema (required fields, types, value ranges). It does **not** verify that your Actual server is reachable, sync IDs exist, accounts map correctly, or your OpenAI key / Apple Intelligence is available. To test the full import flow without making changes, use `actual-mmi import --dry-run`.

## Features

### Category sync

Category sync maps MoneyMoney categories to Actual categories during import. Enable it with `synchronizeCategories = true` in your config.

#### Policies for existing transactions

When `synchronizeCategories = true`, the `categorySyncOnExisting` option controls how conflicts are handled for transactions that already exist in Actual:

- **`ask`** (default): Prompt interactively for each conflict. Requires a TTY; use `-C=new` or `-C=always` in non-interactive environments. Prompt choices: `y`/`yes` to update, `n`/`no` to keep, `A`/`all` to update all remaining, `N`/`none` to keep all remaining, and `q`/`quit` to abort.
- **`new`**: Only apply categories to newly imported transactions; leave existing transactions unchanged.
- **`always`**: Always apply the mapped category, overwriting any existing category in Actual.

Override at runtime with `--category-sync-on-existing` or `-C`:

```bash
actual-mmi import -C=new      # Only new transactions
actual-mmi import -C=always   # Overwrite existing categories
```

#### How it works

1. **New transactions**: Categories are assigned based on your `[actualServers.budgets.categoryMapping]`
2. **Existing transactions (backfill)**: Uncategorised transactions in Actual get the mapped category applied
3. **Conflicts**: When an existing transaction has a different category, the `categorySyncOnExisting` policy applies
4. **Auto-rule override detection**: After import, the importer re-fetches new transactions and warns if Actual's auto-rules changed a synced category

#### Category mapping CLI

Audit, plan, and write your category mapping from the terminal:

```bash
actual-mmi categories map -s http://localhost:5006 -b <syncId>
actual-mmi categories map -s http://localhost:5006 -b <syncId> --write-config

# Output formats for scripting
actual-mmi categories map -s http://localhost:5006 -b <syncId> --format json
actual-mmi categories map -s http://localhost:5006 -b <syncId> --format toml
```

The audit report includes:

- **Configured Mappings**: Current mappings from your config
- **Safe Suggestions**: High-confidence matches (identical category names)
- **Invalid**: Mappings pointing to non-existent Actual categories
- **Unresolved**: MoneyMoney categories without a mapping
- **Unused**: Mapped Actual categories not found in the budget
- **Next Actions**: Recommended steps to complete your mapping

With `--write-config`, the tool rewrites your `[actualServers.budgets.categoryMapping]` block with annotated comments for readability:

```toml
[actualServers.budgets.categoryMapping]
# MoneyMoney: Expenses > Living > Groceries
# Actual: Living > 🛒 Groceries
"7f5c..." = "8aa1..."
```

### Payee transformation

**This AI-powered feature** converts cryptic payee names to human-readable formats (e.g. "AMAZN S.A.R.L" to "Amazon"). The importer includes a bounded shortlist of existing budget payees in the AI prompt to prefer matching over creating duplicates, and close matches are snapped back to canonical names using a normalized Dice bigram score (configurable via `payeeMatchThreshold`, default `0.7`).

Two backends are available:

| Backend              | Processing | API Key Required | Requirements                                                      |
| -------------------- | ---------- | ---------------- | ----------------------------------------------------------------- |
| `openai` (default)   | Cloud      | Yes              | OpenAI account ([api keys](https://platform.openai.com/api-keys)) |
| `apple-intelligence` | On-device  | No               | macOS 26+ (Tahoe), Apple Silicon, Apple Intelligence enabled      |

With `apple-intelligence`, all payee data is processed locally on your Mac. Nothing is sent to any cloud service. You need the `tsfm-sdk` npm package installed (`npm install tsfm-sdk`). No API key or network access is required beyond the initial package install.

With `openai`, raw payee names and a shortlist of existing budget payees are sent to OpenAI for transformation.

See [assets/config.example.toml](assets/config.example.toml) for all options and defaults. Key options include `enabled`, `backend`, `openAiModel`, `temperature`, `prompt`, `onTransformError`, `payeeMatchThreshold`, and `maxExistingPayeesInPrompt`. Run `actual-mmi validate` to generate a fresh example at your config path.

### Automatic transfers

Enable `[import.transfers]` to create native Actual transfers from MoneyMoney transactions. The importer detects transfer pairs when the source-side transaction carries a configured transfer category, its `accountNumber` points to another mapped MoneyMoney account, and the counterpart falls within the configured match window.

| Option            | Default | Description                                                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `enabled`         | `false` | Enable automatic transfer handling                                                                                 |
| `categoryRefs`    | `[]`    | MoneyMoney transfer categories by UUID, full path, or leaf name                                                    |
| `matchWindowDays` | `0`     | Max day difference allowed when matching counterparts; also pads the MoneyMoney fetch window for transfer matching |

`categoryRefs` must be non-empty when `enabled = true`.

#### Behavior

Native Actual transfers preserve each side's date when created through the importer. With `matchWindowDays = 0`, matching stays exact-date only. When `matchWindowDays > 0`, the importer also fetches MoneyMoney transactions a few days before/after the requested import range so boundary transfers can still be matched, while only importing transactions that fall inside the requested range.

#### Supported cases

- Same-run, same-date or near-date, unique match: the importer suppresses the second plain import and stamps the generated transfer counterpart with the second `imported_id`
- Historical plain counterpart, same-date or near-date, unique match: the importer converts the existing plain booking into a transfer when the source side is later imported

#### Limitations

- Different-date pairs outside the configured window: imported as two normal transactions so each side keeps its own date
- Counterparts already part of another transfer: left untouched (the importer cannot safely prove they belong to this source transaction)
- Ambiguous target mapping: imported normally (the importer only creates transfers when the target account can be identified uniquely)
- Single-sided delayed seeds outside the configured window: not auto-created as native transfers (without a confident counterpart match, the importer cannot safely link the transfer)
- Ambiguous or weak matches: imported normally (avoids guessing and false positives)

## Advanced configuration

### Ignore patterns

Ignore patterns let you specify payee names, comments, or purposes that should be ignored. Patterns are **case-sensitive substring matches**, not exact matches. This means `"Amazon"` matches `"Amazon.com"` but not `"amazon"`.

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

## Security

The configuration file (default: `~/.actually/config.toml`) may contain Actual passwords and OpenAI API keys in plaintext if you enter literal values. Prefer environment-variable references (`${MY_VAR}`) for secrets. The Apple Intelligence backend keeps all data on-device and requires no secrets. To protect your secrets:

- Keep the config file private: `chmod 600 ~/.actually/config.toml`
- Prefer `https://` for remote Actual servers. The importer will warn if you use cleartext HTTP to a non-localhost server, since passwords would be sent in plaintext.
- Avoid committing the config file to version control.

## Troubleshooting

| Problem                                                                                        | Likely cause / solution                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MoneyMoney database is locked`                                                                | Unlock MoneyMoney and try again. MoneyMoney must be running and unlocked during import.                                                                                     |
| `Failed to connect to Actual server`                                                           | Ensure the Actual server is running and reachable at the configured `serverUrl`. Try `curl <serverUrl>` in a terminal.                                                      |
| `No matching Actual servers found for --server filter`                                         | The `--server` / `-s` filter matches against the **exact URL** from your config (e.g. `http://localhost:5006`), not a nickname or label.                                    |
| `No matching budgets found`                                                                    | The `--budget` / `-b` filter matches against the **sync ID** from your config, not the budget name.                                                                         |
| `No matching MoneyMoney accounts found`                                                        | Make sure MoneyMoney is unlocked and the account is mapped in `[actualServers.budgets.accountMapping]`.                                                                     |
| `Invalid configuration file`                                                                   | Run `actual-mmi validate` to see specific errors. Check that `syncId` is the budget sync ID (not the name) and `serverUrl` is a valid URL.                                  |
| `E2E encryption password is required`                                                          | If your Actual budget uses end-to-end encryption, set `enabled = true` and provide the `password` in `[actualServers.budgets.e2eEncryption]`.                               |
| OpenAI model error (the default model is unavailable for your account)                         | The default model is `gpt-5.4-nano`. Set `payeeTransformation.openAiModel` to a model available on your OpenAI account (e.g. `gpt-4o-mini`).                                |
| `Apple Intelligence backend is unavailable`                                                    | Requires macOS 26+ (Tahoe), Apple Silicon (M1 or later), and Apple Intelligence enabled in System Settings. Also ensure `tsfm-sdk` is installed.                            |
| `Category sync policy 'ask' requires an interactive terminal`                                  | Use `-C=new` or `-C=always` when running in a non-interactive environment (CI, cron, launchd).                                                                              |
| Auto-rule override warning: "Actual's rules changed the category of transaction X from Y to Z" | This is informational. Add a corresponding rule in Actual, or adjust the rule ordering so it doesn't conflict with the synced category.                                     |
| Duplicate `imported_id` in Actual budget                                                       | Actual contains multiple transactions with the same importer ID. Inspect/merge/delete the duplicate transactions before relying on category backfill or duplicate skipping. |

## Support

Please file bugs and feature requests as GitHub issues.

## Contributing and releases

Stable releases are cut from `main` and published on GitHub and npm under the `actual-moneymoney-importer` package name. See `.github/PULL_REQUEST_TEMPLATE.md` for contribution guidelines.
