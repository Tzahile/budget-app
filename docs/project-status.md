# Project Status automation

`.github/workflows/project-status.yml` uses the tested helper
`.github/scripts/project-status.cjs` to manage the existing BudgetApp Project's
Status field. `PROJECT_TOKEN` must allow reading the repository/issues and
reading/updating Tzahile's Project. Tokens and raw GraphQL errors are never
logged.

Matching `issue-<number>-...` branches move their linked issue to **In Progress**.
Opening or reopening a same-repository PR moves it to **In Review**. Merging
the PR moves it to **Done**. Closing a PR without merging leaves Status unchanged. Tags,
unrelated branches and fork PRs make no Project reads or writes. The issue must
already be in the Project; automation does not add items or select another
Project silently.

## Repair without clearing item values

Eligible runs reconcile **Backlog / Ready / In Progress / In Review / Done**
before applying the event transition. Every existing option is submitted with
its original `id`, color and description. The
[GitHub GraphQL Projects reference](https://docs.github.com/en/graphql/reference/projects#projectv2singleselectfieldoptioninput)
documents that including an existing option's ID preserves identity and prevents
item field values from being cleared during replacement updates.

An exact canonical option wins. Additional custom options, including differently
cased names, remain unchanged. If a canonical name is absent, a single matching
case/whitespace alias is renamed in place, retaining its ID; multiple matching
aliases fail before any mutation. Only genuinely missing statuses are appended.
Unknown/custom options are never removed. Duplicate existing option IDs and
ambiguous Status fields also fail closed.

Before a repair, automation snapshots all existing items' option IDs with
pagination. After repair it verifies every existing option identity/metadata
and every existing item's selected option (including empty values) survived.
Only then does it change the linked issue. A final read verifies that transition
and that unrelated existing items and their values remain intact. Concurrent
manual Project edits can fail these preservation checks; the workflow reports
the failure instead of making compensating writes to other items.

Runs use one shared concurrency group with `queue: max` and
`cancel-in-progress: false` so replacement-style field updates cannot overlap,
and pending events are queued instead of replacing one another (GitHub's
documented queue limit still applies). See
[workflow concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
Before touching the Project, runs read the current issue and pull request
lifecycle. A branch signal is skipped if the issue is closed, the branch was
deleted, or a same-repository PR for that branch is open or merged. A live
branch with only closed, unmerged PRs can still move an issue to **In Progress**.
Review transitions require an open issue and PR. Done requires a merged PR
whose merge did not precede the most recent reopening of the issue.
Automation preserves higher Project statuses across all branches for an issue.
To restart work on a reopened issue that is still marked **Done**, reset its
Project Status before creating a branch or reopening a PR.

## Project token setup

1. In repository **Settings → Environments**, create `project-automation`.
   Under deployment branches and tags, allow only the `main` branch and no tags.
2. Store a rotated `PROJECT_TOKEN` as an environment secret and remove the old
   repository-level secret during rollout. Check that an organization-level secret
   of the same name is unavailable to this repository. Both Project status and
   issue metadata automation use the environment secret.
3. Verify that the repository's effective Actions event policy permits
   `pull_request_target` for `.github/workflows/project-status.yml`. See
   [GitHub's event policy documentation](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#default-policy-for-pull_request_target).
4. After rollout, confirm branch creation, PR open/reopen, PR merge, and issue
   metadata sync on a disposable issue already in the Project.

The unprivileged branch-creation workflow emits a completion signal. A
`workflow_run` job uses GitHub's event metadata to identify the branch and
does not consume artifacts or caches from that run. PR transitions use
`pull_request_target` for same-repository PRs.
Both events check out the default-branch commit identified by `github.sha`
before loading the helper, including for PRs targeting another branch. Regular
PR CI checks and tests proposed changes without the protected environment.
Create new issue branches from a revision that contains the signal workflow.

## Verification and diagnostics

Workflow logs include before/after Status option names and IDs, plus issue
numbers and Status values only for public `Tzahile/budget-app` issues. Private
or unrelated Project content is not logged. Preservation checks include all
items internally, even those omitted from the public audit. Bounded diagnostics
identify known validation failures; arbitrary API error bodies are suppressed.

`npx vitest run tests/project-status.test.ts` executes the actual helper with
synthetic GraphQL responses, covering missing options, aliases, preserved custom
IDs/item values, lifecycle transitions, safe no-ops, pagination, failed repairs,
and workflow wiring. Run focused lint on the helper/tests while developing;
full validation remains the required GitHub `CI / Validate` gate. This change
does not alter application/deployment code, bank blockers, or branch protection.
