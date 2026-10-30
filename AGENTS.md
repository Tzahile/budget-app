# BudgetApp agent instructions

These instructions apply to the entire repository. Follow the Project's
financial-correctness, privacy, and GitHub issue workflow rules.

## Implementation workflow

- Work on exactly one GitHub issue per run. Use branch name
  `issue-<ISSUE_NUMBER>-<short-description>`.
- Preserve small coherent commits; push the branch and open a PR linked with
  `Closes #<ISSUE_NUMBER>` when appropriate, then stop.
- Project Status is maintained by GitHub Actions; do not manually change it
  unless automation fails.

## Validation policy

- During development, run **targeted local checks** that help catch defects
  in changed behavior (for example a relevant Vitest file or ESLint on changed
  files). Run broader checks locally when diagnosing failures, not as a
  repetitive end-of-task ritual.
- **GitHub Actions `CI / Validate` is the full pre-merge validation gate.**
  It runs the complete test suite, TypeScript typecheck, lint, and Deno module
  checks on pull requests. Never claim the branch is validated based only on
  focused local checks.
- Do not merge if the required CI check is pending, absent, or failing.
  The repository owner must enable the required check on `main` in GitHub
  Rulesets/branch protection; the instructions are in README.md.
- Do not change the deployed `main` revision or bypass CI to fix a failure.

## Financial and security boundaries

- Keep money calculations deterministic, pure, and tested using integer minor
  units. Never use production banking data for development or tests.
- Do not commit credentials, personal financial records, or tokens.
- Keep Open Banking and AI provider secrets server-side. AI does not mutate
  accounting state and cannot receive non-redacted identifying financial data.
