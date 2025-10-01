# Actual-MoneyMoney

![Actual-MoneyMoney Logo](./assets/actual-moneymoney.png)

A CLI to import [MoneyMoney](https://moneymoney-app.com) transactions into
[Actual Budget](https://actualbudget.org), written in TypeScript

> **Fork Notice**: This is an enhanced fork of
> [NikxDa/actual-moneymoney](https://github.com/NikxDa/actual-moneymoney) with
> significant improvements including targeted regression coverage, enhanced
> error handling, timeout management, and advanced configuration options.

![GitHub Checks](https://badgers.space/github/checks/1cu/actual-moneymoney/develop)

## Enhanced Features (Fork Improvements)

This fork includes significant enhancements over the upstream version:

- **🧪 Targeted Testing**: Focused Vitest suite exercising the essential API,
  importer, and payee transformation paths—no push for 100% coverage
- **⏱️ Timeout Management**: Configurable request timeouts with proper cleanup
  and error handling
- **🔒 Privacy Protection**: Payee log masking to protect sensitive financial
  data
- **🎯 Server Filtering**: Import specific accounts from selected MoneyMoney
  servers
- **🤖 Enhanced AI**: Improved OpenAI integration with configurable models and
  better error handling
- **📊 Better Logging**: Structured logging with proper error reporting and debug
  information
- **🔇 Smart Console Filtering**: Intelligent suppression of noisy Actual SDK output
  with categorized debug logging
- **🔄 Robust Imports**: Enhanced transaction deduplication and retry mechanisms
- **⚙️ Advanced Configuration**: Extended TOML configuration with timeout and
  filtering options

## Table of Contents

- [Installation](#installation)
- [Dependencies](#dependencies)
- [Developer Onboarding](#developer-onboarding)
- [Configuration](#configuration)
    - [Basic Configuration](#basic-configuration)
    - [Advanced Configuration](#advanced-configuration)
    - [Payee Transformation](#payee-transformation)
- [Usage](#usage)
- [Development](#development)
- [Account Mapping](#account-mapping)
- [Troubleshooting](#troubleshooting)

## Installation

Install with NPM:

```bash
npm i -g actual-monmon
```

The application will be accessible as a CLI tool with the name `actual-monmon`.

## Dependencies

- Node.js **v20.9.0 or newer** (see `package.json` `engines` field)
- A licensed copy of MoneyMoney on macOS to access the transaction database

**Note on zod version**: This project must remain on zod v3 due to a peer
dependency conflict with the openai package. We currently depend on
`zod@^3.25.76`, which keeps us on the 3.x line (openai requires `^3.23.8`) while
still allowing Dependabot to deliver minor and patch releases. We'll move to zod
v4 once openai ships a compatible update.

## Developer Onboarding

New to the project? Follow these steps to get your development environment
ready:

1. Confirm you are running Node.js **v20.9.0 or newer**.

1. Install dependencies after cloning the repository:

    ```bash
    npm install
    ```

1. Run the quality gates to ensure linting, type checks, the build, and tests
   all pass:

    ```bash
    npm run lint:all && npm run typecheck && npm test
    ```

1. Read through the detailed [contributor guide](./CONTRIBUTING.md) for workflow
   expectations, helpful scripts, and documentation requirements.

The [Development](#development) section later in this document highlights the
most frequently used scripts if you need a quick refresher.

## Configuration

The application needs to be configured with a TOML document to function. By
default, Actual-MoneyMoney stores and reads configuration files from
`~/.actually/config.toml`.

You can validate (and automatically create) your configuration by running
`actual-monmon validate`. If the configuration file does not exist yet, the
command will create a starter file at the resolved path (default:
`~/.actually/config.toml`). When the file already exists, `validate` leaves it
unchanged and only reports schema issues. You can point to a different location
with the `--config <path>` option when running any command.

For detailed command-line options, run `actual-monmon --help`.

### Basic Configuration

A basic configuration document looks like this:

```toml
# Payee transformation
[payeeTransformation]
enabled = false
openAiApiKey = "<openAiKey>"  # Your OpenAI API key
openAiModel = "gpt-3.5-turbo"  # Optional: Specify the OpenAI model to use
# payee transformation debug logs

# Import settings
[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
# with deterministic placeholders

# Actual servers, you can add multiple servers
[[actualServers]]
serverUrl = "http://localhost:5006"
serverPassword = "<password>"
# requestTimeoutMs = 45000  # Optional: Override the Actual server request
# timeout in milliseconds (e.g., 45000 = 45 seconds, 300000 = 5 minutes)
# max 300000 ms (5 minutes)

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
```

### Advanced Configuration

For advanced configuration options including custom AI prompts, model-specific
settings, and comprehensive examples, see the
[advanced configuration example](./example-config-advanced.toml) file. This file
demonstrates:

- Custom AI prompts for payee transformation
- Model-specific configuration (temperature, max tokens, timeout)
- Multiple server and budget configurations
- E2E encryption settings
- Ignore patterns for transaction filtering
- Privacy controls for payee logging
- Detailed model compatibility information

### Payee Transformation

The payee transformation feature automatically converts payee names to
human-readable formats (e.g., "AMAZN S.A.R.L" to "Amazon"). To use this feature:

1. Set `enabled = true` in the `[payeeTransformation]` section
1. Provide a valid OpenAI API key (generate one at
   [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys))
1. Optionally customize the AI model and settings
1. (Optional) Set `skipModelValidation = true` if you want to trust the
   configured model identifier without contacting the OpenAI model listing
   endpoint

When payee transformation is enabled, importer debug logs replace payees with deterministic placeholders
(e.g., `PAYEE#1234ABCD`) so you can trace individual entries without exposing original names. When the
feature is disabled, importer debug logs show raw payee names.

#### Custom Prompts

You can override the default AI classification prompt with your own
instructions:

```toml
[payeeTransformation]
customPrompt = """
Your custom classification instructions here...
Make sure to instruct the model to return valid JSON.
"""
```

#### Model Configuration

Advanced model settings can be configured:

```toml
[payeeTransformation.modelConfig]
temperature = 0.0  # 0.0 = deterministic, 1.0 = creative (0.0-2.0)
maxTokens = 1000   # Maximum tokens in response
timeout = 30000    # Request timeout in milliseconds
```

**Note**: GPT-4o and GPT-5 models accept temperatures between 0.0 and 2.0. They
default to ~0.7 but you can override this for deterministic behavior.

Model validation and payee lookups are cached to keep imports fast and avoid
unnecessary OpenAI requests. The model list is stored for one hour in the
application data directory, and transformed payee names are memoized within a
single import run. Combine these caches with `skipModelValidation = true` if
your environment restricts model listing requests.

### Configuration Summary

- **Payee transformation**: Automatically standardize payee names using AI
- **Import settings**: Customize import behavior (unchecked transactions,
  cleared status, payee masking in logs)
- **Actual servers**: Specify which Actual Budget servers to import to
- **Budget configurations**: Define budget files per server with sync IDs
- **E2E encryption**: Handle encrypted budget files
- **Account mapping**: Map MoneyMoney accounts to Actual accounts
- **Ignore patterns**: Filter transactions with case-insensitive `*` wildcards
  for comments, payees, and purposes

### Default Configuration Values

When configuration values are not explicitly set, the following defaults are used:

| Configuration Key                                  | Default Value   | Description                                         |
| -------------------------------------------------- | --------------- | --------------------------------------------------- |
| `payeeTransformation.enabled`                      | `false`         | Disable AI payee transformation by default          |
| `payeeTransformation.openAiModel`                  | `"gpt-4o-mini"` | Use cost-effective model for transformations        |
| `payeeTransformation.cacheTransformedPayees`       | `true`          | Cache transformations to avoid repeated API calls   |
| `importSettings.uncheckedTransactions`             | `true`          | Import transactions as unchecked by default         |
| `importSettings.clearedTransactions`               | `false`         | Import transactions as uncleared by default         |
| `importSettings.maskPayeesInLogs`                  | `true`          | Mask payee names in logs for privacy                |
| `importSettings.importSince`                       | `null`          | No date filter by default (import all transactions) |
| `importSettings.importUntil`                       | `null`          | No end date filter by default                       |
| `importSettings.ignorePatterns.comments`           | `[]`            | No comment patterns to ignore                       |
| `importSettings.ignorePatterns.payees`             | `[]`            | No payee patterns to ignore                         |
| `importSettings.ignorePatterns.purposes`           | `[]`            | No purpose patterns to ignore                       |
| `actualServers`                                    | `[]`            | No servers configured by default                    |
| `actualServers[].budgets[].e2eEncryption.enabled`  | `false`         | No encryption by default                            |
| `actualServers[].budgets[].e2eEncryption.password` | `null`          | No encryption password by default                   |

**Debug Configuration**: Use `--logLevel 3` to see the full effective configuration.

## Usage

### Validation

Before importing, validate your configuration:

```bash
actual-monmon validate
```

You can increase or decrease CLI verbosity with `--logLevel` (`0 = ERROR`,
`1 = WARN`, `2 = INFO`, `3 = DEBUG`). Combine it with `--config` to validate a
different configuration file:

```bash
actual-monmon validate --config ./config.toml --logLevel 3
```

### Import Transactions

To import transactions:

```bash
actual-monmon import
```

You can limit the scope of an import with additional flags:

- `--server <url>` – import only budgets associated with the specified Actual
  server URL. Repeat the flag to include multiple servers.
- `--budget <syncId>` – restrict imports to the given Actual budget sync ID.
  Repeat for multiple budgets.
- `--account <ref>` – import transactions from a specific MoneyMoney account
  reference.
- `--from YYYY-MM-DD` / `--to YYYY-MM-DD` – bound the transaction date range.
- `--dry-run` – simulate the import without persisting any changes.
- `--logLevel <0-3>` – control CLI verbosity (defaults to `2`, INFO).
- `--config <path>` – load a configuration file from a custom path.

### Console Output Filtering

The CLI automatically filters noisy Actual SDK console output to provide a cleaner user experience. By default, common SDK messages like "Got messages from server", "Syncing since", and "Performing transaction reconciliation" are suppressed unless DEBUG logging is enabled.

#### How Console Filtering Works

- **Automatic Suppression**: Noisy Actual SDK output is automatically detected and suppressed

- **Categorized Debug Logging**: When `--logLevel 3` (DEBUG) is enabled, suppressed messages are logged with categories:
    - `[NETWORK:SYNC]` - Network synchronization messages
    - `[DATA:BUDGET]` - Budget loading and saving operations
    - `[DATA:RECONCILIATION]` - Transaction reconciliation processes
    - `[DATA:MIGRATION]` - Database migration operations
    - `[DATA:DEBUG]` - Debug data with structured JSON formatting

#### Debug Data Processing

When the Actual SDK emits "Debug data for the operations:" messages, the CLI:

- Converts complex objects to properly formatted JSON
- Handles circular references gracefully with fallback serialization
- Adds metadata including timestamps and source information
- Preserves all debug information in structured format

#### Performance Optimization

The console filtering system includes performance optimizations:

- **Pattern Caching**: Repeated console output patterns are cached for faster processing
- **Memory Management**: Cache size is limited to prevent memory leaks
- **Efficient Regex Matching**: Optimized pattern matching for common SDK output

#### Examples

```bash
# See all console output including filtered messages
actual-monmon import --logLevel 3

# Normal operation (filtered output)
actual-monmon import
```

### Command Options

For all available commands and options:

```bash
actual-monmon --help
```

## Development

For detailed workflows, see [CONTRIBUTING.md](./CONTRIBUTING.md). Helpful npm
scripts when working on the project:

- `npm run lint:all` – run all linters (ESLint, complexity, file length, Prettier).
- `npm run lint:complexity` – enforce the cyclomatic (max 40) and cognitive (max
  60\) complexity budgets for the source tree.
- `npm run lint:prettier` – check formatting with Prettier.
- `npm run typecheck` – perform a strict TypeScript type check without emitting
  files.
- `npm run build` – compile the CLI for distribution.
- `npm test` – execute the Vitest suite (includes build step).

Markdown files are formatted with `mdformat` (CodeRabbit runs it during review).
Run `mdformat <files>` locally when updating docs to keep diffs clean.

The repository includes Husky hooks to keep the working tree clean:

- `pre-commit` runs `npm run lint:all` and
  `npm run lint:complexity` to block formatting, lint, or complexity violations.
- `pre-push` runs the quality gates so that pushes only succeed when the entire
  local CI suite is green.

Tests exist to guard the most important scenarios. Keep the high-value suites
running, but there is no expectation of exhaustive coverage or 100% coverage.

## Account Mapping

Account mapping connects MoneyMoney accounts to Actual Budget accounts:

**MoneyMoney accounts** can be identified by:

1. UUID (via AppleScript API)
1. Account number (IBAN, credit card number, etc.)
1. Account name

**Actual accounts** can be identified by:

1. UUID (from browser URL)
1. Account name

If multiple accounts have the same name, the first match will be used. When an
import runs without account filters, any mapping that cannot be resolved will
fail the run so you can fix the configuration instead of importing a partial
set of accounts.

## Troubleshooting

### Common Issues

1. **Configuration validation errors**: Run `actual-monmon validate` to see
   detailed error messages
1. **Import failures**: Check your server URLs, passwords, and sync IDs
1. **Payee transformation not working**: Verify your OpenAI API key and model
   settings
1. **Account mapping issues**: Ensure account names/IDs match exactly. The
   importer fails fast when a configured mapping cannot be resolved during an
   unconstrained import.

### Getting Help

- Run `actual-monmon --help` for command-line options
- Use `actual-monmon validate` to check your configuration
- Check the [advanced configuration example](./example-config-advanced.toml) for
  complex setups
- Review the configuration schema and error messages for specific issues
