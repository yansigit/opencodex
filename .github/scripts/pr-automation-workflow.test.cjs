"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const root = path.join(__dirname, "..");
const workflowPath = path.join(root, "workflows", "pr-automation.yml");

function workflow() {
  assert.equal(fs.existsSync(workflowPath), true, "pr-automation workflow is required");
  return fs.readFileSync(workflowPath, "utf8");
}

describe("PR automation workflow contract", () => {
  it("replaces the old sync babysitter and scans trusted dev PR events", () => {
    const source = workflow();
    const issueQuality = fs.readFileSync(path.join(root, "workflows", "issue-quality-tests.yml"), "utf8");
    assert.match(source, /^name: PR automation$/m);
    assert.match(source, /push:\s*\n\s+branches:\s*\[dev\]/);
    assert.match(source, /pull_request_target:/);
    assert.match(source, /check_run:/);
    assert.match(source, /schedule:\s*\n\s+- cron: "\*\/15 \* \* \* \*"/);
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /state:\s*["']open["'][^\n]*base:\s*["']dev["']/);
    assert.equal(fs.existsSync(path.join(root, "workflows", "sync-pr-babysitter.yml")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "sync-pr-babysitter.cjs")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "sync-pr-babysitter.test.cjs")), false);
    assert.doesNotMatch(issueQuality, /sync-pr-babysitter/);
    assert.match(issueQuality, /pr-automation\*\.test\.cjs/);
  });

  it("uses a repository-wide non-cancelling lock and least-privilege trusted checkout", () => {
    const source = workflow();
    assert.match(source, /permissions:\s*\{\}/);
    assert.match(source, /concurrency:[\s\S]*cancel-in-progress:\s*false/);
    assert.match(source, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2/);
    assert.match(source, /ref:\s*\$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev' && github\.sha \|\| github\.event\.repository\.default_branch \}\}/);
    assert.match(source, /persist-credentials:\s*false/);
    assert.doesNotMatch(source, /github\.event\.pull_request\.head/);
    assert.doesNotMatch(source, /git\s+(?:merge|push|checkout)/);
    assert.doesNotMatch(source, /--force(?:-with-lease)?/);
  });

  it("gates manual dispatch before secrets and App-token creation", () => {
    const source = workflow();
    assert.match(source, /if:\s*github\.repository[^\n]*&&[\s\S]*github\.event_name != ['"]workflow_dispatch['"][\s\S]*github\.ref == format\(/);
    assert.match(source, /refs\/heads\/\{0\}/);
    assert.ok(source.indexOf("if: github.repository") < source.indexOf("Create PR automation App token"));
  });

  it("accepts sync provenance only from the exact trusted label event", () => {
    const source = workflow();
    assert.match(source, /context\.payload\.sender\?\.type !== "Bot"/);
    assert.match(source, /context\.payload\.sender\?\.id\) !== syncProducerUserId/);
    assert.match(source, /context\.payload\.pull_request\?\.head\?\.sha === pr\.head\.sha/);
    assert.doesNotMatch(source, /workflow_dispatch:\s*\n\s+inputs:|inputs\.head_sha|inputs\.tag_sha|trustedDispatch/);
  });

  it("creates the App token only for mutating modes and keeps GITHUB_TOKEN for controller writes", () => {
    const source = workflow();
    assert.match(source, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/);
    assert.match(source, /client-id:\s*\$\{\{ vars\.PR_AUTOMATION_APP_ID \}\}/);
    assert.doesNotMatch(source, /app-id:/);
    assert.match(source, /PR_AUTOMATION_APP_ID/);
    assert.match(source, /PR_AUTOMATION_PRIVATE_KEY/);
    assert.match(source, /PR_AUTOMATION_MODE/);
    assert.match(source, /if:.*(?:update|merge)/s);
    assert.match(source, /github\.token/);
    assert.match(source, /steps\.app-token\.outputs\.token/);
    assert.match(source, /shadow|off/);
  });

  it("updates branches through the guarded GitHub API and handles stale-head races", () => {
    const source = workflow();
    assert.match(source, /update-branch/);
    assert.match(source, /expected_head_sha/);
    assert.match(source, /422/);
    assert.match(source, /head.*changed|changed.*head/i);
    assert.match(source, /retry|Retry/);
    assert.match(source, /compare|ancestor|contains.*base/i);
    assert.match(source, /automerge-approved/);
  });

  it("reconciles each PR independently and records outcomes", () => {
    const source = workflow();
    assert.match(source, /try\s*\{/);
    assert.match(source, /catch\s*\(error\)/);
    assert.match(source, /createComment|updateComment/);
    assert.match(source, /404/);
    assert.match(source, /GITHUB_STEP_SUMMARY/);
    assert.match(source, /pulls\.get|pulls\/\$\{.*number/);
  });

  it("recomputes raw exact-head evidence before merge and excludes promotions", () => {
    const source = workflow();
    assert.match(source, /botMergeEvidence/);
    assert.match(source, /approvalEvidence/);
    assert.match(source, /head\.sha|liveHeadSha/);
    assert.match(source, /mergePullRequest|PUT.*merge|pulls.*merge/);
    assert.match(source, /mergeMethod:\s*MERGE|method.*merge/i);
    assert.match(source, /promotion|base\.ref.*main|head\.ref.*dev/i);
    assert.match(source, /enforce-pr-target\.yml/);
    assert.match(source, /ci.*hygiene|hygiene.*ci/);
  });

  it("reports aged automation holds while retaining the label", () => {
    const source = workflow();
    assert.match(source, /summarizeAgedHolds/);
    assert.match(source, /Holds older than 24h/);
    assert.match(source, /labels retained/);
  });

  it("uses complete live evidence and immutable controller state", () => {
    const source = workflow();
    assert.match(source, /reviewThreads\(first:\s*100,\s*after:/);
    assert.match(source, /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
    assert.match(source, /typeof threads\.pageInfo\.hasNextPage !== "boolean"/);
    assert.match(source, /reviewThreads pagination cursor missing/);
    assert.match(source, /pulls\.listReviews/);
    assert.match(source, /issues\.listEvents/);
    assert.match(source, /checks\.listForRef/);
    assert.match(source, /pulls\.listFiles/);
    assert.match(source, /getBranch\(\{ owner, repo, branch: "dev" \}\)/);
    assert.match(source, /comment\.user\?\.login === "github-actions\[bot\]"/);
    assert.match(source, /Number\(comment\.user\?\.id\) === 41898282/);
    assert.match(source, /opencodex-pr-automation-approval/);
    assert.match(source, /approvalRecordFor\(pr, evidence\)/);
    assert.match(source, /status === 422/);
    assert.match(source, /expectedHeadMismatch[\s\S]*attempt === 0[\s\S]*raced\.head\.sha !== expected/);
    assert.match(source, /merged\.data\?\.merged/);
    assert.match(source, /owner: \$\{\{ github\.repository_owner \}\}/);
    assert.match(source, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
    assert.doesNotMatch(source, /github\.event\.pull_request\.(?:head|base)/);
    assert.match(source, /const fresh = await getPr\(pr\.number\)/);
    assert.match(source, /buildAutomationComment\(/);
  });

  it("fails closed on review state and consumes trusted maintenance state", () => {
    const source = workflow();
    assert.match(source, /parseAgentMaintenanceState/);
    assert.match(source, /freshMaintenanceMap = await loadMaintenanceMap\(\)/);
    assert.match(source, /pullRequestNumber/);
    assert.match(source, /duplicate|conflicting/i);
    assert.match(source, /agent-maintenance-state/);
    assert.match(source, /maintenanceStatus === "reviewing"/);
    assert.match(source, /QUEUED|PLANNING|IN_PROGRESS/);
    assert.match(source, /authorizedSessionId/);
    assert.match(source, /reviewEvidence/);
    assert.match(source, /isResolved !== true/);
    assert.match(source, /CHANGES_REQUESTED/);
    assert.match(source, /reviews\.ok/);
    assert.doesNotMatch(source, /pr-authored state|pull_request.*maintenance-state/i);
  });

  it("binds approval and sync provenance to the current trusted event", () => {
    const source = workflow();
    assert.match(source, /context\.eventName === "pull_request_target"/);
    assert.match(source, /context\.payload\.action === "labeled"/);
    assert.match(source, /payload\.pull_request\??\.head\??\.sha/);
    assert.match(source, /approvalRecordFor\(pr, evidence\)/);
    assert.match(source, /autonomous-sync/);
    assert.match(source, /syncActor\?\.id/);
    assert.match(source, /41898282/);
    assert.match(source, /type.*Bot/);
    assert.match(source, /handoff|escalat/);
    assert.match(source, /clearApproval/);
  });

  it("requires final raw evidence immediately before merge", () => {
    const source = workflow();
    assert.match(source, /const finalEvidence = await rawEvidence\(live\)/);
    assert.match(source, /const finalResult = controllerEvidence\(live, finalEvidence/);
    assert.match(source, /finalResult\.reviews\.ok/);
    assert.match(source, /finalResult\.merge\.ready|finalResult\.approval\.approved/);
    assert.match(source, /live\.head\.sha !== pr\.head\.sha/);
    assert.match(source, /live\.base\.sha !== finalBaseSha/);
  });

  it("binds autonomous sync authorization to immutable bot state and the live head", () => {
    const source = workflow();
    assert.match(source, /autonomous-sync/);
    assert.match(source, /syncProvenance|syncRecord/);
    assert.match(source, /actorId.*syncProducerUserId|syncProducerUserId.*actorId/);
    assert.match(source, /syncRecord.*headSha|headSha.*syncRecord/);
    assert.match(source, /context\.payload\.label\?\.name === "autonomous-sync"/);
    assert.match(source, /syncActor\?\.type === "Bot"/);
    assert.match(source, /clearSync|removeSync/);
    assert.match(source, /provenance: sync/);
    assert.match(source, /function controllerEvidence[\s\S]*?const syncProducerUserId = Number\(process\.env\.PR_AUTOMATION_APP_USER_ID\)/);
  });

  it("keeps the mergeability check in the fixed App-bound baseline", () => {
    const source = workflow();
    assert.match(source, /requiredChecks: \["ci", "hygiene", "enforce-target", "mergeable"\]/);
    assert.match(source, /expectedAppIds: \{ ci: 15368, hygiene: 15368, "enforce-target": 15368, mergeable: 15368 \}/);
    assert.match(source, /\["ci", "hygiene", "mergeable"\]/);
  });

  it("isolates malformed maintenance state and refreshes status after races", () => {
    const source = workflow();
    assert.match(source, /maintenanceStateErrors|maintenanceErrors/);
    assert.match(source, /pullRequestNumber/);
    assert.match(source, /candidate\.number/);
    assert.match(source, /freshEvidence = await rawEvidence/);
    assert.match(source, /freshResult = controllerEvidence/);
    assert.match(source, /updated\.head\.sha|raced\.head\.sha/);
    assert.match(source, /skip.*comment|comment.*skip/i);
  });

  it("accepts an update only after strict live post-update validation", () => {
    const source = workflow();
    assert.match(source, /updated\.state !== "open"/);
    assert.match(source, /updated\.draft/);
    assert.match(source, /updated\.base\.ref !== "dev"/);
    assert.match(source, /updated\.base\.sha !== intendedBaseSha/);
    assert.match(source, /updatedResult\.classification\.eligibleForUpdate/);
    assert.match(source, /verify\.data\.behind_by === 0/);
  });

  it("supervises upstream freshness and queues only trusted exact-head sync CI repairs", () => {
    const source = workflow();
    assert.match(source, /getLatestRelease/);
    assert.match(source, /fork-upstream-sync\.yml/);
    assert.match(source, /syncFreshnessDisposition/);
    assert.match(source, /syncFreshness\.action === "dispatch"/);
    assert.match(source, /syncCiRepairDisposition/);
    assert.match(source, /newestSyncPrNumber/);
    assert.match(source, /trustedProducerIds.*41898282/s);
    assert.match(source, /agent:jules/);
    assert.match(source, /agent:generated/);
    assert.match(source, /pr-automation-sync-supervisor\.cjs/);
    assert.doesNotMatch(source, /maintainer-sponsored/);
  });
});
