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

### Command Module Structure

#### Export Pattern

```typescript
export default {
    command: 'import',
    describe: 'Import data from MoneyMoney',
    builder: (yargs) => {
        return yargs
            .option('dry-run', {
                type: 'boolean',
                describe: 'Do not import data',
            })
            .option('server', {
                type: 'string',
                describe: 'Filter by server URL',
            });
    },
    handler: async (argv) => {
        await handleImport(argv);
    },
} as CommandModule<ArgumentsCamelCase>;
```

#### Handler Pattern

```typescript
async function handleImport(argv: ArgumentsCamelCase): Promise<void> {
    const { config } = await loadConfig(argv);
    const logger = new Logger(argv.logLevel);

    // Command logic here
}
```

### Command Options

#### Common Options

- **`--config`**: Alternative TOML configuration path
- **`--logLevel`**: Logger verbosity (0-3)
- **`--dry-run`**: Do not perform actual operations
- **`--help`**: Show command help

#### Filter Options

- **`--server`**: Filter by server URL
- **`--budget`**: Filter by budget sync ID
- **`--account`**: Filter by account name or UUID
- **`--from`**: Start date for import range
- **`--to`**: End date for import range

### Command Implementation

#### Import Command

```typescript
// src/commands/import.command.ts
export default {
    command: 'import',
    describe: 'Import transactions from MoneyMoney to Actual Budget',
    builder: (yargs) => {
        return yargs
            .option('dry-run', {
                type: 'boolean',
                describe: 'Do not import data',
            })
            .option('server', {
                type: 'string',
                describe: 'Filter by server URL',
            })
            .option('budget', {
                type: 'string',
                describe: 'Filter by budget sync ID',
            });
    },
    handler: async (argv) => {
        await handleImport(argv);
    },
} as CommandModule<ArgumentsCamelCase>;
```

#### Validate Command

```typescript
// src/commands/validate.command.ts
export default {
    command: 'validate',
    describe: 'Validate configuration file',
    builder: (yargs) => {
        return yargs
            .option('config', {
                type: 'string',
                describe: 'Configuration file path',
            });
    },
    handler: async (argv) => {
        await handleValidate(argv);
    },
} as CommandModule<ArgumentsCamelCase>;
```

### Command Logic

#### Configuration Loading

```typescript
async function handleImport(argv: ArgumentsCamelCase): Promise<void> {
    const { config } = await loadConfig(argv);
    const logger = new Logger(argv.logLevel);

    // Validate configuration
    if (config.actualServers.length === 0) {
        throw new Error('No Actual servers configured');
    }

    // Command logic here
}
```

#### Error Handling

```typescript
try {
    await handleImport(argv);
} catch (error) {
    logger.error(`Import failed: ${error.message}`);
    process.exit(1);
}
```

#### Date Parsing

```typescript
import { parse } from 'date-fns';
import { DATE_FORMAT } from '../utils/shared.js';

const fromDate = argv.from ? parse(argv.from, DATE_FORMAT, new Date()) : undefined;
const toDate = argv.to ? parse(argv.to, DATE_FORMAT, new Date()) : undefined;
```

### Complexity Prevention in Commands

#### Keep Commands Simple

- **Single responsibility**: Each command should do one thing well
- **Simple error handling**: Clear error messages without complex recovery
- **Direct API calls**: Avoid unnecessary abstraction layers
- **Question every abstraction**: Does it solve a real problem?

#### Command Anti-Patterns

```typescript
// ❌ DON'T: Complex command orchestration
class ComplexCommandOrchestrator {
    private validator: CommandValidator;
    private transformer: CommandTransformer;
    private executor: CommandExecutor;
    private reporter: CommandReporter;

    async orchestrate(command: string, options: any): Promise<void> {
        const validated = await this.validator.validate(command, options);
        const transformed = await this.transformer.transform(validated);
        const result = await this.executor.execute(transformed);
        await this.reporter.report(result);
    }
}

// ✅ DO: Simple command handling
async function handleImport(argv: ArgumentsCamelCase): Promise<void> {
    const { config } = await loadConfig(argv);
    const logger = new Logger(argv.logLevel);

    // Direct command logic
    await importTransactions(config, logger);
}
```

#### Preferred Patterns

- Simple, direct command handling
- Clear error messages for command failures
- Minimal command options
- Direct API calls without unnecessary abstraction
- Simple configuration loading

### Testing Commands

#### Test Structure

```typescript
// tests/commands/import.command.test.ts
describe('Import Command', () => {
    it('handles valid configuration', async () => {
        const argv = { config: 'test-config.toml', logLevel: 1 };
        await expect(handleImport(argv)).resolves.not.toThrow();
    });

    it('throws error for missing configuration', async () => {
        const argv = { config: 'missing.toml', logLevel: 1 };
        await expect(handleImport(argv)).rejects.toThrow('Configuration file not found');
    });
});
```

#### Mocking External Dependencies

```typescript
import { vi } from 'vitest';

vi.mock('@actual-app/api');
vi.mock('moneymoney');
vi.mock('openai');

beforeEach(() => {
    vi.clearAllMocks();
});
```

### Documentation

#### Command Documentation

- **README.md** - Command usage examples
- **Help text** - Clear command descriptions
- **Option descriptions** - Detailed option explanations
- **Error handling** - Common issues and solutions

#### Documentation Maintenance

- Keep command documentation up to date
- Update examples when adding new options
- Document breaking changes in command interface
- Provide migration guidance for command updates

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

## Configuration and Validation Patterns

### Configuration Schema

#### Central Schema Location

- Main schema in [src/utils/config.ts](mdc:src/utils/config.ts)
- Example configuration in [example-config-advanced.toml](mdc:example-config-advanced.toml)
- Keep schema and example in sync

#### Schema Structure

```typescript
export const configSchema = z.object({
    payeeTransformation: payeeTransformationSchema,
    import: z.object({
        importUncheckedTransactions: z.boolean().default(false),
        synchronizeClearedStatus: z.boolean().default(false),
        maskPayeesInLogs: z.boolean().default(false),
        ignorePatterns: z.object({
            comments: z.array(z.string()).optional(),
            payees: z.array(z.string()).optional(),
            purposes: z.array(z.string()).optional(),
        }).optional(),
    }),
    actualServers: z.array(actualServerSchema),
});
```

### Configuration Schema Loading

#### Simple Configuration Loading

```typescript
export async function loadConfig(argv: ArgumentsCamelCase): Promise<{ config: Config }> {
    const configFile = getConfigFile(argv);

    if (!fs.existsSync(configFile)) {
        throw new Error(`Configuration file not found: ${configFile}`);
    }

    const configData = fs.readFileSync(configFile, 'utf-8');
    const parsed = parseToml(configData);
    const config = configSchema.parse(parsed);

    return { config };
}
```

#### Configuration Error Handling

- **Clear error messages** with file path and line information
- **Zod validation errors** with specific field details
- **Missing file handling** with actionable guidance
- **Simple error propagation** without complex recovery

### Configuration Updates

When changing configuration schema, update:

1. **Schema definition** in [src/utils/config.ts](mdc:src/utils/config.ts)
2. **Constants and defaults** in [src/utils/shared.ts](mdc:src/utils/shared.ts)
3. **Example configuration** in [example-config-advanced.toml](mdc:example-config-advanced.toml)
4. **Documentation** in [README.md](mdc:README.md)
5. **Test coverage** in [tests/config.test.ts](mdc:tests/config.test.ts)

### Complexity Prevention in Configuration

#### Keep Configuration Simple

- **Avoid complex decision tracking** - don't log every default decision
- **Use simple validation** - basic Zod schemas without over-engineering
- **Prefer explicit over implicit** - clear configuration options
- **Remove unused options** - delete configuration that's not needed

#### Configuration Anti-Patterns

```typescript
// ❌ DON'T: Complex default decision tracking
interface ConfigDefaultDecision {
    path: string;
    value: unknown;
    hints?: string[];
    metadata?: Record<string, unknown>;
    timestamp?: Date;
    source?: string;
}

// ✅ DO: Simple configuration loading
interface Config {
    serverUrl: string;
    password: string;
    timeout: number;
}
```

#### Preferred Configuration Patterns

- Simple, direct configuration loading
- Clear error messages for validation failures
- Minimal configuration options
- Explicit configuration values
- Simple validation without over-engineering

### TOML Configuration

#### Configuration Management

- **Example**: [example-config-advanced.toml](mdc:example-config-advanced.toml)
- **Validation**: Use `actual-monmon validate` to check configuration
- **CLI Binary**: `actual-monmon` (see [package.json](mdc:package.json) bin field)
- **Custom Path**: Use `--config` parameter for custom config location

#### TOML Structure

```toml
[payeeTransformation]
enabled = true
openAiApiKey = "your-api-key"
model = "gpt-3.5-turbo"

[import]
importUncheckedTransactions = false
synchronizeClearedStatus = false
maskPayeesInLogs = false

[[actualServers]]
url = "https://actual.example.com"
password = "your-password"
budgets = [
    { syncId = "budget-1", filePath = "/path/to/budget.actual" }
]
```

### Validation Patterns

#### Zod Schema Validation

```typescript
const budgetSchema = z.object({
    syncId: z.string(),
    filePath: z.string(),
    earliestImportDate: z.string().optional(),
    e2eEncryption: z.object({
        enabled: z.boolean(),
        password: z.string().optional(),
    }).refine(
        (data) => !data.enabled || data.password,
        { message: "Password is required when E2E encryption is enabled" }
    ),
});
```

#### Validation Error Handling

- **Zod validation errors** with specific field details
- **Clear error messages** for missing required fields
- **Actionable guidance** for configuration issues
- **Simple error propagation** without complex recovery

### Testing Configuration

#### Test Coverage

- **Success cases** - valid configuration loading
- **Failure cases** - invalid configuration handling
- **Edge cases** - missing files, malformed TOML
- **Validation errors** - Zod schema validation failures

#### Test Patterns

```typescript
describe('Configuration Loading', () => {
    it('loads valid configuration', async () => {
        const config = await loadConfig({ config: 'valid-config.toml' });
        expect(config.config.actualServers).toHaveLength(1);
    });

    it('throws error for missing file', async () => {
        await expect(loadConfig({ config: 'missing.toml' }))
            .rejects.toThrow('Configuration file not found');
    });
});
```

### Configuration Documentation

#### Configuration Documentation Details

- **README.md** - Installation and usage examples
- **Example config** - Complete working example
- **Schema documentation** - Field descriptions and types
- **Error handling** - Common issues and solutions

#### Configuration Documentation Maintenance

- Keep documentation up to date with schema changes
- Update examples when adding new configuration options
- Document breaking changes in configuration schema
- Provide migration guidance for configuration updates

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
- Reuse the in-memory `transformationCache` for repeated payees; no disk cache is required after the simplification
- Respect the masking configuration when logging payee names

## Utility Class Implementation Patterns

### Logger Utility

- **Colored console logger** with four levels (`ERROR`, `WARN`, `INFO`, `DEBUG`)
- **Use hint argument** to provide contextual details
- **Log via this utility** instead of `console.log` directly

### ActualApi Utility

- **Wrap @actual-app/api** with higher-level helpers
- **All SDK calls** must go through `runActualRequest()` for timeout protection
- **Console output filtering** to suppress noisy Actual SDK messages
- **Timeout handling** with `ActualApiTimeoutError`

### Configuration Utility

- **Central Zod schema** describes the entire configuration
- **Simple validation** without over-engineering
- **Maintain constants** alongside the schema
- **Handle missing files** with clear error messages

### AccountMap Utility

- **Flexible account references** (UUID, account number, or name)
- **Load from config** before using
- **Simple mapping logic** without complex abstractions

### Importer Utility

- **Orchestrate MoneyMoney to Actual** transaction flow
- **Respect budget settings** without complex configuration
- **Build correct identifiers** for duplicate detection
- **Honor dry-run mode** by skipping actual imports

### PayeeTransformer Utility

- **OpenAI integration** for payee normalization
- **Simple caching** with disk and memory storage
- **Respect masking configuration** when logging

### Complexity Prevention in Utilities

- **Keep utilities simple**: Avoid over-engineering
- **Single purpose**: Each utility should have a focused responsibility
- **Direct API calls**: Avoid unnecessary abstraction layers
- **Simple error handling**: Clear error messages without complex recovery
- **Question every abstraction**: Does it solve a real problem?

### Utility Anti-Patterns to Avoid

- Complex caching with TTL and disk persistence
- Multiple fallback layers and complex error recovery
- Generic abstractions that hide complexity
- Over-mocking in tests
- Complex configuration with too many flags

### Preferred Utility Patterns

- Simple, direct code that's readable by new developers
- Minimal error handling with clear error messages
- Single-purpose utilities with focused interfaces
- Simple test data and minimal fixtures
- Direct API calls without unnecessary abstraction layers

### `types/`

- Contains custom type declarations/augmentations for the Actual SDK

## Coding standards

### TypeScript Configuration

- **Target**: ES2016 JavaScript output
- **Module**: NodeNext for ESM compatibility
- **Strict Mode**: Enabled with `strict: true`
- **Unchecked Indexed Access**: Enabled for safer array/object access

### Code Style

- **Indentation**: 4 spaces (not tabs)
- **Quotes**: Single quotes for strings
- **Semicolons**: Always use semicolons
- **Line Length**: 80 characters maximum (enforced by Prettier)
- **Formatting**: Use Prettier with aggressive formatting (Level 3)

### Import Patterns

- **ESM Imports**: Use `.js` extension for internal modules
- **Import Order**: External dependencies first, then Node built-ins, then internal modules
- **Example**: `import Logger from './Logger.js';`

### Type Safety

- **Avoid `any`**: Use specific types or `unknown` instead
- **Leverage existing types**: Use types from utilities and configuration schema
- **Strong typing**: Keep functions and classes strongly typed
- **Type assertions**: Use sparingly and with proper type guards

### Complexity Prevention

- **Keep functions simple**: Avoid complex nested logic
- **Prefer composition**: Over inheritance
- **Use built-in types**: Instead of custom abstractions
- **Question every abstraction**: Does it solve a real problem?

### TypeScript Error Handling

- **Simple error handling**: Avoid complex error recovery patterns
- **Clear error messages**: Provide actionable error information
- **Fail fast**: Don't over-engineer error handling
- **Use specific error types**: Instead of generic error handling

### Testing

- **Mock external services**: Use `vi.mock()` for external dependencies
- **Keep tests simple**: Avoid over-mocking and complex fixtures
- **Focus on critical paths**: Don't chase 100% coverage
- **Use real data**: When possible, prefer integration over unit tests

## Source Code Complexity Prevention

**CRITICAL**: Follow complexity prevention guidelines to avoid overengineering:

- **File size limits**: Utility files max 400 lines, commands max 300 lines, tests max 300 lines
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

## Coderabbit Comment Handling

**CRITICAL**: Not all Coderabbit suggestions are necessary or beneficial. Follow these guidelines:

### **Evaluation Framework**

1. **🔴 CRITICAL - Must Fix:**
    - Security vulnerabilities (credential exposure, data leaks)
    - Data integrity issues (silent data loss, corruption)
    - System stability (crashes, infinite loops)

1. **🟠 MAJOR - Should Fix:**
    - Missing error handling for external service calls
    - Resilience improvements with simple fallback mechanisms
    - User experience improvements (clear error messages)

1. **🟡 MINOR - Nice to Have:**
    - Error message clarity improvements
    - Documentation and code comments
    - Additional debug logging (when valuable)

1. **🔵 TRIVIAL - Skip:**
    - Style suggestions (unless project standards)
    - Over-engineering simple problems
    - Premature optimization without proven need
    - Unnecessary complexity additions

### **Decision Process**

1. **Question every suggestion** - Is this fix truly necessary?
1. **Consider complexity** - Does it add unnecessary complexity?
1. **Look for simpler solutions** - Can this be solved more simply?
1. **Follow project guidelines** - Does it align with complexity prevention?

**Remember**: The best code is code that doesn't exist. Delete over refactor, inline over abstract, simplify over optimize.

## Testing expectations

- Add or update Vitest coverage in `tests/` whenever changing behaviour
- There is no requirement to chase 100% coverage—lean suites that guard critical flows are preferred
- Use `vi.mock()` to isolate external services (`@actual-app/api`, `moneymoney`, `openai`) and prefer per-test resets via `beforeEach`/`afterEach`
