/* global module */
const owner = "Tzahile";
const repo = "budget-app";
const projectTitle = "@Tzahile's budgetApp project";
const canonical = [
  { name: "Backlog", color: "GRAY", description: "Not yet ready for implementation" },
  { name: "Ready", color: "BLUE", description: "Ready for implementation" },
  { name: "In Progress", color: "ORANGE", description: "Implementation branch created" },
  { name: "In Review", color: "YELLOW", description: "Pull request open for review" },
  { name: "Done", color: "GREEN", description: "Linked pull request merged" },
];
const normalize = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
class SyncFailure extends Error {}

function reconcileOptions(existing) {
  const ids = new Set();
  for (const option of existing) {
    if (!option.id || typeof option.name !== "string" || !option.name.trim()) throw new SyncFailure("Invalid existing Status option");
    if (ids.has(option.id)) throw new SyncFailure("Duplicate existing Status option identity");
    ids.add(option.id);
  }
  const options = existing.map(({ id, name, color, description }) => ({ id, name, color, description }));
  for (const status of canonical) {
    const exact = options.filter((option) => option.name === status.name);
    if (exact.length > 1) throw new SyncFailure("Ambiguous canonical Status options");
    if (exact.length === 1) continue;
    const aliases = options.filter((option) => normalize(option.name) === normalize(status.name));
    if (aliases.length > 1) throw new SyncFailure("Ambiguous normalized Status aliases; repair names manually before retrying");
    if (aliases.length === 1) aliases[0].name = status.name;
    else options.push({ ...status });
  }
  return { options, changed: options.length !== existing.length || options.some((option, index) => option.name !== existing[index]?.name) };
}

function eventTransition(context) {
  const repository = `${owner}/${repo}`.toLowerCase();
  if (context.eventName === "workflow_run") {
    const run = context.payload.workflow_run;
    if (run?.event !== "create" || run.conclusion !== "success" ||
        run.head_repository?.full_name.toLowerCase() !== repository) return null;
    return { branch: run.head_branch, status: "In Progress", occurredAt: run.created_at };
  }
  if (context.eventName !== "pull_request_target") return null;
  const pr = context.payload.pull_request;
  if (pr?.head.repo?.full_name.toLowerCase() !== repository) return null;
  if (["opened", "reopened"].includes(context.payload.action)) {
    const occurredAt = context.payload.action === "opened" ? pr.created_at : pr.updated_at;
    return { branch: pr.head.ref, status: "In Review", pullNumber: pr.number, occurredAt };
  }
  if (context.payload.action === "closed" && pr.merged) return { branch: pr.head.ref, status: "Done", pullNumber: pr.number };
  return null;
}

function issueReopenTime(issue) {
  const reopenedAt = issue.timelineItems?.nodes[0]?.createdAt;
  return reopenedAt ? Date.parse(reopenedAt) : null;
}

async function currentTransition(graphql, number, { branch, status, pullNumber, occurredAt }) {
  const repository = `${owner}/${repo}`.toLowerCase();
  if (status !== "In Progress") {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new SyncFailure("Invalid pull request number");
    const result = await graphql(`query StatusPullRequest($owner: String!, $repo: String!, $number: Int!, $pullNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          closed
          timelineItems(last: 1, itemTypes: [REOPENED_EVENT]) {
            nodes { ... on ReopenedEvent { createdAt } }
          }
        }
        pullRequest(number: $pullNumber) { state mergedAt headRefName headRepository { nameWithOwner } }
      }
    }`, { owner, repo, number, pullNumber });
    const { issue, pullRequest } = result.repository ?? {};
    if (!issue) throw new SyncFailure("Linked issue was not found");
    if (!pullRequest) throw new SyncFailure("Linked pull request was not found");
    if (pullRequest.headRefName !== branch || pullRequest.headRepository?.nameWithOwner.toLowerCase() !== repository) return null;
    const reopenedAt = issueReopenTime(issue);
    if (status === "Done") {
      return pullRequest.state === "MERGED" && (reopenedAt === null || Date.parse(pullRequest.mergedAt) > reopenedAt)
        ? { reopenedAt } : null;
    }
    return !issue.closed && pullRequest.state === "OPEN" && (reopenedAt === null || Date.parse(occurredAt) > reopenedAt)
      ? { reopenedAt } : null;
  }

  let cursor = null;
  let reopenedAt = null;
  do {
    const result = await graphql(`query StatusBranch($owner: String!, $repo: String!, $number: Int!, $branch: String!, $ref: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          closed
          timelineItems(last: 1, itemTypes: [REOPENED_EVENT]) {
            nodes { ... on ReopenedEvent { createdAt } }
          }
        }
        ref(qualifiedName: $ref) { name }
        pullRequests(first: 100, after: $cursor, headRefName: $branch, states: [OPEN, MERGED]) {
          nodes { state mergedAt headRepository { nameWithOwner } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { owner, repo, number, branch, ref: `refs/heads/${branch}`, cursor });
    const { issue, ref, pullRequests } = result.repository ?? {};
    if (!issue) throw new SyncFailure("Linked issue was not found");
    reopenedAt = issueReopenTime(issue);
    if (issue.closed || !ref || (reopenedAt !== null && !(Date.parse(occurredAt) > reopenedAt))) return null;
    if (!pullRequests) throw new SyncFailure("Could not check branch pull requests");
    if (pullRequests.nodes.some((pr) => pr.headRepository?.nameWithOwner.toLowerCase() === repository &&
      (pr.state === "OPEN" || reopenedAt === null || !(Date.parse(pr.mergedAt) < reopenedAt)))) return null;
    cursor = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    if (pullRequests.pageInfo.hasNextPage && !cursor) throw new SyncFailure("Incomplete branch pull request lookup");
  } while (cursor);
  return { reopenedAt };
}

async function snapshotItems(graphql, projectId, fieldName) {
  const items = new Map();
  let cursor = null;
  do {
    const result = await graphql(`query StatusItemAudit($projectId: ID!, $fieldName: String!, $cursor: String) {
      node(id: $projectId) { ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          nodes { id
            fieldValueByName(name: $fieldName) { ... on ProjectV2ItemFieldSingleSelectValue { optionId name updatedAt } }
            content { ... on Issue { number repository { nameWithOwner isPrivate } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { projectId, fieldName, cursor });
    const page = result.node?.items;
    if (!page) throw new SyncFailure("Could not audit project Status values");
    for (const item of page.nodes) items.set(item.id, item);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && !cursor) throw new SyncFailure("Incomplete project Status audit");
  } while (cursor);
  return items;
}

function auditLog(core, label, options, items) {
  core.info(`${label} Status options: ${JSON.stringify(options.map(({ id, name }) => ({ id, name })))}`);
  const publicIssues = [...items.values()].filter((item) => item.content?.repository?.isPrivate === false &&
    item.content.repository.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  core.info(`${label} public ${owner}/${repo} issue statuses: ${JSON.stringify(publicIssues.map((item) => ({
    issue: item.content.number, optionId: item.fieldValueByName?.optionId ?? null,
    status: item.fieldValueByName?.name ?? null,
  })))}`);
}

async function syncProjectStatus({ github, context, core }) {
  try {
    const transition = eventTransition(context);
    const match = transition?.branch?.match(/^issue-(\d+)(?:-|$)/i);
    if (!match) { core.info("No eligible issue transition; leaving project unchanged."); return; }
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1) throw new SyncFailure("Invalid branch issue number");
    const graphql = github.graphql.bind(github);
    const lifecycle = await currentTransition(graphql, number, transition);
    if (!lifecycle) {
      core.info(`Issue #${number}: stale ${transition.status} event; leaving project unchanged.`);
      return;
    }

    const projects = [];
    let cursor = null;
    do {
      const result = await graphql(`query StatusProjects($owner: String!, $cursor: String) {
        user(login: $owner) { projectsV2(first: 100, after: $cursor) {
          nodes { id title } pageInfo { hasNextPage endCursor }
        } }
      }`, { owner, cursor });
      const page = result.user?.projectsV2;
      if (!page) throw new SyncFailure("Project owner was not found");
      projects.push(...page.nodes.filter((project) => project.title === projectTitle));
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !cursor) throw new SyncFailure("Incomplete project lookup");
    } while (cursor);
    if (projects.length !== 1) throw new SyncFailure("Expected exactly one matching BudgetApp project");
    const project = projects[0];

    const fieldsResult = await graphql(`query StatusFields($projectId: ID!) {
      node(id: $projectId) { ... on ProjectV2 { fields(first: 100) {
        nodes { ... on ProjectV2SingleSelectField { id name options { id name color description } } }
        pageInfo { hasNextPage }
      } } }
    }`, { projectId: project.id });
    const fields = fieldsResult.node?.fields;
    if (!fields || fields.pageInfo.hasNextPage) throw new SyncFailure("Incomplete project field lookup");
    const statuses = fields.nodes.filter((field) => field.name && normalize(field.name) === "status");
    if (statuses.length !== 1) throw new SyncFailure("Expected exactly one Status field");
    const field = statuses[0];
    const before = await snapshotItems(graphql, project.id, field.name);
    const linked = [...before.values()].filter((item) => item.content?.number === number &&
      item.content.repository?.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (linked.length !== 1) throw new SyncFailure("Linked issue must have exactly one project item");
    auditLog(core, "Before", field.options, before);
    const repair = reconcileOptions(field.options);
    const item = linked[0];
    const selectedOption = repair.options.find(({ id }) => id && id === item.fieldValueByName?.optionId);
    const currentRank = canonical.findIndex(({ name }) => name === selectedOption?.name);
    const targetRank = canonical.findIndex(({ name }) => name === transition.status);
    // A reopen starts a new lifecycle only when the recorded Done predates it.
    const restarting = selectedOption?.name === "Done" && lifecycle.reopenedAt !== null &&
      Date.parse(item.fieldValueByName?.updatedAt) < lifecycle.reopenedAt;
    if (currentRank > targetRank && !restarting) {
      core.info(`Issue #${number}: already ${selectedOption.name}; ignoring earlier ${transition.status} event.`);
      return;
    }
    let options = field.options;
    if (repair.changed) {
      const updated = await graphql(`mutation RepairStatusOptions($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
          projectV2Field { ... on ProjectV2SingleSelectField { options { id name color description } } }
        }
      }`, { fieldId: field.id, options: repair.options });
      options = updated.updateProjectV2Field?.projectV2Field?.options;
      if (!options) throw new SyncFailure("Status option repair returned no options");
      for (const preserved of repair.options.filter((option) => option.id)) {
        const actual = options.find((option) => option.id === preserved.id);
        if (!actual || actual.name !== preserved.name || actual.color !== preserved.color || actual.description !== preserved.description) {
          throw new SyncFailure("Status repair did not preserve existing option identities/metadata");
        }
      }
      const after = await snapshotItems(graphql, project.id, field.name);
      for (const [id, item] of before) {
        if (!after.has(id) || (after.get(id).fieldValueByName?.optionId ?? null) !== (item.fieldValueByName?.optionId ?? null)) {
          throw new SyncFailure("Status repair did not preserve existing item values");
        }
      }
      auditLog(core, "After repair", options, after);
      core.info("Verified existing Status option IDs and all existing item values survived repair.");
    }
    for (const status of canonical) if (options.filter((option) => option.name === status.name).length !== 1) throw new SyncFailure("Canonical Status repair is incomplete");
    const option = options.find((option) => option.name === transition.status);
    if (item.fieldValueByName?.optionId === option.id) {
      auditLog(core, "After", options, await snapshotItems(graphql, project.id, field.name));
      core.info(`Issue #${number}: already ${transition.status}; no status mutation needed.`); return;
    }
    await graphql(`mutation TransitionIssueStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
        projectV2Item { id }
      }
    }`, { projectId: project.id, itemId: item.id, fieldId: field.id, optionId: option.id });
    const final = await snapshotItems(graphql, project.id, field.name);
    if (final.get(item.id)?.fieldValueByName?.optionId !== option.id) throw new SyncFailure("Issue Status transition was not persisted");
    for (const [id, previous] of before) if (id !== item.id && (!final.has(id) || (final.get(id)?.fieldValueByName?.optionId ?? null) !== (previous.fieldValueByName?.optionId ?? null))) {
      throw new SyncFailure("Unrelated project item Status changed during transition");
    }
    auditLog(core, "After", options, final);
    core.info(`Issue #${number}: Status -> ${transition.status}; unrelated item values preserved.`);
  } catch (error) {
    // GraphQL errors can include tokens, private content or raw request variables.
    core.setFailed(error instanceof SyncFailure ? `Project Status synchronization failed: ${error.message}` :
      "Project Status synchronization failed safely. Check the bounded option/status audit; no raw API error is logged.");
  }
}

module.exports = { reconcileOptions, eventTransition, syncProjectStatus };
