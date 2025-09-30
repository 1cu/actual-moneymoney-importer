# Complexity Audit – Story 14.1

## Executive Summary

- `ActualApi.ts` dominates the complexity profile at 1,045 executable lines—over 2.5× the utility limit—with intertwined console suppression, retry orchestration, and timeout handling that are tightly coupled to Logger internals.【d5c208†L2-L5】【F:src/utils/ActualApi.ts†L240-L292】【F:src/utils/ActualApi.ts†L670-L772】【F:src/utils/ActualApi.ts†L1201-L1263】
- Supporting utilities remain dense: `Importer.ts` still packs 358 executable lines just under the cap while `PayeeTransformer.ts` stretches to 436, embedding orchestration, caching, and AI transformation flows that ripple into CLI commands.【86c9c2†L2-L5】【64b88c†L2-L5】【F:src/utils/Importer.ts†L25-L299】【F:src/utils/PayeeTransformer.ts†L25-L200】
- Complexity linting surfaces 85 warnings concentrated in long-form Vitest suites, and the stricter temporary `max-lines` gate continues to flag `ActualApi.ts` and `PayeeTransformer.ts`, underscoring the distance from published caps.【216b95†L1-L79】【89a55a†L2-L9】
- Configuration parsing weighs in at 235 executable lines with deeply nested Zod schema refinement and default logging logic, pushing beyond the 200-line configuration cap and making validation paths difficult to follow.【d4ff55†L2-L5】【F:src/utils/config.ts†L17-L206】
- Dependency review shows that `ActualApi` and `Logger` sit at the center of most modules and commands, so reshaping them requires coordinated slices across commands, importer flows, and tests.【F:src/commands/import.command.ts†L4-L155】【F:src/utils/AccountMap.ts†L1-L160】【F:src/utils/Logger.ts†L1-L130】
- Cyclomatic complexity analysis reinforces these hotspots, with `ActualApi.ts` (score 547), `import.command.ts` (158), `config.ts` (129), and `AccountMap.ts` (133) all breaching the tool's error threshold.【269bcd†L1-L120】

## Current State Analysis

### Tooling Baseline

- `npm run lint:complexity` (ENABLE_COMPLEXITY_RULES) → 85 warnings isolated to test suites where `any` shortcuts suppress strict typing.【216b95†L1-L79】
- `npm run lint:eslint` (default rules) → reproduces the same 85 warnings, confirming that without the complexity toggle the debt remains visible but non-blocking.【b1754a†L1-L79】
- `npx cyclomatic-complexity './src/**/*.ts'` highlights high cyclomatic scores in `ActualApi.ts`, `import.command.ts`, `AccountMap.ts`, and `config.ts`, providing a complementary structural signal alongside line counts.【269bcd†L1-L120】
- Temporary file-cap gate with comment/blank skipping: `ENABLE_COMPLEXITY_RULES=true npx eslint './src/**/*.ts' --rule 'max-lines:["error",{"max":400,"skipBlankLines":true,"skipComments":true}]'` continues to fail on `ActualApi.ts` (1,045 lines) and `PayeeTransformer.ts` (436 lines), reinforcing the scale of utility overages.【89a55a†L2-L9】
- Focused caps show `config.ts` still at 235 lines vs. the 200-line configuration limit, while `Importer.ts` (358 lines) and the CLI commands (211 and 93 lines respectively) sit just under their thresholds but remain dense orchestration hubs.【d4ff55†L2-L5】【86c9c2†L2-L5】【0d790c†L2-L5】【a3d0d8†L2-L5】
- `npm run typecheck` → passes with no diagnostics, signalling the TypeScript surface is consistent even though tests lean on `any` typing.【1d078f†L1-L5】

### File Size Metrics

| File | Lines | Limit | Delta | Notes |
| --- | ---: | ---: | ---: | --- |
| `src/utils/ActualApi.ts` | 1,045 | 400 | +645 | Core API wrapper with retries, console interception, and hashing utilities.【d5c208†L2-L5】【F:src/utils/ActualApi.ts†L240-L292】|
| `src/utils/Importer.ts` | 358 | 400 | -42 | Transaction pipeline, payee transformation, logging orchestration that still bunches responsibilities tightly.【86c9c2†L2-L5】【F:src/utils/Importer.ts†L25-L299】|
| `src/utils/PayeeTransformer.ts` | 436 | 400 | +36 | Model caching, prompt generation, masking logic, OpenAI flows.【64b88c†L2-L5】【F:src/utils/PayeeTransformer.ts†L25-L200】|
| `src/utils/config.ts` | 235 | 200 | +35 | Nested Zod schemas, default tracking, file I/O helpers.【d4ff55†L2-L5】【F:src/utils/config.ts†L17-L266】|
| `src/utils/Logger.ts` | 106 | 400 | -294 | Single logger still embeds structured logging and hint normalization.【f35ffb†L2-L5】【F:src/utils/Logger.ts†L1-L91】|
| `src/commands/import.command.ts` | 211 | 300 | -89 | Pulls together Actual API, importer, and payee transformer instances.【0d790c†L2-L5】【F:src/commands/import.command.ts†L1-L155】|
| `src/commands/validate.command.ts` | 93 | 300 | -207 | Config validation entry point but inherits complexity from config helpers.【a3d0d8†L2-L5】【F:src/commands/validate.command.ts†L1-L109】|

### Dependency Hotspots

- `ActualApi` is consumed by both `Importer` and `AccountMap`, cascading into the CLI import command; any restructuring requires aligning these callers and their tests.【F:src/utils/Importer.ts†L1-L299】【F:src/utils/AccountMap.ts†L1-L160】【F:src/commands/import.command.ts†L70-L155】
- `Logger` threads through config loading, importer flows, API calls, and commands, so changes to its surface impact most modules simultaneously.【F:src/utils/Logger.ts†L1-L130】【F:src/utils/config.ts†L17-L206】【F:src/commands/import.command.ts†L1-L155】【F:src/commands/validate.command.ts†L1-L109】
- `PayeeTransformer` sits behind optional logic in `Importer` and is instantiated in the import command, meaning its caching and masking behaviour affects importer logging pathways.【F:src/utils/Importer.ts†L1-L299】【F:src/commands/import.command.ts†L4-L155】【F:src/utils/PayeeTransformer.ts†L25-L200】
- Configuration utilities feed both CLI commands and downstream log messaging, so schema adjustments ripple into runtime hints and tests.【F:src/utils/config.ts†L17-L266】【F:src/commands/import.command.ts†L1-L155】【F:src/commands/validate.command.ts†L1-L109】

## Complexity Pattern Analysis

1. **Console interception coupling** – `ActualApi` patches global console methods with categorized filtering, cache layers, and log-level awareness, tightly binding SDK noise suppression to logger semantics and shared state.【F:src/utils/ActualApi.ts†L240-L292】【F:src/utils/ActualApi.ts†L1201-L1263】
1. **Nested retry loops** – Budget loading nests retries around download, metadata refresh, directory validation, sync, and shutdown attempts, creating deep control flow with shared mutable state and contextual hint propagation.【F:src/utils/ActualApi.ts†L670-L772】
1. **Fixture indirection** – Test helper `cli.ts` builds the CLI binary on demand, manages shared promises, and orchestrates process lifecycle, so even simple CLI tests inherit multi-step setup indirection.【F:tests/helpers/cli.ts†L1-L168】
1. **Complex error handling** – `runActualRequest` layers timeout races, recursive shutdown attempts, hint aggregation, and friendly error rewriting, obscuring core request logic and spreading side effects across the class.【F:src/utils/ActualApi.ts†L505-L596】
1. **Over-abstraction in utilities** – `Importer` handles data fetching, filtering, dedupe, optional AI augmentation, logging, and dry-run branching in one method, while `PayeeTransformer` bundles disk caches, capability inference, and log masking, signalling opportunities to collapse responsibilities.【F:src/utils/Importer.ts†L25-L299】【F:src/utils/PayeeTransformer.ts†L25-L200】
1. **Deep nesting in configuration logic** – `config.ts` combines schema refinement, default decision tracking, TOML parsing, and error formatting with multi-level `if` / `superRefine` blocks, making it hard to trace validation failures.【F:src/utils/config.ts†L17-L206】【F:src/utils/config.ts†L209-L266】

## Refactor Roadmap

| Slice | Effort (1-5) | Risk | Dependencies | Success Metrics | Primary Files |
| --- | --- | --- | --- | --- | --- |
| Extract console suppression into a dedicated utility and inject via `ActualApi` constructor, decoupling Logger from global patching.|5|High|Requires Logger + ActualApi callers to adopt new hook; affects importer tests relying on suppression.|Reduce `ActualApi.ts` by ≥200 lines; isolate console logic behind unit-tested module.|`src/utils/ActualApi.ts`, new `src/utils/ActualConsoleFilter.ts`, tests|
| Flatten `runActualRequest` timeout handling into composable helpers (timeout wrapper, shutdown strategy), simplifying recursion and state reset.|4|Medium|Depends on console extraction (shares context hints) and must preserve shutdown semantics for importer flows.|Drop cyclomatic complexity in `runActualRequest` by ≥30% and shrink method to \<80 lines.|`src/utils/ActualApi.ts`, tests|
| Split importer pipeline into staged helpers (fetch/filter, reconciliation, apply AI, commit) with explicit data shapes.|4|Medium|Needs stable `ActualApi` transaction shape; interacts with PayeeTransformer slice for payee enrichment.|Reduce `Importer.ts` to ≤350 lines; add targeted unit coverage per stage.|`src/utils/Importer.ts`, `tests/Importer.test.ts`, CLI command|
| Simplify payee transformer by trimming disk cache responsibilities and constraining model negotiation to configuration-time validation.|3|Medium|Dependent on importer slice to accept simplified interface; interacts with config defaults.|Reduce file to ≤350 lines; eliminate static cache state; ensure config defaults cover validation.|`src/utils/PayeeTransformer.ts`, `src/utils/config.ts`, tests|
| Separate configuration schema from runtime loading/logging (e.g., `config/schema.ts`, `config/io.ts`) to untangle nested refinements.|3|Medium|Feeds commands and importer; should land before command cleanups so surfaces remain stable.|Bring each configuration module under 200 lines; maintain shared schema exports; add focused tests.|`src/utils/config.ts`, `src/commands/*`, `tests/config.test.ts`|
| Replace CLI test helper build pipeline with explicit fixture or prebuild step to remove shared promise + spawn indirection.|2|Low|Independent but should follow importer/command refactors to avoid conflicting CLI behaviour changes.|Cut helper below 120 lines, remove shared promise caching, rely on direct `npm run build` fixture for tests.|`tests/helpers/cli.ts`, CLI tests|

## Risk Mitigation

- Stage `ActualApi` changes behind feature toggles or adapter interfaces so importer and account map can migrate incrementally.【F:src/utils/ActualApi.ts†L505-L772】
- Bolster tests around timeout and retry behaviour before refactoring to guard against regressions; current warnings show type unsafety that needs cleanup for reliable assertions.【216b95†L1-L79】【F:tests/helpers/cli.ts†L1-L168】
- Use targeted documentation updates and changelogs for configuration refactors because both CLI commands and docs rely on schema constants.【F:src/utils/config.ts†L17-L266】【F:src/commands/validate.command.ts†L1-L109】
- Pair importer and payee transformer slices to keep AI masking and logging expectations aligned while logic shifts out of monolithic methods.【F:src/utils/Importer.ts†L203-L284】【F:src/utils/PayeeTransformer.ts†L108-L200】

## Success Criteria

- Utilities (`ActualApi`, `Importer`, `PayeeTransformer`) trimmed below enforced line caps with console suppression isolated from API lifecycle management.【F:src/utils/ActualApi.ts†L240-L772】【F:src/utils/Importer.ts†L25-L299】【F:src/utils/PayeeTransformer.ts†L25-L200】
- Configuration logic reorganised so no single module exceeds 200 lines and schema vs. I/O responsibilities are separable.【F:src/utils/config.ts†L17-L266】
- ESLint complexity run reduced to ≤10 warnings by introducing precise typings and trimming monolithic test suites.【216b95†L1-L79】
- Retry and timeout paths covered by focused unit tests with deterministic fixtures, preventing regression of shutdown and logging semantics.【F:src/utils/ActualApi.ts†L505-L596】【F:tests/helpers/cli.ts†L1-L168】
- CLI tests operate without dynamic build indirection, using explicit prebuilt artifacts or simpler harnesses to keep fixtures maintainable.【F:tests/helpers/cli.ts†L34-L168】
