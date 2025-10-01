# Contributing to Actual-MoneyMoney

Thanks for helping improve Actual-MoneyMoney! This guide explains how to get set up and contribute.

## Prerequisites

- **Node.js v24.0.0 or newer**
- **npm** (ships with Node)
- **MoneyMoney (macOS)** - only required when testing against a real database

## Local Setup

1. Clone and install dependencies:

    ```bash
    git clone https://github.com/1cu/actual-moneymoney.git
    cd actual-moneymoney
    npm install
    ```

1. Copy or create a configuration file as needed (see `example-config-advanced.toml`)

1. Run the quality gates:

    ```bash
    npm run lint:all && npm run typecheck && npm test
    ```

## Development Workflow

1. Create a feature branch from `main`
1. Implement your changes and keep commits focused
1. Follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat: add importer telemetry`)
1. Re-run the quality gates: `npm run lint:all && npm run typecheck && npm test`
1. Update documentation alongside behaviour changes
1. Include or update Vitest coverage for changed logic under `tests/`
1. Open a pull request with a clear summary

## Configuration Updates

Configuration changes usually involve:

- `src/utils/config.ts`
- `src/utils/shared.ts`
- `example-config-advanced.toml`
- `README.md`
- `tests/config.test.ts`

## Helpful npm Scripts

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `npm run lint:all`          | Run all linters (ESLint, complexity, file length, Prettier) |
| `npm run lint:prettier:fix` | Automatically format files with Prettier                    |
| `npm run typecheck`         | Perform a strict TypeScript type check                      |
| `npm run build`             | Compile the CLI for distribution                            |
| `npm test`                  | Execute the Vitest suite                                    |

## Style and Tooling

- Use ESM module system with `.js` extension for internal imports
- TypeScript files use 4-space indentation, single quotes, semicolons
- Markdown is formatted with `mdformat`
- Husky hooks guard commit and push flows
- Keep functions simple and focused

## Questions or Support

- Consult the [README](./README.md) for configuration and usage guidance
- Review the Vitest suites in `tests/` for examples of expected behaviour
- File an issue with details about your environment, logs, and reproduction steps

We appreciate your contributions and attention to quality—thank you!
