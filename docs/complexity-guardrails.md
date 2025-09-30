# Complexity Guardrails – Story 14.6

Story 14.6 locks in strict complexity enforcement so Stories 14.2-14.5 can
whittle down the remaining debt. The guardrails below intentionally fail CI
until the refactors land. Use this document as the single source of truth for
why the pipeline is red and how to make it green again.

## CI Failure Matrix

| Command | What fails | Primary files (current status) | Related stories | How to fix |
| --- | --- | --- | --- | --- |
| `npm run lint:complexity` | `max-lines` violations now block merges. | `src/utils/ActualApi.ts` (1,045 lines / limit 400), `src/utils/PayeeTransformer.ts` (436 / 400). | 14.2 (Actual API & payee refactor). | Break the monoliths into focused modules. Keep utilities ≤400 lines, commands ≤300, configuration files ≤200. |
| `npm run lint:eslint` | Cognitive complexity breaches surface as hard errors. | 85 warnings promoted to failures across tests and utilities. | 14.2-14.5. | Extract helpers, simplify branches, and reduce nested logic while keeping behaviour identical. |
| `npm run analyze:cyclomatic` | Cyclomatic complexity >40 is disallowed. | `src/utils/ActualApi.ts` (547), `src/commands/import.command.ts` (158), `src/utils/config.ts` (129), `src/utils/AccountMap.ts` (133). | 14.2 (Actual API), 14.4 (command pipeline), 14.5 (account map). | Split control flow into smaller functions, remove redundant branching, and trim shared state coupling. |

## Troubleshooting Checklist

1. **Run the guardrails locally** before pushing:

   ```bash
   npm run lint:eslint
   npm run lint:complexity
   npm run analyze:cyclomatic
   ```

2. **Map the failure back to the backlog**:
   - File-length violations → Story 14.2 (Actual API & Payee Transformer) and
     Story 14.3 (Configuration split).
   - Cognitive complexity errors → Stories 14.2-14.4 (API, config, command
     orchestration).
   - Cyclomatic complexity failures → Stories 14.2, 14.4, 14.5 (API, command,
     account mapping).

3. **Tackle one slice at a time**:
   - Start with Story 14.2 to unblock the largest offenders (`ActualApi.ts` and
     `PayeeTransformer.ts`). Once those pass, CI stops failing on the utility
     line limits.
   - Story 14.3 should extract configuration schema vs. runtime logic so the
     configuration file drops below 200 lines and sheds nested refinements.
   - Stories 14.4 and 14.5 focus on the CLI command orchestration and account
     map control flow to reduce cyclomatic spikes.

4. **Re-run the guardrails** after each slice. CI will only recover when all
   metrics meet the thresholds below.

## Progress Dashboard

### File Length Targets

| File | Lines | Limit | Delta | Story |
| --- | ---: | ---: | ---: | --- |
| `src/utils/ActualApi.ts` | 1,091 | 400 | +691 | 14.2 |
| `src/utils/PayeeTransformer.ts` | 436 | 400 | +36 | 14.2 |
| `src/utils/config.ts` | 17 | 200 | -183 | 14.3 (✅ split into schema/defaults/loader) |

### Cyclomatic Hotspots

| File | Score | Limit | Story |
| --- | ---: | ---: | --- |
| `src/utils/ActualApi.ts` | 547 | 40 | 14.2 |
| `src/commands/import.command.ts` | 158 | 40 | 14.4 |
| `src/utils/config.ts` | 129 | 40 | 14.3 |
| `src/utils/AccountMap.ts` | 133 | 40 | 14.5 |

Update the tables as stories land so the backlog always reflects the real debt.
When all rows show values at or below the limits, Story 14.6 can be closed out.

## Success Criteria by Story

- **Story 14.2 – Actual API & Payee Transformer**
  - `ActualApi.ts` and `PayeeTransformer.ts` ≤400 lines each.
  - Cyclomatic score <40 for every exported helper.
  - No cognitive complexity failures in their modules.
  - Progress snapshot: console noise suppression no longer uses pattern caches or categorisation layers, trimming ~175 lines (1,267 ➝ 1,091) from `ActualApi.ts` while keeping debug logging at `LogLevel.DEBUG`.
- **Story 14.3 – Configuration Split**
  - `src/utils/config.ts` ≤200 lines.
  - Schema and runtime I/O separated with passing tests.
  - No cognitive complexity violations originating from config helpers.

### Configuration Flow Overview (Story 14.3)

1. **Schema validation** – `src/utils/config/schema.ts` holds the Zod schema,
   trims/normalises date fields, and exposes the timeout constants that callers
   reuse when instantiating the Actual client.
2. **Default decision capture** – `src/utils/config/defaults.ts` inspects the
   raw TOML payload and records which values fell back to defaults so the CLI
   can explain hidden behaviour.
3. **Runtime loading** – `src/utils/config/loader.ts` reads the TOML file,
   applies the schema, and returns both the parsed config and default decision
   log. Downstream helpers import from `config.ts`, which now simply re-exports
   these focused modules.
4. **Contributor guidance** – when updating configuration, touch the schema,
   adjust the default collector if new fallbacks appear, and surface any new
   logging expectations alongside the loader.
- **Story 14.4 – Import Command Simplification**
  - `import.command.ts` cyclomatic score <40.
  - Handler delegates to smaller helpers with coverage in Vitest.
- **Story 14.5 – Account Map Simplification**
  - `AccountMap.ts` cyclomatic score <40.
  - Mapping responsibilities distributed across smaller, testable helpers.

Once every story satisfies its success criteria, the guardrail suite will pass
without needing overrides or feature flags.
