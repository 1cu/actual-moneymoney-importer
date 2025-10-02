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
1. Install dependencies with `npm install`
1. Run the quality gates: `npm run lint:all && npm run typecheck && npm test`

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

## Coderabbit Comment Handling

**CRITICAL**: Not all Coderabbit suggestions are necessary or beneficial. Follow these guidelines:

### **Automated Comment Processing**

The project includes a sophisticated comment processing script (`scripts/get-coderabbit-comments.py`) that:

- **Fetches comments** from GitHub PRs using the GitHub CLI
- **Categorizes comments** by type (issue, refactor, nitpick, command, summary)
- **Extracts metadata** (priority, file path, author, dates)
- **Provides assessment guidance** for unresolved comments
- **Manages resolution state** (resolved, skipped, unresolved)

### **Usage Commands**

```bash
# Show all comments with status
python3 scripts/get-coderabbit-comments.py <PR_NUMBER> --status

# Show only unresolved comments
python3 scripts/get-coderabbit-comments.py <PR_NUMBER> --status-unresolved

# Show assessment guidance for unresolved comments
python3 scripts/get-coderabbit-comments.py <PR_NUMBER> --assess

# Mark comments as resolved (fixed)
python3 scripts/get-coderabbit-comments.py <PR_NUMBER> --resolve <COMMENT_ID1>,<COMMENT_ID2>

# Mark comments as skipped (ignored)
python3 scripts/get-coderabbit-comments.py <PR_NUMBER> --skip <COMMENT_ID1>,<COMMENT_ID2>
```

### **Assessment Guidance System**

The script provides intelligent assessment guidance:

- **🔴 Should address: High priority issue** - Major issues that need fixing
- **🟡 Should address: Minor issue** - Minor issues usually worth addressing
- **🟢 Review: Simple config file fix** - Trivial nitpicks on config files (often simple)
- **🔵 Review: Trivial nitpick** - Code nitpicks that need evaluation
- **⚪ Review: Evaluate based on content** - Other categories need manual review

### **Evaluation Framework**

1. **🔴 CRITICAL - Must Fix:**

- Security vulnerabilities (credential exposure, data leaks)
- Data integrity issues (silent data loss, corruption)
- System stability (crashes, infinite loops)

1. **🟠 MAJOR - Should Fix:**

- Missing error handling for external service calls
- Resilience improvements with simple fallback mechanisms
- User experience improvements (clear error messages)

1. **🟡 MINOR - Nice to Have:**

- Error message clarity improvements
- Documentation and code comments
- Additional debug logging (when valuable)

1. **🔵 TRIVIAL - Evaluate:**

- Configuration file improvements (often simple fixes)
- Code style suggestions (evaluate based on content)
- Documentation updates (assess value vs. effort)

### **Decision Process**

1. **Read the comment content** - Don't skip based on priority alone
2. **Use assessment guidance** - The script provides intelligent recommendations
3. **Question every suggestion** - Is this fix truly necessary?
4. **Consider complexity** - Does it add unnecessary complexity?
5. **Look for simpler solutions** - Can this be solved more simply?
6. **Follow project guidelines** - Does it align with complexity prevention?

### **Anti-Patterns to Avoid**

- Complex error handling with multiple fallback layers
- Generic abstractions that hide complexity
- Excessive logging and debugging infrastructure
- Complex configuration with too many options
- Over-mocking in tests
- **Bulk skipping comments** without reading content

### **Preferred Patterns**

- Simple, direct code that's readable by new developers
- Minimal error handling with clear error messages
- Single-purpose utilities with focused interfaces
- Simple test data and minimal fixtures
- Direct API calls without unnecessary abstraction layers
- **Evaluate each comment individually** based on content and context

**Remember**: The best code is code that doesn't exist. Delete over refactor, inline over abstract, simplify over optimize.

For detailed guidance, see [`.cursor/rules/coderabbit-comment-handling.mdc`](.cursor/rules/coderabbit-comment-handling.mdc).
