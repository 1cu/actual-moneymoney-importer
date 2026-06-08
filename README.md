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

> `actual-moneymoney-importer` started as a fork of [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney) and is now actively maintained and published with added category sync, payee transformation, and richer import controls.

Run `actual-mmi --help` at any time for a full list of commands and options. For per-command help, use `actual-mmi import --help` or `actual-mmi categories map --help`.

## Highlights

- 🏷️ **Category sync** – map MoneyMoney categories to Actual automatically, with backfill and conflict resolution
- 🗺️ **`categories map` CLI** – audit, plan, and write your category mapping from the terminal
- ⚠️ **Auto-rule override detection** – get warned when Actual's rules silently change a synced category
- 🔬 **Scoped imports** – filter by server, budget, or account with repeatable `-s`/`-b`/`-a` flags
- 🤖 **AI payee transformation** – configurable prompt, OpenAI or on-device Apple Intelligence, temperature, and error-handling policy
- 💬 **Comment import** – carry MoneyMoney transaction comments into Actual notes (with configurable prefix)

## Installation

### Requirements

- macOS with [MoneyMoney](https://moneymoney-app.com) installed
- An [Actual Budget](https://actualbudget.org) server and budget
- Node.js >= 22

Install with NPM:

```bash
npm i -g actual-moneymoney-importer
```

The installed CLI command is `actual-mmi`.

### Quick Start

1. Install the CLI.
2. Run `actual-mmi validate` to create an example config and print its path.
3. Fill in your Actual server URL, budget sync ID (from Actual → Settings → Advanced), and account mapping.
4. Run `actual-mmi validate` again to check your edits.
5. Run `actual-mmi import --dry-run` to preview the import before making changes.

## Configuration

The application uses a TOML configuration file.
Run `actual-mmi validate` to validate the configuration and, on first run, generate an example file and print its path.
You can pass a custom configuration file with `--config` (alias `-c`).

See [assets/config.example.toml](assets/config.example.toml) for a full annotated example.

### Payee transformation

**This feature is macOS-only** and converts cryptic payee names to human-readable formats (e.g. "AMAZN S.A.R.L" to "Amazon"). The importer also reuses existing budget payees with a bounded shortlist and snaps close matches back to canonical names.

Two backends are available:

| Backend              | Processing | API Key Required | Requirements                                                      |
| -------------------- | ---------- | ---------------- | ----------------------------------------------------------------- |
| `openai` (default)   | Cloud      | Yes              | OpenAI account ([api keys](https://platform.openai.com/api-keys)) |
| `apple-intelligence` | On-device  | No               | macOS 26+ (Tahoe), Apple Silicon, Apple Intelligence enabled      |

With `apple-intelligence`, all payee data is processed locally on your Mac. Nothing is sent to any cloud service. You need the `tsfm-sdk` npm package installed (`npm install tsfm-sdk`). No API key or network access is required beyond the initial package install.

All options are documented in [assets/config.example.toml](assets/config.example.toml) with inline comments. Key options include `enabled`, `backend`, `temperature`, `payeeMatchThreshold`, and `maxExistingPayeesInPrompt`. Run `actual-mmi validate` to generate a fresh example at your config path.

The AI receives a bounded shortlist of existing payees from your budget to prefer matching over creating duplicates, and close matches are normalized back to existing payee names after the API call.

### Import settings

| Option                        | Default                  | Description                                                 |
| ----------------------------- | ------------------------ | ----------------------------------------------------------- |
| `importUncheckedTransactions` | `true`                   | Import transactions not yet checked in MoneyMoney           |
| `synchronizeClearedStatus`    | `true`                   | Sync MoneyMoney's cleared status to Actual                  |
| `synchronizeCategories`       | `false`                  | Enable category sync (see [Category Sync](#category-sync))  |
| `categorySyncOnExisting`      | `ask`                    | Policy for existing transactions: `ask`, `new`, or `always` |
| `importComments`              | `false`                  | Import MoneyMoney comments into Actual notes                |
| `commentPrefix`               | `"MoneyMoney Comment: "` | Prefix added to imported comments                           |

#### Automatic transfers

Enable `[import.transfers]` to create native Actual transfers from MoneyMoney transactions when the source-side transaction carries a configured transfer category, its `accountNumber` points to another mapped MoneyMoney account, and the counterpart falls within the configured match window.

| Option            | Default | Description                                                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `enabled`         | `false` | Enable automatic transfer handling                                                                                 |
| `categoryRefs`    | `[]`    | MoneyMoney transfer categories by UUID, full path, or leaf name                                                    |
| `matchWindowDays` | `0`     | Max day difference allowed when matching counterparts; also pads the MoneyMoney fetch window for transfer matching |

Native Actual transfers preserve each side's date when created through the importer.
With `matchWindowDays = 0`, matching stays exact-date only. When `matchWindowDays > 0`, the importer also fetches MoneyMoney transactions a few days before/after the requested import range so boundary transfers can still be matched, while only importing transactions that fall inside the requested range.

Supported cases:

- Same-run, same-date or near-date, unique match: the importer suppresses the second plain import and stamps the generated transfer counterpart with the second `imported_id`
- Historical plain counterpart, same-date or near-date, unique match: the importer converts the existing plain booking into a transfer when the source side is later imported

Unsupported cases:

- Different-date pairs outside the configured window: imported as two normal transactions so each side keeps its own date
- Counterparts already part of another transfer: left untouched
    - Reason: the importer cannot safely prove they belong to this source transaction
- Ambiguous target mapping: imported normally
    - Reason: the importer only creates transfers when the target account can be identified uniquely
- Single-sided delayed seeds outside the configured window: not auto-created as native transfers
    - Reason: without a confident counterpart match, the importer cannot safely link the transfer
- Ambiguous or weak matches: imported normally
    - Reason: avoid guessing and creating false positives

`categoryRefs` must be non-empty when `enabled = true`.

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

Once configured, importing is as simple as running `actual-mmi import`. Make sure the Actual servers are running and MoneyMoney is unlocked. By default, the importer processes the last month of transactions. Use `--from=YYYY-MM-DD` (alias `-f`) and optionally `--to=YYYY-MM-DD` (alias `-t`) to import a specific date range.

The importer will not track previous imports, so if you wait more than one month between imports, you might need to manually specify the last import date. Running the importer twice in the same month is no problem, as duplicate transactions will automatically be detected and skipped.

Imports can be scoped with `--server` (alias `-s`), `--budget` (alias `-b`), and `--account` (alias `-a`). Each flag is case-insensitive, can be repeated, and accepts comma-separated values. Server filtering matches against the **server URL** and budget filtering matches against the **sync ID** from your config.

```bash
# Import specific accounts
actual-mmi import -a "DKB Giro" -a "DKB Visa"
actual-mmi import -a "DKB Giro,DKB Visa"

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

Use `--log-level` (alias `-l`) to control output verbosity. Levels range from 0 (errors only) to 4 (full API noise):

```bash
# Show debug output for troubleshooting
actual-mmi import --dry-run -l 3
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

# Output formats for scripting
actual-mmi categories map -s http://localhost:5006 -b <syncId> --format json
actual-mmi categories map -s http://localhost:5006 -b <syncId> --format toml
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

### Validate command

`actual-mmi validate` checks your config file's TOML syntax and schema (required fields, types, value ranges). It does **not** verify that your Actual server is reachable, sync IDs exist, accounts map correctly, or your OpenAI key / Apple Intelligence is available. To test the full import flow without making changes, use `actual-mmi import --dry-run`.

## Advanced Configuration

The following configuration options are optional.

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

The configuration file (default: `~/.actually/config.toml`) stores your Actual server password(s) and, if using the OpenAI backend, your OpenAI API key in plaintext. The Apple Intelligence backend keeps all data on-device and requires no secrets. To protect your secrets:

- Keep the config file private: `chmod 600 ~/.actually/config.toml`
- Prefer `https://` for remote Actual servers. The importer will warn if you use cleartext HTTP to a non-localhost server, since passwords would be sent in plaintext.
- Avoid committing the config file to version control.

## Troubleshooting

| Problem                                                                                        | Likely cause / solution                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MoneyMoney database is locked`                                                                | Unlock MoneyMoney and try again. MoneyMoney must be running and unlocked during import.                                                          |
| `Failed to connect to Actual server`                                                           | Ensure the Actual server is running and reachable at the configured `serverUrl`. Try `curl <serverUrl>` in a terminal.                           |
| `No matching Actual servers found for --server filter`                                         | The `--server` / `-s` filter matches against the **exact URL** from your config (e.g. `http://localhost:5006`), not a nickname or label.         |
| `No matching budgets found`                                                                    | The `--budget` / `-b` filter matches against the **sync ID** from your config, not the budget name.                                              |
| `No matching MoneyMoney accounts found`                                                        | Make sure MoneyMoney is unlocked and the account is mapped in `[actualServers.budgets.accountMapping]`.                                          |
| `Invalid configuration file`                                                                   | Run `actual-mmi validate` to see specific errors. Check that `syncId` is the budget sync ID (not the name) and `serverUrl` is a valid URL.       |
| `E2E encryption password is required`                                                          | If your Actual budget uses end-to-end encryption, set `enabled = true` and provide the `password` in `[actualServers.budgets.e2eEncryption]`.    |
| OpenAI model error (e.g. `model 'gpt-5.4-nano' is unavailable`)                                | Set `payeeTransformation.openAiModel` to a model available on your OpenAI account (e.g. `gpt-4o-mini`).                                          |
| `Apple Intelligence backend is unavailable`                                                    | Requires macOS 26+ (Tahoe), Apple Silicon (M1 or later), and Apple Intelligence enabled in System Settings. Also ensure `tsfm-sdk` is installed. |
| `Category sync policy 'ask' requires an interactive terminal`                                  | Use `-C=new` or `-C=always` when running in a non-interactive environment (CI, cron, launchd).                                                   |
| Auto-rule override warning: "Actual's rules changed the category of transaction X from Y to Z" | This is informational. Add a corresponding rule in Actual, or adjust the rule ordering so it doesn't conflict with the synced category.          |

## Bugs

If you notice any bugs or issues, please file an issue.

## Maintenance Notes

Stable releases are cut from `main` and published on GitHub and npm under the `actual-moneymoney-importer` package name. See `.github/PULL_REQUEST_TEMPLATE.md` for contribution guidelines.
