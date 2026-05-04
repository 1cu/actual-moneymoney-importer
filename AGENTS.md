# Repository Guidelines

## Project Structure & Module Organization

The project is a TypeScript CLI importer. Main source lives in `src/`:

- `src/index.ts`: CLI entrypoint.
- `src/commands/`: command handlers (`import`, `validate`).
- `src/utils/`: integration and domain logic (Actual API, importer flow, config, logging, mapping).
- `src/types/`: local type declarations.

Build output is written to `dist/` (generated). Static assets are in `assets/`. CI and release automation are under `.github/workflows/`.

## Build, Test, and Development Commands

- `npm install` or `bun install`: install dependencies.
- `npm run build`: compile TypeScript to `dist/` using `tsc`.
- `npm run start`: run built CLI (`node dist/index.js`).
- `npm run test` or `npm run test:cli`: run CLI integration tests.
- `npm run lint:eslint`: run ESLint on `src/`.
- `npm run lint:prettier`: check formatting for `src/**/*.ts`.
- `npm run lint:fix`: auto-fix lint and formatting issues.

Example local validation flow:

```bash
npm run lint:eslint
npm run lint:prettier
npm run build
npm run test:cli
```

## Release & Publishing

- Stable releases are automated from `main` via GitHub Actions and `semantic-release`.
- Releases publish to both GitHub Releases and npm.
- Do not manually bump `package.json` version or publish locally for routine releases.
- Keep `package.json`, `README.md`, and release workflow/config files in sync when changing the package name, CLI name, install instructions, or release flow.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Formatting is enforced by Prettier (`.prettierrc.json`): 4 spaces, single quotes, semicolons, trailing commas (`es5`), `printWidth: 80`.

Follow existing naming patterns:

- Files: lower-case with domain suffixes (e.g., `import.command.ts`, `ActualApi.ts` where class-centric).
- Types/classes: `PascalCase`.
- Variables/functions: `camelCase`.
- Unused parameters intentionally ignored should be prefixed with `_` (ESLint rule).

## Testing Guidelines

CLI parser behavior is covered by integration tests in `test/cli/`.

For behavior changes, run:

1. `npm run build`
2. `npm run test:cli`
3. `actual-monmon validate` with a real config
4. `actual-monmon import --from=YYYY-MM-DD` against a safe test budget/server when possible

Document manual verification steps in PR descriptions.

## Specification-Driven Workflow

Before writing code for behavior changes:

1. Define expected behavior as a short specification (inputs, outputs, exit codes, error cases).
2. Translate that specification into tests (or explicit manual verification steps when automation is not feasible).
3. Implement code only after the specification is clear.

Treat tests as the source of truth for CLI behavior. If behavior changes intentionally, update both tests and docs in the same change.

## Ambiguity Handling

If a request contains material ambiguity that can change behavior, security posture, data handling, or external effects, clarify it before coding.

When asking for clarification:

- Ask one targeted question.
- Include a recommended default.
- State what changes based on each possible answer.

Do not block on minor stylistic ambiguity; follow existing repository conventions.

## Verification Requirement

Every non-trivial code change must include verification evidence:

- automated tests (`npm run test:cli`) and/or
- lint/build results and
- manual scenario checks for integrations that cannot be fully automated.

Do not mark work as complete without reporting what was verified.

## Commit & Pull Request Guidelines

Conventional Commits are required because `semantic-release` uses them to determine version bumps and release notes.

Commits must follow Conventional Commits (validated by commitlint), e.g.:

- `feat: add budget filter for imports`
- `fix: handle missing account mapping`
- `chore(deps): update dependencies`

PRs should include:

- Clear description of intent and scope
- Bullet list of changes
- Notes on release impact, including any breaking changes
- Testing evidence (commands run, manual scenarios)
- Notes on breaking changes or config impacts

If contributing to this repository, follow `.github/PULL_REQUEST_TEMPLATE.md`.
