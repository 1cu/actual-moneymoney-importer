# Improvement Plan

Based on codebase assessment 2026-05-24.

**Status:** PR 1 complete ✅ · PR 2 complete ✅ · PR 3 complete ✅ · PR 4 complete ✅ · PR 5 complete ✅

---

## PR 1: Fix Actual API types ✅

**Issues covered:** #1 (stale local type declaration), #2 (deprecated `actual.internal`), #3 (unused DI)  
**Delivered in:**

- [#240](https://github.com/1cu/actual-moneymoney-importer/pull/240) — remove stale `.d.ts`, adopt official types, `sync()` instead of `internal.send()`
- [#241](https://github.com/1cu/actual-moneymoney-importer/pull/241) — complete DI consistency, remove deprecated `.internal` fallback entirely

### What was done

1. Deleted `src/types/actual-app__api.d.ts` (359 lines of stale global type declarations)
2. Removed `paths` override from `tsconfig.json`
3. Added type imports from `@actual-app/api/models` (`APIAccountEntity`, `APICategoryEntity`, `APICategoryGroupEntity`) and `@actual-app/core/types/models` (`TransactionEntity`, `ImportTransactionEntity`)
4. Replaced stale global types (`Account`, `ReadTransaction`, `Category`, `CategoryGroupPayload`, `CreateTransaction`, `UpdateTransaction`) with official equivalents across 9 files
5. Replaced `actual.internal.send('sync')` with `this.actualApi.sync()` (public API exists in official types)
6. Removed `(actual as any).getPayees()` + eslint-disable — official types include `getPayees()`
7. All 7 method bodies in `ActualApi` now consistently use `this.actualApi.*` instead of module-level `actual.*`
8. Removed `batchUpdateTransactions` fallback to deprecated `this.actualApi.internal` — zero `.internal` references remain in `src/`
9. Removed `as` cast on `actual.init()` return value — official types properly type it

### Outcome

- No `as any` casts interacting with Actual API
- Zero eslint-disable for `no-explicit-any` in ActualApi.ts
- Consistent DI behavior — constructor injection is effective everywhere
- Zero `.internal` references in source code
- 151/151 tests pass, lint clean, zero TypeScript errors

---

## PR 2: Replace console monkey-patching ✅

**Issue:** #4  
**Delivered in:** [#242](https://github.com/1cu/actual-moneymoney-importer/pull/242) — merge two functions into one, drop process stream patching

### What was done

1. Merged `withApiLogControl` and `withGlobalApiNoiseFilter` into a single `withApiNoiseFilter` function
2. Only patches `console.log` (was 6 globals: log/info/warn/error + stdout/stderr.write)
3. Filters by known noise patterns (`Syncing since`, `Got messages`, `[Breadcrumb]`) instead of blanket suppression
4. Dropped `process.stdout/stderr.write` patching entirely
5. Nested-depth tracking preserved for concurrent async safety
6. Callers now decide suppression at their level instead of the function accepting a boolean flag
7. Checked `@actual-app/api` `InitConfig.verbose?: boolean` — static at init time, doesn't support dynamic log level switching

### Outcome

- `console.log` only patched during API noise filtering windows
- Targeted noise-pattern filtering instead of blanket suppression
- Zero process-stream monkey-patching
- 141/141 tests pass, lint clean, zero TypeScript errors

---

## PR 3: TypeScript hardening ✅

**Issues:** #5 (`strictPropertyInitialization`), #6 (unparameterized `ArgumentsCamelCase`)  
**Delivered in:** [#243](https://github.com/1cu/actual-moneymoney-importer/pull/243)

### What was done

1. Initialized AccountMap fields with empty defaults (`[]`, `new Map()`) and updated the load-guard from truthiness to `mapping.size > 0`
2. Re-enabled `strictPropertyInitialization: true` in `tsconfig.json` — no other uninitialized fields in the project
3. Added `CommonArgs` shared type in `cliArgs.ts` (config?, logLevel?, loglevel?)
4. Defined command-specific argv types:
    - `ImportArgs` extending `CommonArgs` — eliminated 7 casts (logLevel as number, dryRun as boolean, from/to as string, account/server/budget as string[], categorySyncOnExisting as union)
    - `CategoriesMapArgs` extending `CommonArgs` — eliminated 5 casts
    - `validate.command.ts` uses `ArgumentsCamelCase<CommonArgs>` — eliminated 1 cast
    - `config.ts` functions (`getConfigFile`, `getConfig`) parameterized on `CommonArgs` — eliminated 1 cast

### Outcome

- TypeScript catches uninitialized property access at compile time
- 14 `as string` / `as boolean` / `as number` casts removed from command handlers
- Full IDE type-checking on all CLI arguments

---

## PR 4: OpenAI v6 modernisation ✅

**Issue:** #7  
**Delivered in:** [#244](https://github.com/1cu/actual-moneymoney-importer/pull/244)

### What was done

1. Removed custom `OpenAICompletionResponse` and `OpenAIClient` types — now uses `OpenAI` directly from the SDK
2. Added `z.record(z.string(), z.string())` PayeeMap Zod schema for response validation
3. Replaced `this.openai.chat.completions.create({ response_format: { type: 'json_object' } })` with `this.openai.chat.completions.parse({ response_format: zodResponseFormat(PayeeMap, 'payee_map') })`
4. Eliminated manual `JSON.parse()` try/catch, null-checks, and `parsed as Record<string, unknown>` cast
5. Simplified per-payee fallback to `transformedPayees[key]?.trim() || rawPayee`

### Outcome

- End-to-end type safety: `choices[0].message.parsed` is typed `Record<string, string>`
- No manual JSON.parse, no `as` casts, no weak validation
- Proper Zod schema validation enforced by the SDK

---

## PR 5: Housekeeping ✅

**Issues:** #8–14 (independently small fixes, batched for efficiency)  
**Delivered in:** [#246](https://github.com/1cu/actual-moneymoney-importer/pull/246)

| Issue                     | File                                         | Fix                                         |
| ------------------------- | -------------------------------------------- | ------------------------------------------- |
| Remove unused `ts-node`   | `package.json`                               | Remove from devDependencies                 |
| Config URL validation     | `config.ts`                                  | `z.string()` → `z.string().url()`           |
| Fetch timeout             | `ActualApi.ts`                               | Add `AbortSignal.timeout()` to fetchJson    |
| Non-atomic config writes  | `categories.command.ts`                      | Write to temp file → rename                 |
| Date timezone consistency | `Importer.ts`                                | Parse config dates through `date-fns/parse` |
| ZodError import style     | `config.ts`, `validate.command.ts`           | Standardize on named `{ ZodError }` import  |
| Shutdown error masking    | `import.command.ts`, `categories.command.ts` | Catch/log shutdown errors separately        |

---

## Dependency ordering

1 ✅ → 2 ✅ → 3 ✅ → 4 ✅ → 5 ✅ — all complete.

## Verification

For each PR, verify with:

- `npm run lint:eslint && npm run lint:prettier`
- `npm run build`
- `npm run test`
- Manual: `node dist/index.js validate` and `node dist/index.js import --from=YYYY-MM-DD` (for PR 1, 2, 3, 5)
- Manual: `node dist/index.js import` with payee transformation enabled (for PR 4)
