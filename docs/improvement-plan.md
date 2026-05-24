# Improvement Plan

Based on codebase assessment 2026-05-24.

## PR 1: Fix Actual API types

**Issues covered:** #1 (stale local type declaration), #2 (deprecated `actual.internal`), #3 (unused DI)

### What

`src/types/actual-app__api.d.ts` is an incomplete local declaration that overrides the official `@actual-app/api` types via `tsconfig.json` paths. The installed package already ships types at `node_modules/@actual-app/api/@types/`.

### Why

This forces:

- `actual.init()` return value cast with `as` (ActualApi.ts L72–81)
- `(actual as any).getPayees()` + eslint-disable (ActualApi.ts L169)
- Fake exports (`doSomething`, `doSomethingElse`)
- Fragile global type declarations (`Account`, `ReadTransaction`, etc.)

The static import of `actual` is used inconsistently with the injected `this.actualApi`, making tests unreliable.

Additionally, `actual.internal` is marked deprecated in the official types — prefer the `init()` return value and public API methods (`actual.sync()` exists).

### Fix

1. Remove `src/types/actual-app__api.d.ts`
2. Remove the `paths` entry in `tsconfig.json`
3. Replace all `actual.X()` calls with `this.actualApi.X()` (or remove the DI parameter entirely)
4. Replace `actual.internal.send('sync')` with `actual.sync()` if available, or use `init()` return value
5. Fix any resulting type errors from the official types (may need minor adjustments)

### Expected outcome

- No `as any` casts interacting with Actual API
- No eslint-disable for `no-explicit-any` in ActualApi.ts
- Consistent DI behavior

---

## PR 2: Replace console monkey-patching

**Issue:** #4

### What

`src/utils/ActualApiLogControl.ts` has two functions:

- `withApiLogControl()`: suppresses **all** `console.log` during async callbacks (line 35: `console.log = () => {}`)
- `withGlobalApiNoiseFilter()`: patches `console.*`, `process.stdout.write`, and `process.stderr.write` globally with nested depth tracking

### Why

- Nested async overlap can restore globals early (outer call finishes before inner non-patching call)
- `process.stdout.write` is restored to a bound function, not the original identity
- `withApiLogControl` is too aggressive — it kills everything, not just Actual noise

### Fix

Check if `@actual-app/api` offers a logging level or quiet mode. If not, isolate filtering to a dedicated stream wrapper instead of patching process globals.

### Expected outcome

- No global monkey-patching of `console.*` or `process.std*`
- API noise filtering still works for non-verbose log levels

---

## PR 3: TypeScript hardening

**Issues:** #5 (`strictPropertyInitialization`), #6 (unparameterized `ArgumentsCamelCase`)

### What

`tsconfig.json` has `strictPropertyInitialization: false` because `AccountMap.ts` declares `moneyMoneyAccounts`, `actualAccounts`, and `mapping` without initializers, relying on `loadFromConfig()` to populate them. This weakens TypeScript checking globally.

`ArgumentsCamelCase` is used unparameterized across all command handlers, forcing casts like `argv.from as string`, `argv.dryRun as boolean`.

### Why

- Calling `getMap()` before `loadFromConfig()` is a runtime hazard with no type-level guard
- Parameterized argv types eliminate the need for casts and provide better IDE support

### Fix

1. Initialize AccountMap fields (`[]`, `new Map()`) or type them as `| undefined` with guards
2. Re-enable `strictPropertyInitialization`
3. Define command-specific argv types:
    ```ts
    type ImportArgs = { from?: string; to?: string; dryRun?: boolean; ... };
    const handler = (argv: ArgumentsCamelCase<ImportArgs>) => { ... };
    ```

### Expected outcome

- TypeScript catches uninitialized property access at compile time
- No `as string` / `as boolean` casts in command handlers

---

## PR 4: OpenAI v6 modernisation

**Issue:** #7

### What

`PayeeTransformer.ts` uses `response_format: { type: 'json_object' }` (older JSON mode) with manual `JSON.parse()` and a custom `OpenAIClient` type alias.

### Why

OpenAI v6 provides `client.chat.completions.parse()` with `zodResponseFormat()` for structured outputs. This eliminates:

- The custom `OpenAIClient` type (use SDK types directly)
- The manual `JSON.parse()` try/catch block
- The `parsed as Record<string, unknown>` cast
- The need to check `finish_reason` manually

Current handling doesn't schema-validate the response and silently falls back to raw payee names for missing/non-string keys.

### Fix

```ts
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const PayeeMap = z.record(z.string());

const completion = await this.openai.chat.completions.parse({
    model: this.config.openAiModel,
    messages: [...],
    response_format: zodResponseFormat(PayeeMap, 'payee_map'),
    temperature: this.config.temperature,
});
const payeeMap = completion.choices[0]?.message?.parsed; // typed!
```

### Expected outcome

- End-to-end type safety from OpenAI response to application code
- No manual JSON.parse or casting
- Proper schema validation

---

## PR 5: Housekeeping

**Issues:** #8–14 (independently small fixes, batched for efficiency)

| Issue                     | File                                                 | Fix                                         |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| Remove unused `ts-node`   | `package.json`                                       | Remove from devDependencies                 |
| Config URL validation     | `config.ts:62`                                       | `z.string()` → `z.string().url()`           |
| Fetch timeout             | `ActualApi.ts:296`                                   | Add `AbortSignal.timeout()` to fetchJson    |
| Non-atomic config writes  | `categories.command.ts:216`                          | Write to temp file → rename                 |
| Date timezone consistency | `Importer.ts:305–312`                                | Parse config dates through `date-fns/parse` |
| ZodError import style     | `config.ts`, `validate.command.ts`                   | Standardize on named `{ ZodError }` import  |
| Shutdown error masking    | `import.command.ts:241`, `categories.command.ts:134` | Catch/log shutdown errors separately        |

---

## Dependency ordering

1 → 2 → 3 → 4 → 5 is natural (core types → behavior → type hardening → feature modernisation → cleanup), but **none strictly depend on others** — they touch different concerns and can ship in any order.

## Verification

For each PR, verify with:

- `npm run lint:eslint && npm run lint:prettier`
- `npm run build`
- `npm run test`
- Manual: `node dist/index.js validate` and `node dist/index.js import --from=YYYY-MM-DD` (for PR 1, 2, 3, 5)
- Manual: `node dist/index.js import` with payee transformation enabled (for PR 4)
