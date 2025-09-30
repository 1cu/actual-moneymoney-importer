# Testing Guidelines for `actual-moneymoney`

## Test runner

- Vitest powers the automated tests. Run the full suite with `npm test`
  (configured as `vitest run`).
- Tests live under `tests/` and mirror the structure of `src/`:
  - `ActualApi.test.ts` covers timeout handling, console suppression, and the
    lifecycle of the Actual API wrapper.
  - `Importer.test.ts` verifies MoneyMoney transaction filtering, deduplication,
    and dry-run behaviour.
  - `PayeeTransformer.test.ts` exercises OpenAI integration, caching, and
    logging safeguards.
  - `config.test.ts` validates the Zod schema, earliest import date parsing, and
    encryption requirements.

## Writing and maintaining tests

- Use `vi.mock()` to isolate external dependencies (`@actual-app/api`,
  `moneymoney`, `openai`). Declare mocks at the top of the file and reset them
  in `beforeEach` to avoid cross-test bleed.
- Prefer helper factories within the test file for building complex fixtures
  (see `Importer.test.ts` for examples). Keep fixture data minimal but
  representative of real MoneyMoney transactions or Actual accounts.
- For async code, mark tests as `async` and `await` promises. Use
  `vi.useFakeTimers()` sparingly to control timeout scenarios (e.g., Actual API
  timeouts) and always restore timers in `afterEach`.
- When asserting logging behaviour, rely on `vi.spyOn(logger, 'method')` or mock
  loggers that mimic the interface in `src/utils/Logger.ts`.
- Keep expectations specific: check argument values, invocation order, and error
  messages so regressions are caught early.

Target the assertions that deliver the most value—100% coverage is neither
expected nor desired. It is acceptable to prune or skip low-value scenarios so
long as the critical paths continue to have protection.

## Complexity Prevention in Tests

**CRITICAL**: Follow complexity prevention guidelines to avoid over-engineered tests:

- **Keep tests simple**: Minimal fixtures, avoid over-mocking
- **Don't over-mock**: Mock only what's necessary
- **Prefer integration over unit**: Test real behavior when possible
- **Remove obsolete tests**: Delete tests for removed functionality
- **Avoid complex test builders**: Use simple test data instead

### Test anti-patterns to avoid

- Complex test builders with multiple setup methods
- Over-mocking that duplicates production code
- Complex test fixtures with excessive detail
- Tests that are harder to understand than the code they test
- Obsolete tests that no longer provide value

### Preferred test patterns

- Simple test data that's minimal but representative
- Mock only external services, not internal utilities
- Focus on critical paths and edge cases
- Clear, readable test descriptions
- Tests that fail with actionable error messages

### Appropriate fixtures vs Over-engineered fixtures

**Appropriate fixtures** are reusable, minimal error shapes for external failures:
- Keep fixtures small, documented, and focused on reuse
- Use for common failure patterns (network errors, authentication failures)
- Example: `tests/helpers/error-fixtures.ts` provides minimal, reusable error shapes
- Focus on essential error properties needed for testing

**Over-engineered fixtures** should be avoided:
- Complex builders with multiple setup methods
- Excessive, brittle data that's hard to maintain
- Comprehensive simulation that duplicates production complexity
- Fixtures that are harder to understand than the code they test

When creating fixtures, ask: "Does this fixture solve a real testing need with minimal complexity?" If the answer is no, simplify or remove it.

## Error-path fixtures

- `tests/helpers/error-fixtures.ts` exposes helpers for simulating Actual API
  failures:
  - `makeNetworkDisconnectError` models network disconnects/`ECONNREFUSED`
    scenarios and chains the cause metadata that `runActualRequest` inspects.
  - `makeInvalidCredentialsError` produces authentication failures, allowing
    suites to assert the friendly messaging emitted by the CLI.
- The fixtures are consumed by `tests/ActualApi.test.ts` to verify
  `ActualApi.init()` guidance when connectivity or password issues occur.
- Extend the module with additional helpers (e.g., TLS errors) as new failure
  shapes surface.

## Importer malformed export coverage

- `Importer` validates MoneyMoney transactions before conversion and raises
  actionable errors when required fields (`valueDate`, `amount`, `id`,
  `accountUuid`) are missing.
- `tests/Importer.test.ts` contains `rejects malformed MoneyMoney transactions`
  to ensure corrupted exports surface a helpful error and avoid partial
  imports.
- When adding new importer guards, co-locate regression coverage in this file
  so CLI feedback stays actionable.

## Updating tests alongside source changes

- Whenever you touch logic in `src/utils/` or `src/commands/`, review the
  related test file(s) and extend them to cover the new behaviour.
- Configuration schema updates must extend `config.test.ts` to cover success,
  failure, and edge cases (e.g., missing passwords when encryption is enabled).
- If new utilities are introduced, add matching test files under `tests/` and
  follow the naming convention `*.test.ts`.

## Tooling expectations

- Keep the Vitest configuration (`vitest.config.ts`) untouched unless you have a
  compelling reason to change the runtime.
- Tests should pass with the repo’s linting and formatting rules. ESLint and
  Prettier run against the TypeScript tests, while Markdown documentation relies
  on `mdformat`—stick to the existing style (4 spaces, single quotes) for
  consistency.
