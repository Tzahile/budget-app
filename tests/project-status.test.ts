import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type Option = { id?: string; name: string; color: string; description: string };
type Item = { id: string; content?: { number: number; repository: { nameWithOwner: string; isPrivate: boolean } }; fieldValueByName: { optionId: string; name: string } | null };
type Context = { eventName: string; payload: { ref_type?: string; ref?: string; action?: string; pull_request?: { merged: boolean; head: { ref: string; repo: { full_name: string } } } } };
type Dependencies = { github: { graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown> }; context: Context; core: { info: (message: string) => void; setFailed: (message: string) => void } };
const { reconcileOptions, syncProjectStatus } = createRequire(import.meta.url)("../.github/scripts/project-status.cjs") as {
  reconcileOptions: (options: Option[]) => { options: Option[]; changed: boolean };
  syncProjectStatus: (dependencies: Dependencies) => Promise<void>;
};

const option = (name: string, id = name): Option => ({ id, name, color: "GRAY", description: `Synthetic ${id}` });
const statuses = () => ["Backlog", "Ready", "In Progress", "In Review", "Done"].map((name) => option(name));
const create: Context = { eventName: "create", payload: { ref_type: "branch", ref: "issue-62-project-status-repair" } };
const pr = (action: string, merged = false, full_name = "Tzahile/budget-app"): Context => ({
  eventName: "pull_request", payload: { action, pull_request: { merged, head: { ref: "issue-62-project-status-repair", repo: { full_name } } } },
});

function harness(initial = statuses()) {
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
    if (query.includes("query StatusIssue")) return { repository: { issue: { id: "issue62" } } };
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
  return { options: () => options, items, graphql, core, mutations, run: (context: Context) => syncProjectStatus({ github: { graphql }, core, context }) };
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
    for (const [event, expected] of [[create, "In Progress"], [pr("opened"), "In Review"], [pr("reopened"), "In Review"], [pr("closed", true), "Done"]] as const) {
      await state.run(event);
      expect(state.items[0].fieldValueByName?.name).toBe(expected);
    }
    expect(state.core.setFailed).not.toHaveBeenCalled();
    expect(state.mutations).toHaveLength(3);
    expect(state.mutations.every((mutation) => mutation.query.includes("TransitionIssueStatus"))).toBe(true);
  });

  it.each([pr("closed"), pr("opened", false, "external/fork"), { eventName: "create", payload: { ref_type: "tag", ref: "issue-62" } }, { eventName: "create", payload: { ref_type: "branch", ref: "ordinary-branch" } }])("leaves ineligible events unchanged without GraphQL access", async (event) => {
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

  it("workflow uses the tested helper, queues every event, and excludes fork secret execution", () => {
    const workflow = readFileSync(new URL("../.github/workflows/project-status.yml", import.meta.url), "utf8");
    expect(workflow).toContain("queue: max");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("github.event.pull_request.head.sha || github.event.repository.default_branch");
    expect(workflow).toContain("require('./.github/scripts/project-status.cjs')");
    expect(workflow).toContain("await syncProjectStatus({ github, context, core })");
  });
});
