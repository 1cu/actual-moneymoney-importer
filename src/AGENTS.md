# Source Code Guidelines for `actual-moneymoney`

## CLI structure (`src/index.ts`)

- `src/index.ts` initialises the CLI, ensures the application data directory exists, and registers command modules
- Global options: `--config` for alternative TOML path, `--logLevel` for Logger verbosity (0-3)
- The parser uses `.fail()` to surface yargs validation errors as real `Error` instances

## Command modules (`src/commands/`)

### General expectations

- Export a default `CommandModule<ArgumentsCamelCase>`
- Keep handlers async and delegate to a `handle*` helper to keep the exported module lightweight
- Always resolve configuration via `getConfig(argv)` so shared CLI flags stay consistent
- Instantiate `Logger` with the requested log level and reuse it for all logging

### `import.command.ts`

- Supports filters for server (`--server`), budget (`--budget`), account (`--account`), and date ranges (`--from`, `--to`)
- Parse dates with `date-fns/parse` using `DATE_FORMAT` from `src/utils/shared.ts`
- Require at least one Actual server in the configuration
- Before importing, call `checkDatabaseUnlocked()` from `moneymoney` and fail fast if locked
- For each selected server/budget combination:
  - Create an `ActualApi` instance, call `init()`, then `loadBudget()` before performing any work, and always `shutdown()` inside a `finally` block
  - Build an `AccountMap` and load it up front via `loadFromConfig()`
  - Instantiate `Importer` with the resolved config, budget, API, logger, account map, and optional `PayeeTransformer`
  - Pass `isDryRun` through to `Importer.importTransactions()`

### `validate.command.ts`

- Uses `getConfigFile(argv)` to resolve the path and logs which file was inspected
- If the file does not exist, create it using `EXAMPLE_CONFIG` from `src/utils/shared.ts`
- Parse the TOML file, validate against `configSchema`, and print Zod issues with `path`, `code`, and `message` details

## Utilities (`src/utils/`)

### `config.ts`

- Central Zod schema (`configSchema`) describes the entire configuration
- `budgetSchema` enforces end-to-end encryption requirements (password required when enabled)
- `getConfig(argv)` handles missing files, TOML parsing, and schema validation
- Maintain constants such as `DEFAULT_ACTUAL_REQUEST_TIMEOUT_MS` (5 minutes) and `FALLBACK_ACTUAL_REQUEST_TIMEOUT_MS` (45 seconds)

### `shared.ts`

- Exposes reusable constants: `DATE_FORMAT`, `APPLICATION_DIRECTORY`, `DEFAULT_DATA_DIR`, `DEFAULT_CONFIG_FILE`
- `EXAMPLE_CONFIG` string used by the `validate` command

### `Logger.ts`

- Provides a coloured console logger with four levels (`ERROR`, `WARN`, `INFO`, `DEBUG`)
- All code should log via this utility instead of `console.log` directly
- Use the `hint` argument to provide contextual details

### `ActualApi.ts`

- Wraps `@actual-app/api` and provides higher-level helpers (`init`, `loadBudget`, `getAccounts`, `getTransactions`, `importTransactions`, `shutdown`)
- All SDK calls must go through `runActualRequest()` to benefit from timeout protection, noise suppression, and consistent error logging
- Console output from Actual is noisy; `patchConsole()` filters known prefixes
- `ActualApiTimeoutError` is thrown when requests exceed the configured timeout

### `AccountMap.ts`

- Fetches MoneyMoney accounts via `getAccounts()` and Actual accounts via `ActualApi.getAccounts()`
- Supports flexible account references (UUID, account number, or name for MoneyMoney; ID or name for Actual)
- `loadFromConfig()` must be called before `getMap()`

### `Importer.ts`

- Orchestrates fetching MoneyMoney transactions, filtering them, and pushing new entries into Actual
- Respect budget-level settings: `earliestImportDate`, `importUncheckedTransactions`, `synchronizeClearedStatus`, `ignorePatterns`
- Build Actual transactions with the correct identifiers so duplicates can be detected
- Honour dry-run mode by skipping `ActualApi.importTransactions()`

### `PayeeTransformer.ts`

- Integrates with the OpenAI API to normalise payee names
- Validate configuration in the constructor (require `openAiApiKey` when enabled)
- Cache model lookups on disk and keep the in-memory `transformationCache` for repeated payees
- Respect the masking configuration when logging payee names

### `types/`

- Contains custom type declarations/augmentations for the Actual SDK

## Coding standards

- TypeScript files use 4-space indentation, single quotes, semicolons, and Prettier-enforced wrapping
- This project is ESM-first. When importing internal modules, include the `.js` extension
- Group imports by origin: external dependencies first, then Node built-ins, then internal modules
- Keep functions and classes strongly typed; avoid implicit `any` by leveraging existing types

## Complexity Prevention

**CRITICAL**: Follow complexity prevention guidelines to avoid overengineering:

- **File size limits**: Utility files max 400 lines, commands max 300 lines
- **Delete over abstract**: Remove complexity instead of refactoring
- **Inline simple functionality**: Don't create files for trivial functions
- **Avoid over-engineering**: Question every abstraction
- **Keep tests simple**: Minimal fixtures, avoid over-mocking

### Anti-patterns to avoid

- Complex caching with TTL, disk persistence, and performance optimization
- Multiple fallback layers and complex error recovery
- Generic abstractions that hide complexity
- Over-mocking in tests
- Complex configuration with too many flags

### Preferred patterns

- Simple, direct code that's readable by new developers
- Minimal error handling with clear error messages
- Single-purpose utilities with focused interfaces
- Simple test data and minimal fixtures
- Direct API calls without unnecessary abstraction layers

## Testing expectations

- Add or update Vitest coverage in `tests/` whenever changing behaviour
- There is no requirement to chase 100% coverage—lean suites that guard critical flows are preferred
- Use `vi.mock()` to isolate external services (`@actual-app/api`, `moneymoney`, `openai`) and prefer per-test resets via `beforeEach`/`afterEach`
