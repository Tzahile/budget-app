# Project Status automation

`.github/workflows/project-status.yml` uses the tested helper
`.github/scripts/project-status.cjs` to manage the existing BudgetApp Project's
Status field. `PROJECT_TOKEN` must allow reading the repository/issues and
reading/updating Tzahile's Project. Tokens and raw GraphQL errors are never
logged.

Matching `issue-<number>-...` branches move their linked issue to **In Progress**.
Same-repository PRs opened/reopened move it to **In Review**; merged PRs move it
to **Done**. Closing a PR without merging leaves Status unchanged. Tags,
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
documented queue limit still applies). Same-repository PRs check out the immutable
head SHA; branch-created runs check out the default branch so an older task
branch need not contain the helper. Fork PRs never run checked-out code with
the Project token. See
[workflow concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

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
