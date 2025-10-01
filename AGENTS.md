# Contributing Guidelines for `actual-moneymoney`

## Project overview

- TypeScript CLI that synchronises MoneyMoney accounts and transactions into Actual Budget
- Entry point: `src/index.ts` wires CLI options and registers command modules
- Distribution build: `npm run build` emits ESM output into `dist/`

## Repository layout

- `src/`: CLI commands, utilities, shared constants, and internal type augmentations
- `tests/`: Vitest unit tests that mirror the source structure
- `example-config-advanced.toml`: Configuration example that must stay in sync with the Zod schema

## Development workflow

1. Ensure Node.js **v20.9.0** or newer
2. Install dependencies with `npm install`
3. Run the quality gates: `npm run lint:all && npm run typecheck && npm test`

Tests cover the most important paths; we do not require 100% coverage. Keep critical scenarios healthy.

## Complexity Prevention

**CRITICAL**: Follow complexity prevention guidelines to avoid overengineering:

- **File size limits**: Utility files max 400 lines, commands max 300 lines
- **Delete over abstract**: Remove complexity instead of refactoring
- **Inline simple functionality**: Don't create files for trivial functions
- **Avoid over-engineering**: Question every abstraction
- **Keep tests simple**: Minimal fixtures, avoid over-mocking

### Source updates

- Configuration changes require updates to:
  - `src/utils/config.ts`
  - `src/utils/shared.ts`
  - `example-config-advanced.toml`
  - `README.md`
  - Relevant tests in `tests/config.test.ts`
- When adding new CLI functionality, mirror the existing command pattern under `src/commands/`
- Internal API augmentations live in `src/types/`

### Documentation

- Update README when behaviour changes
- Markdown formatting is enforced with `mdformat`

## Commit messages

- Follow [Conventional Commits](https://www.conventionalcommits.org/) specification
- Start messages with a valid **type** (e.g., `feat`, `fix`, `docs`, `chore`)
- Keep the subject under 72 characters and avoid ending it with a period

## Quality Gates

All changes must pass:

- `npm run lint:all` - All linting (ESLint with complexity and file length rules, Prettier)
- `npm run typecheck` - TypeScript compilation
- `npm test` - All tests passing

## Complexity Prevention Principles

- **DELETE over ABSTRACT** - Remove complexity instead of refactoring
- **SIMPLIFY over OPTIMIZE** - Simple approaches work better than complex ones
- **QUESTION every abstraction** - Many "helpers" are actually over-engineering
- **Focus on essential functionality** - Avoid premature optimization
