# Contributing to Actual-MoneyMoney

Thanks for helping improve Actual-MoneyMoney! This guide explains how to get set up and contribute effectively.

## Prerequisites

- **Node.js v24.0.0 or newer** (see `package.json` engines field)
- **npm** (ships with Node)
- **MoneyMoney (macOS)** - only required when testing against a real database

## Local Setup

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/1cu/actual-moneymoney.git
   cd actual-moneymoney
   npm install
   ```

2. **Copy or create a configuration file** as needed (see `example-config-advanced.toml`)

3. **Run the quality gates** to ensure everything works:

   ```bash
   npm run lint:all && npm run typecheck && npm test
   ```

## Development Workflow

### 1. Create a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

### 2. Implement Your Changes

- Keep commits focused and atomic
- Follow [Conventional Commits](https://www.conventionalcommits.org/) specification
- Examples: `feat: add importer telemetry`, `fix: resolve timeout issues`, `docs: update configuration examples`

### 3. Run Quality Gates

Before committing, always run:

```bash
npm run lint:all && npm run typecheck && npm test
```

### 4. Update Documentation

- Update `README.md` when behavior changes
- Update `AGENTS.md` if you change AI assistant rules
- Update `CONTRIBUTING.md` if you change development workflow

### 5. Include Test Coverage

- Add or update Vitest coverage in `tests/` for changed logic
- Focus on critical paths, not 100% coverage
- Use `vi.mock()` to isolate external dependencies

### 6. Open a Pull Request

- Provide a clear summary of changes
- Reference any related issues
- Ensure CI passes

## Code Style and Standards

### TypeScript Configuration

- **Target**: ES2016 JavaScript output
- **Modules**: NodeNext for ESM compatibility
- **Strict Mode**: Enabled with all strict type-checking options
- **File Limits**: Source files 400 lines, commands 300 lines, config 200 lines, tests 300 lines

### Code Style Rules

- **Indentation**: 4 spaces (not tabs)
- **Quotes**: Single quotes for strings
- **Semicolons**: Always use semicolons
- **Line Length**: 120 characters (Prettier), 80 for comments
- **Imports**: Use `.js` extension for internal modules

### Import Order

1. External dependencies
2. Node built-ins
3. Internal modules (with `.js` extension)

### Complexity Prevention

- **Keep functions simple**: Avoid complex nested logic
- **Prefer composition over inheritance**
- **Use built-in types instead of custom abstractions**
- **Question every abstraction**: Does it solve a real problem?

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

### Test Anti-Patterns to Avoid

- Complex test builders with multiple setup methods
- Over-mocking that duplicates production code
- Complex test fixtures with excessive detail
- Tests that are harder to understand than the code they test

## Configuration Updates

When changing configuration schema, update:

1. `src/utils/config.ts` - Zod schema
2. `src/utils/shared.ts` - Constants and defaults
3. `example-config-advanced.toml` - Example config
4. `README.md` - Documentation
5. `tests/config.test.ts` - Test coverage

## Helpful npm Scripts

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `npm run lint:all`          | Run all linters (ESLint, Prettier, Markdownlint)           |
| `npm run lint:prettier:fix` | Automatically format files with Prettier                   |
| `npm run lint:markdown:fix` | Fix Markdown formatting issues                              |
| `npm run lint:eslint`       | Run ESLint with complexity and file length rules           |
| `npm run typecheck`         | Perform a strict TypeScript type check                     |
| `npm run build`             | Compile the CLI for distribution                            |
| `npm test`                  | Execute the Vitest suite                                    |
| `npm run ci:local`          | Run the same commands as CI                                |

## Pre-commit Hooks

The project uses Husky to run quality gates before commits:

- **Pre-commit**: Runs linting, formatting, type checking, and tests
- **Commit-msg**: Validates commit message format using commitlint

### Emergency Bypass

If you need to bypass pre-commit checks (emergency only):

```bash
HUSKY_BYPASS_PRECOMMIT=1 git commit -m "emergency fix"
```

## AI Assistant Rules

AI assistants follow rules in `AGENTS.md`. Humans should be aware of these rules but don't need to edit them unless changing the development workflow.

## Troubleshooting

### Common Issues

- **Type errors**: Run `npm run typecheck` to see detailed TypeScript errors
- **Linting errors**: Run `npm run lint:eslint` to see ESLint issues
- **Formatting issues**: Run `npm run lint:prettier:fix` to auto-fix
- **Test failures**: Check test output for specific error messages

### Getting Help

- Consult the [README](./README.md) for configuration and usage guidance
- Review the Vitest suites in `tests/` for examples of expected behavior
- File an issue with details about your environment, logs, and reproduction steps

## Questions or Support

We appreciate your contributions and attention to quality—thank you!

- **Documentation**: Check `README.md` for usage guidance
- **Examples**: Review test suites in `tests/` for expected behavior
- **Issues**: File with environment details, logs, and reproduction steps
- **AI Rules**: See `AGENTS.md` for AI assistant guidelines
