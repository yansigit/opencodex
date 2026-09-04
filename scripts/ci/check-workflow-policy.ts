import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Workflow = {
  name?: string;
  on?: Record<string, Record<string, unknown> | null>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, {
    name?: string;
    if?: string;
    needs?: string | string[];
    steps?: Array<{
      id?: string;
      name?: string;
      if?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }>;
  }>;
};

export type RepositoryWorkflowPolicy = {
  version: number;
  repository: string;
  defaultBranch: string;
  integrationBranches: string[];
  candidateEvents: string[];
  trustedRunnerEvents: string[];
  ci: {
    workflow: string;
    name: string;
    aggregateJob: string;
    paths: string;
    mergeGroupTypes: string[];
  };
  release: {
    workflow: string;
    sourceWorkflow: string;
    sourceEvent: string;
    branch: string;
  };
};

export type WorkflowPolicyInput = {
  policy: RepositoryWorkflowPolicy;
  paths: Record<string, string[]>;
  ci: Workflow;
  release: Workflow;
};

const CANDIDATE_SCOPE =
  "(github.event_name != 'pull_request' && github.event_name != 'merge_group') || needs.changes.outputs.ci == 'true'";
const CONCURRENCY_SHA =
  "cross-platform-ci-${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || github.sha }}";
const MERGE_BASE = "${{ github.event.merge_group.base_sha }}";
const MERGE_HEAD = "${{ github.event.merge_group.head_sha }}";

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sameMembers(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) &&
    [...actual].sort().join("\0") === [...expected].sort().join("\0");
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

export function validateWorkflowPolicy(input: WorkflowPolicyInput): string[] {
  const { policy, paths, ci, release } = input;
  const errors: string[] = [];
  const fail = (message: string): void => { errors.push(message); };

  if (policy.version !== 1) fail("repository policy version must be 1");
  if (!/^[^/]+\/[^/]+$/.test(policy.repository)) {
    fail("repository policy must name exactly one owner/repository");
  }
  for (const [name, values] of [
    ["integrationBranches", policy.integrationBranches],
    ["candidateEvents", policy.candidateEvents],
    ["trustedRunnerEvents", policy.trustedRunnerEvents],
  ] as const) {
    const repeated = duplicates(values);
    if (repeated.length > 0) fail(`${name} contains duplicate values: ${repeated.join(", ")}`);
  }
  if (!sameMembers(policy.candidateEvents, ["pull_request", "merge_group"])) {
    fail("candidateEvents must be pull_request and merge_group");
  }
  if (!sameMembers(policy.trustedRunnerEvents, ["push", "workflow_dispatch"])) {
    fail("trustedRunnerEvents must be push and workflow_dispatch");
  }

  const requiredPathGroups = ["ci", "dependencies", "gui", "packaging", "macos", "swift"];
  for (const group of requiredPathGroups) {
    if (!Array.isArray(paths[group]) || paths[group]!.length === 0) {
      fail(`path policy group ${group} must be a non-empty string array`);
      continue;
    }
    const repeated = duplicates(paths[group]!);
    if (repeated.length > 0) fail(`path policy group ${group} contains duplicates: ${repeated.join(", ")}`);
  }
  for (const required of [".github/workflows/**", ".github/policies/**", "scripts/**", "tests/**"]) {
    if (!paths.ci?.includes(required)) fail(`ci path policy must include ${required}`);
  }
  for (const packagingPath of paths.packaging ?? []) {
    const covered = paths.ci?.includes(packagingPath) ||
      (packagingPath === "scripts/prepare-package.ts" && paths.ci?.includes("scripts/**"));
    if (!covered) fail(`packaging path ${packagingPath} is not covered by ci paths`);
  }

  if (ci.name !== policy.ci.name) fail(`CI workflow name must be ${policy.ci.name}`);
  if (!sameMembers(ci.on?.merge_group?.types, policy.ci.mergeGroupTypes)) {
    fail("CI merge_group trigger must use the policy's exact event types");
  }
  if (ci.on?.pull_request &&
      ("branches" in ci.on.pull_request || "paths" in ci.on.pull_request)) {
    fail("CI pull_request trigger must not filter branches or paths");
  }
  if (!sameMembers(ci.on?.push?.branches, policy.integrationBranches)) {
    fail("CI push branches must match repository integrationBranches");
  }
  if (ci.concurrency?.group !== CONCURRENCY_SHA || ci.concurrency?.["cancel-in-progress"] !== true) {
    fail("CI concurrency must cancel only duplicate runs for the immutable candidate SHA");
  }

  const filterSteps = Object.values(ci.jobs ?? {})
    .flatMap(job => job.steps ?? [])
    .filter(step => step.uses?.startsWith("dorny/paths-filter@"));
  const normalFilter = filterSteps.find(step => step.id === "filter");
  const mergeFilter = filterSteps.find(step => step.id === "merge-group-filter");
  if (filterSteps.length !== 2 ||
      normalFilter?.with?.filters !== policy.ci.paths ||
      mergeFilter?.with?.filters !== policy.ci.paths) {
    fail("both CI paths-filter steps must consume the shared path policy file");
  }
  if (normalFilter?.if !== "github.event_name != 'merge_group'" ||
      normalFilter?.with?.base !== "${{ github.ref }}" ||
      normalFilter?.with && "ref" in normalFilter.with) {
    fail("non-merge paths-filter must preserve pull_request and push semantics");
  }
  if (mergeFilter?.if !== "github.event_name == 'merge_group'" ||
      mergeFilter?.with?.base !== MERGE_BASE || mergeFilter?.with?.ref !== MERGE_HEAD) {
    fail("CI paths-filter must use explicit merge_group base/head SHAs with safe fallbacks");
  }

  const scopeStep = ci.jobs?.changes?.steps?.find(step => step.id === "scope");
  const scopeRun = scopeStep?.run ?? "";
  if (!scopeRun.includes("[ \"$EVENT_NAME\" = merge_group ] && prefix=MERGE_GROUP") ||
      !scopeRun.includes('value="${!name-}"') ||
      !scopeRun.includes("true|false)")) {
    fail("scope assertion must select the event-specific filter and fail closed on invalid output");
  }

  const runnerScript = ci.jobs?.["select-windows-runner"]?.steps
    ?.find(step => step.name === "Pick runner")?.run ?? "";
  if (!runnerScript.includes("set -euo pipefail") ||
      !runnerScript.includes("trusted=no") ||
      !runnerScript.includes("push|workflow_dispatch) trusted=yes") ||
      !runnerScript.includes('if [ "$trusted" = "yes" ] && [ "${USE_SELF_HOSTED:-}" = "1" ]; then') ||
      !runnerScript.includes("else") ||
      !runnerScript.includes("runner=\"windows-latest\"")) {
    fail("self-hosted Windows routing must trust only push and workflow_dispatch");
  }
  if ((runnerScript.match(/trusted=yes/g) ?? []).length !== 1 ||
      /merge_group\).*trusted=yes|pull_request\).*trusted=yes/.test(runnerScript)) {
    fail("candidate events must never select the self-hosted Windows runner");
  }

  for (const jobName of [
    "test", "storage-policy", "api-usage", "serial-load-sensitive", "gates",
    "platform-windows", "keyring-smoke",
  ]) {
    if (compact(ci.jobs?.[jobName]?.if) !== CANDIDATE_SCOPE) {
      fail(`${jobName} must apply the pull_request/merge_group CI path scope`);
    }
  }

  const aggregate = ci.jobs?.[policy.ci.aggregateJob];
  if (!aggregate || aggregate.name !== policy.ci.aggregateJob || aggregate.if !== "always()") {
    fail("CI aggregate job must exist with a stable name and if: always()");
  } else {
    const actualNeeds = Array.isArray(aggregate.needs) ? aggregate.needs : [aggregate.needs].filter(Boolean);
    const expectedNeeds = Object.keys(ci.jobs ?? {}).filter(name => name !== policy.ci.aggregateJob);
    if (!sameMembers(actualNeeds, expectedNeeds)) {
      fail("CI aggregate job must directly need every producer job");
    }
    const aggregateSteps = aggregate.steps ?? [];
    const aggregateRun = aggregateSteps.find(step => step.name === "Assert every needed job succeeded or was skipped")?.run ?? "";
    if (aggregateSteps.length !== 1 ||
        !aggregateRun.includes("set -euo pipefail") ||
        !aggregateRun.includes('.value.result != "success" and .value.result != "skipped"') ||
        !aggregateRun.includes('if [ -n "$bad" ]; then') ||
        !aggregateRun.includes('if [ "$WINDOWS_REQUIRED" = "true" ] && [ "$WINDOWS_RESULT" != "success" ]; then')) {
      fail("CI aggregate job must fail closed on every non-success/non-skipped producer and required Windows result");
    }
  }

  if (!sameMembers(release.on?.workflow_run?.workflows, [policy.release.sourceWorkflow]) ||
      !sameMembers(release.on?.workflow_run?.branches, [policy.release.branch])) {
    fail("auto-release workflow_run source must match repository policy");
  }
  const releaseIf = compact(release.jobs?.["auto-release"]?.if);
  for (const clause of [
    `github.event.workflow_run.event == '${policy.release.sourceEvent}'`,
    `github.event.workflow_run.head_branch == '${policy.release.branch}'`,
    "github.event.workflow_run.conclusion == 'success'",
  ]) {
    if (!releaseIf.includes(clause)) fail(`auto-release gate is missing: ${clause}`);
  }

  return errors.sort();
}

export function checkWorkflowPolicy(root = process.cwd()): string[] {
  const policyPath = resolve(root, ".github/policies/repository-policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as RepositoryWorkflowPolicy;
  const readYaml = (path: string): unknown =>
    Bun.YAML.parse(readFileSync(resolve(root, path), "utf8"));
  return validateWorkflowPolicy({
    policy,
    paths: readYaml(policy.ci.paths) as Record<string, string[]>,
    ci: readYaml(policy.ci.workflow) as Workflow,
    release: readYaml(policy.release.workflow) as Workflow,
  });
}

if (import.meta.main) {
  const errors = checkWorkflowPolicy();
  if (errors.length > 0) {
    for (const error of errors) console.error(`workflow-policy: ${error}`);
    process.exit(1);
  }
  console.log("workflow-policy: ok");
}
