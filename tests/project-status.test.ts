import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type Option = { id?: string; name: string; color: string; description: string };
type Item = { id: string; content?: { number: number; repository: { nameWithOwner: string; isPrivate: boolean } }; fieldValueByName: { optionId: string; name: string } | null };
type WorkflowRun = {
  event: string;
  conclusion: string;
  head_branch: string | null;
  head_repository: { full_name: string } | null;
};
type Context = {
  eventName: string;
  payload: {
    workflow_run?: WorkflowRun;
    action?: string;
    pull_request?: { number: number; merged: boolean; head: { ref: string; repo: { full_name: string } | null } };
  };
};
type Dependencies = { github: { graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown> }; context: Context; core: { info: (message: string) => void; setFailed: (message: string) => void } };
const { reconcileOptions, syncProjectStatus } = createRequire(import.meta.url)("../.github/scripts/project-status.cjs") as {
  reconcileOptions: (options: Option[]) => { options: Option[]; changed: boolean };
  syncProjectStatus: (dependencies: Dependencies) => Promise<void>;
};

const option = (name: string, id = name): Option => ({ id, name, color: "GRAY", description: `Synthetic ${id}` });
const statuses = () => ["Backlog", "Ready", "In Progress", "In Review", "Done"].map((name) => option(name));
const issueBranch = "issue-62-project-status-repair";
const alternateBranch = "issue-62-alternate-work";
const branchCreated = (overrides: Partial<WorkflowRun> = {}): Context => ({
  eventName: "workflow_run",
  payload: {
    workflow_run: {
      event: "create",
      conclusion: "success",
      head_branch: issueBranch,
      head_repository: { full_name: "Tzahile/budget-app" },
      ...overrides,
    },
  },
});
const create = branchCreated();
const pr = (action: string, merged = false, full_name = "Tzahile/budget-app", branch = issueBranch): Context => ({
  eventName: "pull_request_target", payload: { action, pull_request: { number: 68, merged, head: { ref: branch, repo: { full_name } } } },
});

function harness(initial = statuses()) {
  const lifecycle = {
    issueClosed: false, branchExists: true, pullState: null as "OPEN" | "CLOSED" | "MERGED" | null, pullBranch: issueBranch,
    mergedAt: "2026-11-11T14:00:00Z", reopenedAt: null as string | null,
  };
  const headRepository = { nameWithOwner: "Tzahile/budget-app" };
  let options = structuredClone(initial);
  const items: Item[] = [
    { id: "linked", content: { number: 62, repository: { nameWithOwner: "Tzahile/budget-app", isPrivate: false } }, fieldValueByName: { optionId: "Ready", name: "Ready" } },
    { id: "unrelated", content: { number: 37, repository: { nameWithOwner: "Tzahile/budget-app", isPrivate: false } }, fieldValueByName: { optionId: "Ready", name: "Ready" } },
    { id: "private", content: { number: 999, repository: { nameWithOwner: "other/private-sentinel", isPrivate: true } }, fieldValueByName: null },
  ];
  const mutations: { query: string; variables: Record<string, unknown> }[] = [];
  const core = { info: vi.fn<(message: string) => void>(), setFailed: vi.fn<(message: string) => void>() };
  const graphql = vi.fn<Dependencies["github"]["graphql"]>(async (query, variables = {}) => {
    if (query.includes("query StatusProjects")) return { user: { projectsV2: { nodes: [{ id: "project", title: "@Tzahile's budgetApp project" }], pageInfo: { hasNextPage: false } } } };
    if (query.includes("query StatusBranch")) {
      const requestedStates = query.match(/states: \[([^\]]+)\]/)?.[1].split(", ");
      const matchingPull = lifecycle.pullState && variables.branch === lifecycle.pullBranch && requestedStates?.includes(lifecycle.pullState);
      return { repository: {
        issue: { closed: lifecycle.issueClosed },
        ref: lifecycle.branchExists ? { name: variables.branch } : null,
        pullRequests: { nodes: matchingPull ? [{ headRepository }] : [], pageInfo: { hasNextPage: false } },
      } };
    }
    if (query.includes("query StatusPullRequest")) return { repository: {
      issue: { closed: lifecycle.issueClosed, timelineItems: { nodes: lifecycle.reopenedAt ? [{ createdAt: lifecycle.reopenedAt }] : [] } },
      pullRequest: lifecycle.pullState ? {
        state: lifecycle.pullState, mergedAt: lifecycle.mergedAt, headRefName: lifecycle.pullBranch, headRepository,
      } : null,
    } };
    if (query.includes("query StatusFields")) return { node: { fields: { nodes: [{ id: "status", name: "Status", options: structuredClone(options) }], pageInfo: { hasNextPage: false } } } };
    if (query.includes("query StatusItemAudit")) return { node: { items: { nodes: structuredClone(items), pageInfo: { hasNextPage: false } } } };
    mutations.push({ query, variables });
    if (query.includes("mutation RepairStatusOptions")) {
      options = (variables.options as Option[]).map((value, index) => ({ ...value, id: value.id ?? `new-${index}` }));
      for (const item of items) if (item.fieldValueByName) item.fieldValueByName.name = options.find((value) => value.id === item.fieldValueByName!.optionId)?.name ?? "unknown";
      return { updateProjectV2Field: { projectV2Field: { options: structuredClone(options) } } };
    }
    if (query.includes("mutation TransitionIssueStatus")) {
      const item = items.find((value) => value.id === variables.itemId)!;
      const selected = options.find((value) => value.id === variables.optionId)!;
      item.fieldValueByName = { optionId: selected.id!, name: selected.name };
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } };
    }
    throw new Error("Unexpected synthetic GraphQL operation");
  });
  return { options: () => options, items, graphql, core, mutations, lifecycle, run: (context: Context) => syncProjectStatus({ github: { graphql }, core, context }) };
}

describe("project Status repair and transitions", () => {
  it("creates missing In Progress and In Review while retaining every option identity/metadata and unrelated item value", async () => {
    const existing = [option("Backlog"), option("Ready"), option("Done"), option("Custom waiting", "custom-id")];
    const state = harness(existing);
    await state.run(create);
    expect(state.core.setFailed).not.toHaveBeenCalled();
    expect(state.options()).toEqual(expect.arrayContaining(existing));
    expect(state.options().map((value) => value.name)).toEqual(["Backlog", "Ready", "Done", "Custom waiting", "In Progress", "In Review"]);
    expect(state.mutations[0].variables.options).toEqual(expect.arrayContaining(existing));
    expect(state.items[0].fieldValueByName?.name).toBe("In Progress");
    expect(state.items[1].fieldValueByName?.optionId).toBe("Ready");
    expect(state.items[2].fieldValueByName).toBeNull();
    const logs = state.core.info.mock.calls.flat().join("\n");
    expect(logs).toContain("Before Status options");
    expect(logs).toContain("After repair Status options");
    expect(logs).toContain("all existing item values survived repair");
    expect(logs).not.toContain("private-sentinel");
    expect(logs).not.toContain("999");
  });

  it("renames unambiguous case/whitespace aliases in place and preserves custom options", () => {
    const before = [option("  in   PROGRESS  ", "progress-id"), option(" ready ", "ready-id"), option("Custom", "custom")];
    const repair = reconcileOptions(before);
    expect(repair.options.slice(0, 3)).toEqual([{ ...before[0], name: "In Progress" }, { ...before[1], name: "Ready" }, before[2]]);
    expect(before[0].name).toBe("  in   PROGRESS  ");
    expect(repair.changed).toBe(true);
  });

  it("preserves differently cased custom options when the exact canonical status already exists", () => {
    const before = [...statuses(), option(" ready ", "custom-ready")];
    expect(reconcileOptions(before)).toEqual({ options: before, changed: false });
  });

  it("fails ambiguous aliases before any mutation", async () => {
    const state = harness([option("in progress", "one"), option(" IN PROGRESS ", "two"), option("Ready")]);
    await state.run(create);
    expect(state.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Ambiguous normalized Status aliases"));
    expect(state.mutations).toEqual([]);
  });

  it("rejects duplicate option identities without replacing existing options", () => {
    expect(() => reconcileOptions([option("Ready", "duplicate"), option("Custom", "duplicate")])).toThrow("Duplicate existing Status option identity");
  });

  it("transitions branch→review→done, handles reopen and avoids duplicate mutations", async () => {
    const state = harness();
    for (const [event, pullState, expected] of [[create, null, "In Progress"], [pr("opened"), "OPEN", "In Review"], [pr("reopened"), "OPEN", "In Review"], [pr("closed", true), "MERGED", "Done"]] as const) {
      state.lifecycle.pullState = pullState;
      await state.run(event);
      expect(state.items[0].fieldValueByName?.name).toBe(expected);
    }
    expect(state.core.setFailed).not.toHaveBeenCalled();
    expect(state.mutations).toHaveLength(3);
    expect(state.mutations.every((mutation) => mutation.query.includes("TransitionIssueStatus"))).toBe(true);
  });

  it("ignores a delayed branch signal and reruns after opening and merging the PR", async () => {
    const state = harness();
    state.lifecycle.pullState = "OPEN";
    await state.run(pr("opened"));
    await state.run(create);
    expect(state.items[0].fieldValueByName?.name).toBe("In Review");

    state.lifecycle.pullState = "MERGED";
    await state.run(pr("closed", true));
    await state.run(create);
    await state.run(pr("opened"));
    expect(state.items[0].fieldValueByName?.name).toBe("Done");
    expect(state.mutations.map(({ variables }) => variables.optionId)).toEqual(["In Review", "Done"]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it.each(["OPEN", "MERGED"] as const)("waits for the PR transition when the branch already has a %s PR", async (pullState) => {
    const state = harness();
    state.lifecycle.pullState = pullState;
    await state.run(create);
    expect(state.items[0].fieldValueByName?.name).toBe("Ready");
    expect(state.mutations).toEqual([]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it.each(["Ready", "Backlog"])("advances %s when the live branch's only PR closed without merging", async (initialStatus) => {
    const state = harness();
    state.items[0].fieldValueByName = { optionId: initialStatus, name: initialStatus };
    state.lifecycle.pullState = "CLOSED";
    await state.run(create);
    await state.run(pr("opened"));
    expect(state.items[0].fieldValueByName?.name).toBe("In Progress");
    expect(state.mutations.map(({ variables }) => variables.optionId)).toEqual(["In Progress"]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("preserves In Review after the branch's PR closes without merging", async () => {
    const state = harness();
    state.lifecycle.pullState = "OPEN";
    await state.run(pr("opened"));
    state.lifecycle.pullState = "CLOSED";
    await state.run(create);
    expect(state.items[0].fieldValueByName?.name).toBe("In Review");
    expect(state.mutations.map(({ variables }) => variables.optionId)).toEqual(["In Review"]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("preserves In Review and Done when events arrive for another branch of the same issue", async () => {
    const state = harness();
    state.lifecycle.pullState = "OPEN";
    await state.run(pr("opened"));
    const alternateSignal = branchCreated({ head_branch: alternateBranch });
    await state.run(alternateSignal);
    expect(state.items[0].fieldValueByName?.name).toBe("In Review");

    state.lifecycle.pullState = "MERGED";
    await state.run(pr("closed", true));
    await state.run(alternateSignal);
    state.lifecycle.pullState = "OPEN";
    state.lifecycle.pullBranch = alternateBranch;
    await state.run(pr("opened", false, "Tzahile/budget-app", alternateBranch));
    expect(state.items[0].fieldValueByName?.name).toBe("Done");
    expect(state.mutations.map(({ variables }) => variables.optionId)).toEqual(["In Review", "Done"]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("recognizes a repairable alias as a higher state without mutating the item", async () => {
    const alias = option("  in REVIEW ", "legacy-review");
    const state = harness(statuses().filter(({ name }) => name !== "In Review").concat(alias));
    state.items[0].fieldValueByName = { optionId: alias.id!, name: alias.name };
    await state.run(create);
    expect(state.mutations).toEqual([]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("skips branch and review events for closed issues but still records the merge", async () => {
    const state = harness();
    state.lifecycle.issueClosed = true;
    await state.run(create);
    state.lifecycle.pullState = "OPEN";
    await state.run(pr("opened"));
    expect(state.mutations).toEqual([]);

    state.lifecycle.pullState = "MERGED";
    await state.run(pr("closed", true));
    expect(state.items[0].fieldValueByName?.name).toBe("Done");
    expect(state.mutations).toHaveLength(1);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("skips a branch signal after the branch is deleted", async () => {
    const state = harness();
    state.lifecycle.branchExists = false;
    await state.run(create);
    expect(state.mutations).toEqual([]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it("skips an old merge after the issue reopens", async () => {
    const state = harness();
    state.lifecycle.pullState = "MERGED";
    state.lifecycle.reopenedAt = "2026-11-11T15:00:00Z";
    await state.run(pr("closed", true));
    expect(state.mutations).toEqual([]);
    expect(state.core.setFailed).not.toHaveBeenCalled();
  });

  it.each([
    pr("closed"),
    pr("opened", false, "external/fork"),
    { ...pr("opened"), eventName: "pull_request" },
    branchCreated({ event: "pull_request" }),
    branchCreated({ conclusion: "skipped" }),
    branchCreated({ head_repository: { full_name: "external/fork" } }),
    branchCreated({ head_branch: null }),
    branchCreated({ head_branch: "ordinary-branch" }),
  ])("leaves ineligible events unchanged without GraphQL access", async (event) => {
    const state = harness();
    await state.run(event);
    expect(state.graphql).not.toHaveBeenCalled();
    expect(state.mutations).toEqual([]);
  });

  it("does not transition when repair loses an existing option ID", async () => {
    const state = harness([option("Ready"), option("Done")]);
    const original = state.graphql.getMockImplementation()!;
    state.graphql.mockImplementation(async (query, vars) => {
      const result = await original(query, vars);
      if (query.includes("RepairStatusOptions")) return { updateProjectV2Field: { projectV2Field: { options: [option("Ready", "wrong-id")] } } };
      return result;
    });
    await state.run(create);
    expect(state.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("option identities"));
    expect(state.mutations).toHaveLength(1);
  });

  it("detects cleared item values after repair and stops before transition", async () => {
    const state = harness([option("Ready"), option("Done")]);
    const original = state.graphql.getMockImplementation()!;
    state.graphql.mockImplementation(async (query, vars) => {
      const result = await original(query, vars);
      if (query.includes("RepairStatusOptions")) state.items[1].fieldValueByName = null;
      return result;
    });
    await state.run(create);
    expect(state.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("item values"));
    expect(state.mutations).toHaveLength(1);
  });

  it("keeps raw API errors private and stops a failed repair", async () => {
    const state = harness([option("Ready")]);
    const original = state.graphql.getMockImplementation()!;
    state.graphql.mockImplementation(async (query, vars) => {
      if (query.includes("RepairStatusOptions")) throw new Error("SECRET_TOKEN PRIVATE_CONTENT_SENTINEL");
      return original(query, vars);
    });
    await state.run(create);
    expect(state.core.setFailed).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.core.setFailed.mock.calls)).not.toContain("SECRET_TOKEN");
    expect(state.mutations).toEqual([]);
  });

  it("detects disappearance of an unrelated empty-status item after transition", async () => {
    const state = harness();
    const original = state.graphql.getMockImplementation()!;
    state.graphql.mockImplementation(async (query, vars) => {
      const result = await original(query, vars);
      if (query.includes("TransitionIssueStatus")) state.items.splice(2, 1);
      return result;
    });
    await state.run(create);
    expect(state.core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Unrelated project item Status changed"));
  });

  it("paginates item audits so values beyond the first page are checked", async () => {
    const state = harness([option("Ready"), option("Done")]);
    const original = state.graphql.getMockImplementation()!;
    state.graphql.mockImplementation(async (query, vars) => {
      if (query.includes("StatusItemAudit")) return { node: { items: {
        nodes: structuredClone(vars?.cursor ? state.items.slice(1) : state.items.slice(0, 1)),
        pageInfo: vars?.cursor ? { hasNextPage: false } : { hasNextPage: true, endCursor: "next" },
      } } };
      return original(query, vars);
    });
    await state.run(create);
    expect(state.core.setFailed).not.toHaveBeenCalled();
    expect(state.graphql.mock.calls.some(([query, vars]) => query.includes("StatusItemAudit") && vars?.cursor === "next")).toBe(true);
    expect(state.items[1].fieldValueByName?.optionId).toBe("Ready");
  });

  it("keeps privileged automation on the trusted default branch and queues eligible events", () => {
    const workflow = readFileSync(new URL("../.github/workflows/project-status.yml", import.meta.url), "utf8");
    expect(workflow).toContain("queue: max");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toMatch(/^ {2}pull_request_target:$/m);
    expect(workflow).not.toMatch(/^ {2}(pull_request|create):/m);
    expect(workflow).toContain("environment: project-automation");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toContain(".head.sha");
    expect(workflow).toContain("workflows: [Project branch created]");
    const signal = readFileSync(new URL("../.github/workflows/project-branch-created.yml", import.meta.url), "utf8");
    expect(signal).toContain("on: create");
    expect(signal).toContain("github.event.ref_type == 'branch'");
    expect(signal).toContain("permissions: {}");
    expect(signal).not.toContain("secrets.");
    const metadata = readFileSync(new URL("../.github/workflows/project-metadata-sync.yml", import.meta.url), "utf8");
    expect(metadata).toContain("environment: project-automation");
    expect(workflow).toContain("require('./.github/scripts/project-status.cjs')");
    expect(workflow).toContain("await syncProjectStatus({ github, context, core })");
  });
});
