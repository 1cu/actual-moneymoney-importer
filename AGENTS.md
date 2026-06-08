# Repository Guidelines

## Project Structure & Module Organization

The project is a TypeScript CLI importer. Main source lives in `src/`:

- `src/index.ts`: CLI entrypoint.
- `src/commands/`: command handlers (`import`, `validate`).
- `src/utils/`: integration and domain logic (Actual API, importer flow, config, logging, mapping).
- `src/types/`: local type declarations.
- `test/cli/`: CLI integration tests for parsing, exit codes, and end-to-end flows.
- `test/unit/`: focused unit tests for helpers, adapters, output formatting, and error handling.

Build output is written to `dist/` (generated). Static assets are in `assets/`. CI and release automation are under `.github/workflows/`.

## Build, Test, and Development Commands

- `npm install` or `bun install`: install dependencies.
- `npm run build`: compile TypeScript to `dist/` using `tsc`.
- `npm run start`: run built CLI (`node dist/index.js`).
- `npm run test`: compile TypeScript and run the full automated suite (`test/cli` + `test/unit`).
- `npm run test:cli`: compile TypeScript and run CLI integration tests.
- `npm run test:unit`: compile TypeScript and run unit tests.
- `npm run lint:eslint`: run ESLint on `src/`.
- `npm run lint:prettier`: check formatting for `src/**/*.ts`, `test/**/*.mjs`, `*.md`, `.github/**/*.md`, and `package.json`.
- `npm run lint:fix`: auto-fix lint and formatting issues in the same file sets.

Example local validation flow:

```bash
npm run lint:eslint
npm run lint:prettier
npm run build
npm run test
```

## Release & Publishing

- Stable releases are published automatically from `main` by the `semantic-release` workflow. The workflow can also be triggered manually when a rerun is needed.
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

CLI parser and end-to-end command behavior is covered by integration tests in `test/cli/`.
Focused helpers, API wrappers, output formatters, and error handling belong in `test/unit/`.

For behavior changes, run:

1. `npm run build`
2. `npm run test` or the targeted subset(s) (`npm run test:cli` / `npm run test:unit`)
3. `node dist/index.js validate` with a real config
4. `node dist/index.js import --from=YYYY-MM-DD` against a safe test budget/server when possible

Document manual verification steps in PR descriptions.

### Live probe transaction search

When you need to verify an importer change against real MoneyMoney/Actual data,
search live transactions directly instead of guessing from names alone.

- In MoneyMoney, `accountUuid` is the owning account; `accountNumber` on a transaction is the counterparty IBAN.
- Use `getAccounts()` to resolve account names, UUIDs, and IBANs first.
- Use `getTransactions({ from, to })` and filter by `accountUuid` for the source account.
- For transfer probes, look for:
    - opposite amounts
    - different `valueDate`s when proving cross-date behavior
    - a transfer category on the source side
    - a source `accountNumber` that matches the target account's IBAN
    - matching `purpose` text when possible
- In Actual, use `getTransactions(accountId, startDate, endDate)` after `downloadBudget(...)` to verify the imported state.
- If a probe was already imported, delete the Actual transaction first and re-sync before rerunning the import.

Example live search pattern:

- Replace `...` with a real `accountUuid` from `getAccounts()`.
- Run this as a Node one-liner from the repo root after the `moneymoney` package is installed and configured.
- Verified against live MoneyMoney data for `2026-03-01`..`2026-05-16`; output rows include `accountUuid`, `date`, `amount`, `purpose`, and related fields.

```bash
node --input-type=module -e "
  const { getAccounts, getTransactions } = await import('moneymoney');
  const accounts = await getAccounts();
  const txs = await getTransactions({ from: '2026-03-01', to: '2026-05-16' });
  const relevant = txs.filter((t) => t.accountUuid === '<replace with accountUuid from getAccounts() output>');
  console.log(JSON.stringify(relevant, null, 2));
"
```

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

- automated tests (`npm run test`, `npm run test:cli`, or `npm run test:unit`) and/or
- lint/build results and
- manual scenario checks for integrations that cannot be fully automated.

Do not mark work as complete without reporting what was verified.

## Branch & Pull Request Workflow

**All changes must go through a pull request.** The `main` branch is protected — direct pushes are rejected. Work on a feature branch and open a PR targeting `main`.

```bash
# Create a branch, commit, push, and open a PR
git checkout -b fix/your-change
git add ... && git commit -m "fix: your change"
git push origin fix/your-change
gh pr create --base main --head fix/your-change --title "fix: your change" --body "..."
```

After review and CI passes, merge the PR. Release publishing runs automatically from `main` afterward.

## Commit & Pull Request Guidelines

Conventional Commits are required because `semantic-release` uses them to determine version bumps and release notes.

Commits must follow Conventional Commits (validated by commitlint), e.g.:

- `feat: add budget filter for imports`
- `fix: handle missing account mapping`
- `chore(deps): update dependencies`

Release versions are determined from commit messages by `semantic-release`:

- `feat:` creates a minor release.
- `fix:`, `perf:`, and `refactor:` create patch releases.
- `!` or a `BREAKING CHANGE:` footer creates a major release.
- Runtime dependency updates should use `fix(deps): ...` for patch releases.
- Runtime dependency updates that intentionally require a minor release should use `feat(deps): ...`.
- Runtime dependency updates that intentionally require a major release should use `fix(deps)!: ...` or include a `BREAKING CHANGE:` footer.
- Dev dependency updates should use `chore(deps-dev): ...` and do not create releases by default.

Dependabot is configured to use `fix(deps): ...` for runtime dependency PRs and `chore(deps-dev): ...` for dev dependency PRs. If an Actual API/Core dependency update needs to mirror an upstream major or minor version, edit the PR title or squash commit before merging so it uses the correct Conventional Commit type.

PRs should include:

- Clear description of intent and scope
- Bullet list of changes
- Notes on release impact, including any breaking changes
- Testing evidence (commands run, manual scenarios)
- Notes on breaking changes or config impacts

If contributing to this repository, follow `.github/PULL_REQUEST_TEMPLATE.md`.
