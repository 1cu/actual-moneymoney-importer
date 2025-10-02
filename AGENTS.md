# AI Assistant Rules for `actual-moneymoney`

## Project Overview

TypeScript CLI that syncs MoneyMoney accounts/transactions to Actual Budget. Entry point: `src/index.ts`. Build output: `dist/`.

## Code Standards

### TypeScript Configuration

- **Target**: ES2016, NodeNext modules, strict mode enabled
- **Imports**: Use `.js` extension for internal modules
- **Type Safety**: No `any`, use `unknown` instead, leverage existing types
- **File Limits**: Source files 400 lines, commands 300 lines, config 200 lines, tests 300 lines

### Code Style

- **Indentation**: 4 spaces, no tabs
- **Quotes**: Single quotes for strings
- **Semicolons**: Always required
- **Line Length**: 120 characters (Prettier), 80 for comments
- **Formatting**: Prettier with aggressive formatting

### Import Order

1. External dependencies
2. Node built-ins  
3. Internal modules (with `.js` extension)

## Complexity Prevention

### Core Principles

- **DELETE over ABSTRACT**: Remove complexity instead of refactoring
- **SIMPLIFY over OPTIMIZE**: Simple approaches work better
- **QUESTION every abstraction**: Does it solve a real problem?
- **Focus on essential functionality**: Avoid premature optimization

### File Size Limits

- **Source files** (`src/**/*.ts`): 400 lines maximum
- **Commands** (`src/commands/*.ts`): 300 lines maximum  
- **Config** (`src/utils/config.ts`): 200 lines maximum
- **Tests** (`tests/**/*.ts`): 300 lines maximum

### Anti-Patterns to Avoid

- Complex caching with TTL and disk persistence
- Multiple fallback layers and complex error recovery
- Generic abstractions that hide complexity
- Over-mocking in tests
- Complex configuration with too many options

### Preferred Patterns

- Simple, direct code that's readable by new developers
- Minimal error handling with clear error messages
- Single-purpose utilities with focused interfaces
- Simple test data and minimal fixtures
- Direct API calls without unnecessary abstraction layers

## Command Implementation

### Command Structure

```typescript
export default {
    command: 'import',
    describe: 'Import data from MoneyMoney',
    builder: (yargs) => yargs.option('dry-run', { type: 'boolean' }),
    handler: async (argv) => await handleImport(argv),
} as CommandModule<ArgumentsCamelCase>;
```

### Handler Pattern

```typescript
async function handleImport(argv: ArgumentsCamelCase): Promise<void> {
    const { config } = await loadConfig(argv);
    const logger = new Logger(argv.logLevel);
    // Command logic here
}
```

### Common Options

- `--config`: Alternative TOML path
- `--logLevel`: Logger verbosity (0-3)
- `--dry-run`: Do not perform operations
- `--server`, `--budget`, `--account`: Filter options
- `--from`, `--to`: Date range filters

## Configuration Patterns

### Schema Structure

- Central Zod schema in `src/utils/config.ts`
- Example config in `example-config-advanced.toml`
- Keep schema and example in sync

### Configuration Updates

When changing schema, update:

1. `src/utils/config.ts` - Zod schema
2. `src/utils/shared.ts` - Constants and defaults
3. `example-config-advanced.toml` - Example config
4. `README.md` - Documentation
5. `tests/config.test.ts` - Test coverage

### TOML Structure

```toml
[payeeTransformation]
enabled = true
openAiApiKey = "your-api-key"

[import]
importUncheckedTransactions = false

[[actualServers]]
url = "https://actual.example.com"
password = "your-password"
```

## Testing Guidelines

### Test Organization

- Mirror source structure in `tests/`
- Use `*.test.ts` convention
- Focus on critical paths, not 100% coverage
- Mock external services (`@actual-app/api`, `moneymoney`, `openai`)

### Test Patterns

```typescript
import { vi } from 'vitest';

vi.mock('@actual-app/api');
vi.mock('moneymoney');

beforeEach(() => {
    vi.clearAllMocks();
});
```

### Test Anti-Patterns

- Complex test builders with multiple setup methods
- Over-mocking that duplicates production code
- Complex test fixtures with excessive detail
- Tests harder to understand than the code they test

## Utility Patterns

### Logger Utility

- Colored console logger with four levels (`ERROR`, `WARN`, `INFO`, `DEBUG`)
- Use hint argument for contextual details
- Log via this utility instead of `console.log`

### ActualApi Utility

- Wrap `@actual-app/api` with higher-level helpers
- All SDK calls through `runActualRequest()` for timeout protection
- Console output filtering to suppress noisy Actual SDK messages
- Timeout handling with `ActualApiTimeoutError`

### Configuration Utility

- Central Zod schema describes entire configuration
- Simple validation without over-engineering
- Handle missing files with clear error messages

## GitHub PR Comment Handling

### Automated Assessment

Use `scripts/get-comments.py` for comment processing:

```bash
python3 scripts/get-comments.py <PR_NUMBER> --assess
python3 scripts/get-comments.py <PR_NUMBER> --show <COMMENT_ID>
```

### Evaluation Framework

1. **🔴 CRITICAL - Must Fix**: Security vulnerabilities, data leaks, system crashes
2. **🟠 MAJOR - Should Fix**: Missing error handling, resilience improvements
3. **🟡 MINOR - Nice to Have**: Error message clarity, documentation
4. **🔵 TRIVIAL - Skip**: Style suggestions, over-engineering, premature optimization

### Decision Process

1. Use automated assessment guidance
2. Read comment content thoroughly
3. Evaluate necessity - is this fix truly needed?
4. Consider complexity - does it add unnecessary complexity?
5. Look for simpler solutions

### Comment Handling Anti-Patterns

- Complex error handling with multiple fallback layers
- Generic abstractions that hide complexity
- Excessive logging and debugging infrastructure
- Complex configuration with too many options
- Over-mocking in tests

## Quality Gates

### Pre-commit Checks

```bash
npm run lint:prettier:fix
npm run lint:markdown:fix  
npm run lint:eslint
npm run typecheck
npm run test:typecheck
npm test
```

### CI/CD Pipeline

- **Linting**: ESLint + Prettier + Markdownlint
- **Type Checking**: TypeScript strict mode
- **Build**: Successful compilation to `dist/`
- **Tests**: All tests passing
- **Commit Messages**: Conventional commit format

## Dependencies

### Runtime Requirements

- **Node.js**: v24.0.0+ (see `package.json` engines field)
- **ES Modules**: `"type": "module"` in package.json
- **Zod Version**: Pinned to v3.25.76 due to OpenAI compatibility

### Key Dependencies

- **@actual-app/api**: ^25.9.0 (Actual Budget API client)
- **moneymoney**: ^1.2.1 (MoneyMoney app integration)
- **yargs**: ^18.0.0 (CLI argument parsing)
- **zod**: ^3.25.76 (Schema validation)
- **date-fns**: ^4.1.0 (Date manipulation)
- **chalk**: ^5.6.2 (Colored console output)
- **openai**: ^5.23.0 (AI-powered payee transformation)

## Documentation

### Documentation Structure

- **Main Guide**: `AGENTS.md` - Project overview and AI rules
- **Source Guidelines**: `src/AGENTS.md` - Source code patterns
- **Testing Guidelines**: `tests/AGENTS.md` - Testing patterns
- **Contributing**: `CONTRIBUTING.md` - Human contributor guide

### Documentation Maintenance

- Keep documentation up to date with code changes
- Update process documentation when workflow changes
- Use `mdformat` for Markdown formatting consistency
- Include proper file references using `[filename](mdc:filename)` format

## Remember

**The best code is code that doesn't exist.**

- Delete over refactor
- Inline over abstract  
- Simplify over optimize
- Question every abstraction
- Focus on essential functionality
