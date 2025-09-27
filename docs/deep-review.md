# Deep Review – actual-moneymoney (main)

## 1. Executive Summary

The project has evolved significantly with robust foundations now in place. The Actual adapter successfully completes the download → load → sync lifecycle with proper console state management, and the test suite runs cleanly without hangs.【F:src/utils/ActualApi.ts†L85-L219】【F:tests/ActualApi.test.ts†L53-L195】 The CI/CD pipeline is well-structured with comprehensive checks including linting, type checking, testing, and building.【F:.github/workflows/ci.yml†L1-L106】【F:.github/workflows/release.yml†L1-L50】 However, several critical issues remain: security vulnerabilities exist in dependencies, and some architectural improvements are needed for production readiness.

### 5-Point Action Plan

1. ✅ Fix the budget lifecycle (download → load → sync) and add error/timeout handling in the Actual adapter (completed).
1. ✅ Fix the `validate` command directory creation issue (B2) so parent directories are created automatically.
1. ✅ Identify and fix the Vitest hang issue with console patching (completed with proper cleanup).
1. 🚧 **HIGH**: Address security vulnerabilities in dependencies (5 moderate severity issues in esbuild/vitest chain).
1. ✅ Align the toolchain with npm, add typecheck script, and secure the release flow (completed).

## 2. Bug List

| ID | Status | Category | File:Line | Short Description | Repro Steps | Expected vs. Current Behaviour | Fix Proposal |
| --- | ----------- | -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 | ✅ Resolved | Bug | `src/utils/ActualApi.ts:176-219` | Budget lifecycle previously stopped at `downloadBudget`, leaving the session without an active budget.【F:src/utils/ActualApi.ts†L176-L219】 | Covered by the `ActualApi` unit suite (loadBudget test).【F:tests/ActualApi.test.ts†L103-L141】 | Budget download, load, and sync now complete before returning, so account/transaction calls see fresh data.【F:src/utils/ActualApi.ts†L176-L219】 | Fix landed: `loadBudget` chains download → load → sync and logs failures, with regression coverage in Vitest.【F:src/utils/ActualApi.ts†L176-L219】【F:tests/ActualApi.test.ts†L103-L141】 |
| B2 | ✅ Resolved | Bug | `src/commands/validate.command.ts:18-77` | `validate` writes config files and now creates parent directories before writing the default config.【F:src/commands/validate.command.ts†L18-L77】 | Covered by new validate command tests for directory creation, current-directory configs, and write failures.【F:tests/commands/validate.command.test.ts†L1-L199】 | Path is created recursively and example config written when missing, with detailed logging for failures.【F:src/commands/validate.command.ts†L18-L77】 | Fix landed: create parent directory with recursive mkdir, write template, and log errors with context; regression coverage added in Vitest.【F:src/commands/validate.command.ts†L18-L77】【F:tests/commands/validate.command.test.ts†L1-L199】 |
| B3 | ✅ Resolved | Bug | `tests/ActualApi.test.ts` | Vitest run used to hang because console patching never unwound after timeouts.【F:tests/ActualApi.test.ts†L143-L195】 | Regression covered by `npm test` and targeted Actual API specs.【chunk:6f7772†L1-L6】【F:tests/ActualApi.test.ts†L53-L195】 | Test suite now exits cleanly; console patching restores globals and clears fake timers.【F:src/utils/ActualApi.ts†L85-L121】【F:tests/ActualApi.test.ts†L53-L195】 | Fixed by wrapping each Actual API request in a scoped `patchConsole` guard and adding timer cleanup in the timeout test.【F:src/utils/ActualApi.ts†L85-L121】【F:tests/ActualApi.test.ts†L143-L195】 |
| B4 | 🚧 **HIGH** | Security | `package.json` dependencies | 5 moderate severity vulnerabilities in esbuild/vitest dependency chain.【F:package.json†L46-L60】 | Run `npm audit --audit-level=high` to see vulnerabilities. | Expected: No high-severity vulnerabilities. Actual: 5 moderate vulnerabilities in dev dependencies. | Update vitest to v3.2.4+ or consider alternative testing framework.【F:package.json†L58】 |

## 3. Design / Architecture Findings

- ✅ **Actual API robustness**: The API now includes comprehensive timeout handling, proper error wrapping, and status checks.【F:src/utils/ActualApi.ts†L129-L210】 Network failures are properly caught and wrapped with context hints.【F:src/utils/ActualApi.ts†L190-L203】
- ✅ **Scoped console patching**: `ActualApi` now wraps each request in a reference-counted `patchConsole`, restoring original loggers after the timeout race and keeping Vitest runs deterministic.【F:src/utils/ActualApi.ts†L85-L121】【F:src/utils/ActualApi.ts†L482-L528】 The open-handle hang is resolved.
- ✅ **OpenAI privacy protection**: `PayeeTransformer` now includes comprehensive payee masking with configurable options.【F:src/utils/PayeeTransformer.ts†L493-L545】 Debug logs respect the `maskPayeeNamesInLogs` configuration.【F:src/utils/PayeeTransformer.ts†L154-L158】
- ✅ **Starting balance heuristic**: The importer now skips creating synthetic starting balances when MoneyMoney returned no transactions for the mapped account and surfaces guidance in the logs.【F:src/utils/Importer.ts†L150-L214】【F:tests/Importer.test.ts†L142-L236】 This avoids unexpected balance jumps on partial imports while preserving the original behaviour when account activity exists.【F:src/utils/Importer.ts†L198-L214】【F:tests/Importer.test.ts†L238-L371】
- ✅ **CI/CD Pipeline**: Comprehensive GitHub Actions workflows with proper dependency caching, parallel job execution, and security checks.【F:.github/workflows/ci.yml†L1-L106】【F:.github/workflows/release.yml†L1-L50】
- ✅ **TypeScript Configuration**: Well-configured TypeScript with strict mode, proper module resolution, and ES2016 target.【F:tsconfig.json†L1-L113】

## 4. Refactor Backlog

### Epic A – Harden Actual adapter ✅ **COMPLETED**

_Target state:_ Stable import across multiple budgets/servers and transient server failures.
_Acceptance criteria:_ Budget loads post-download, sync/retry on 5xx/timeout, console patching removed.
_Risks:_ Changes to global logging, tests/mocks need updates.

- ✅ Story A1 (M): integrate `loadBudget` + `sync`, secure shutdown in `finally` (now implemented and covered by tests).【F:src/utils/ActualApi.ts†L176-L275】【F:tests/ActualApi.test.ts†L103-L195】
- ✅ Story A2 (M): refactor console suppression into a scoped helper with regression tests guarding against open handles.【F:src/utils/ActualApi.ts†L85-L121】【F:tests/ActualApi.test.ts†L53-L195】
- ✅ Story A3 (S): wrap HTTP fetches with `AbortController`, status checks, and sensitive log redaction.【F:src/utils/ActualApi.ts†L129-L210】

### Epic B – CLI & Config DX 🚧 **IN PROGRESS**

_Target state:_ Users can create/validate configs anywhere.
_Acceptance criteria:_ `validate` creates paths, error text offers guidance, README stays in sync.
_Risks:_ Path handling on Windows/macOS.

- ✅ Story B1 (S): recursive `mkdir` before `writeFile`, add tests for success/error paths.【F:src/commands/validate.command.ts†L18-L77】【F:tests/commands/validate.command.test.ts†L1-L199】
- ✅ Story B2 (S): document CLI option normalisation (`--server`, `--budget`) and add tests for filter logic.【F:src/commands/import.command.ts†L84-L200】

### Epic C – Test/CI hardening

_Target state:_ Deterministic tests locally and in CI (Node 20/22).
_Acceptance criteria:_ `npm test` exits, coverage ≥80 % for importer pipeline.
_Risks:_ MoneyMoney/Actual mocks more complex.

- ✅ Story C1 (M): analysed console patch handles and added Vitest cleanup so the suite exits cleanly.【F:src/utils/ActualApi.ts†L85-L121】【F:tests/ActualApi.test.ts†L143-L195】【chunk:25b872†L1-L8】
- Story C2 (M): add integration tests for importer pipeline (mock MoneyMoney + Actual) covering dedupe/start balance.【F:src/utils/Importer.ts†L27-L210】
- Story C3 (S): extend GitHub Actions with test/typecheck/audit, consolidate bun→npm usage.【F:.github/workflows/ci.yml†L1-L23】【F:package.json†L6-L13】

### Epic D – Security & Dependencies 🚧 **NEW**

_Target state:_ No high-severity vulnerabilities, up-to-date dependencies.
_Acceptance criteria:_ `npm audit` passes, dependencies are current.
_Risks:_ Breaking changes in major version updates.

- 🚧 **HIGH** Story D1 (M): Address esbuild/vitest security vulnerabilities.【F:package.json†L58】
- Story D2 (S): Add automated dependency updates with Dependabot.【F:.github/dependabot.yml】
- Story D3 (S): Implement security scanning in CI pipeline.【F:.github/workflows/security.yml】

### Quick Wins (\<1 day)

- ✅ Add missing `npm run typecheck` script and update README (completed).【F:package.json†L6-L13】
- ✅ Allow masking toggle for `PayeeTransformer` debug logs.【F:src/utils/PayeeTransformer.ts†L493-L545】
- ✅ Removed `getUserFiles`, reducing dormant Actual adapter code paths.【F:src/utils/ActualApi.ts†L174-L217】

## 5. Test Strategy & Coverage

- **Importer E2E**: Scenarios for dedupe (`imported_id`), starting balance, `ignorePatterns`, dry-run against mocked Actual.【F:src/utils/Importer.ts†L175-L209】
- **Config validation**: Tests for custom paths, schema failures, skip-model-validation flag, and TOML syntax errors.【F:src/utils/config.ts†L8-L104】【F:src/commands/validate.command.ts†L18-L105】
- **ActualApi**: Unit tests for budget lifecycle (init/download/load/shutdown), error handling (401/500), console patch behaviour.
- **CLI smoke**: `--help`, `import --dry-run`, `validate` (new/broken config). Use snapshots with masked payees (respect `maskPayeeNamesInLogs`).【F:src/utils/Importer.ts†L200-L236】
- **Determinism**: Mock timers/date access (`Date.now`, `subMonths`) for reproducible logs.
- **How to invoke all tests**: run `npm test` (alias for Vitest) or `npx vitest run` for CI mode; ensure `npm run lint:eslint`, `npm run lint:prettier`, and `npm run build` pass before publishing.

## 6. Toolchain / CI Recommendations

- ✅ Close script gap: add `npm run typecheck` → `tsc --noEmit`; optionally create `npm run lint` wrapper combining ESLint + Prettier.【F:package.json†L6-L13】
- ✅ Align CI: remove bun or run npm in parallel; add Node matrix (20, 22) with caching.【F:.github/workflows/ci.yml†L1-L106】
- ✅ Enforce tests & audit in CI/release jobs (`vitest run`, `npm audit --audit-level=high`).【F:.github/workflows/release.yml†L9-L50】
- ⚠️ Revisit `tsconfig`: disable `skipLibCheck` if feasible, enable `noUncheckedIndexedAccess` to catch mapping bugs early.【F:tsconfig.json†L1-L113】
- ✅ Keep commitlint job, but document pre-push hook for lint/typecheck/test.【F:.github/workflows/ci.yml†L77-L106】

## 7. Zod / OpenAI Migration Plan

1. **Analyse dependency landscape**: once `openai` ≥6 ships with zod v4 peer dependency, test upgrade in a feature branch.【F:README.md†L31-L136】
1. **Prepare dual build**: introduce adapter around `z.safeParse` to isolate breaking changes.【F:src/utils/config.ts†L8-L104】
1. **Integration tests**: run config parsing & PayeeTransformer against zod v4 schema, including negative cases.
1. **Release steps**: publish a minor release with migration notes (config validation error texts). Keep previous version tagged for zod 3 consumers.
1. **Rollback**: if openai/zod combo regresses, restore lockfile + npm dist-tag; update README notice accordingly.【F:README.md†L31-L136】

## 8. Appendix (Logs & Artefacts)

- ✅ `npm install` refreshed dependencies (5 moderate advisories remain upstream in esbuild/vitest chain).
- ✅ `npm run lint:eslint` succeeded.
- ✅ `npm run lint:prettier` succeeded.
- ✅ `npm run typecheck` succeeded via the dedicated script.
- ✅ `npm run build` succeeded.
- ✅ `npm test -- --reporter verbose` now finishes without open handles.
- ✅ Targeted `npx vitest run tests/ActualApi.test.ts --reporter verbose` confirms the console patch fix.
- 🚧 `npm audit --audit-level=high` highlights the existing esbuild advisory (5 moderate vulnerabilities in dev dependencies).
- ✅ All CI/CD workflows are properly configured with comprehensive checks.
- ✅ Test suite runs cleanly with 11 passing tests across 3 test files.
- ✅ `validate` command now creates parent directories and writes the default config when missing (B2).
