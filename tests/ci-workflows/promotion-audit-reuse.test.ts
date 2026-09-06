import { describe, expect, test } from "bun:test";

const {
  AUDIT_STEP,
  MAX_EVIDENCE_AGE_MS,
  auditEvidenceArtifactName,
  decidePromotionAuditReuse,
  githubJson,
} = require("../../.github/scripts/promotion-audit-reuse.cjs");

const BEFORE = "1".repeat(40);
const PROMOTED = "2".repeat(40);
const HEAD = "3".repeat(40);
const TREE = "4".repeat(40);
const REPOSITORY = "yansigit/opencodex";
const NOW = Date.parse("2026-09-04T10:00:00Z");

function fixture() {
  const pull = {
    number: 249,
    state: "closed",
    merged_at: "2026-09-04T09:34:24Z",
    merge_commit_sha: HEAD,
    base: { ref: "main", sha: BEFORE, repo: { full_name: REPOSITORY } },
    head: { ref: "dev", sha: PROMOTED, repo: { full_name: REPOSITORY } },
  };
  const run = {
    id: 42,
    event: "pull_request",
    head_sha: PROMOTED,
    status: "completed",
    // Merging can cancel an unrelated slow lane after this job succeeds. The
    // whole run is not treated as green; only this completed audit proof is.
    conclusion: "cancelled",
  };
  return {
    dependenciesChanged: true,
    eventName: "push",
    refName: "main",
    repository: REPOSITORY,
    beforeSha: BEFORE,
    headSha: HEAD,
    parents: [BEFORE, PROMOTED],
    headTree: TREE,
    promotedTree: TREE,
    proofChanged: false,
    pulls: [pull],
    runs: [run],
    jobsByRun: new Map([[42, [{
      name: "gates",
      conclusion: "success",
      steps: [
        { name: AUDIT_STEP, conclusion: "success", completed_at: "2026-09-04T09:13:29Z" },
      ],
    }]]]),
    artifactsByRun: new Map([[42, [{
      name: auditEvidenceArtifactName(pull, TREE),
      expired: false,
      created_at: "2026-09-04T09:13:30Z",
    }]]]),
    nowMs: NOW,
  };
}

describe("promotion dependency-audit reuse", () => {
  test("bounds an unavailable GitHub API request so the caller can fall back", async () => {
    const hangingFetch = (_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    await expect(githubJson("/never", "token", hangingFetch, 5)).rejects.toThrow(
      "GitHub API request timed out",
    );
  });

  test("keeps the GitHub API deadline armed while the response body is read", async () => {
    const headersOnlyFetch = (_url: string, options: { signal: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
      });
    await expect(githubJson("/stalled-body", "token", headersOnlyFetch, 5)).rejects.toThrow(
      "GitHub API request timed out",
    );
  });

  test("reuses only proof from an exact tree-preserving promotion", () => {
    const result = decidePromotionAuditReuse(fixture());
    expect(result.reuse).toBe(true);
    expect(result.reason).toMatch(/PR #249/);
  });

  test("does not reuse evidence outside a main push with dependency changes", () => {
    for (const patch of [
      { dependenciesChanged: false },
      { eventName: "pull_request" },
      { refName: "dev" },
    ]) {
      expect(decidePromotionAuditReuse({ ...fixture(), ...patch }).reuse).toBe(false);
    }
  });

  test("rejects direct, squash, octopus, reordered, and tree-changing main commits", () => {
    for (const patch of [
      { parents: [BEFORE] },
      { parents: [BEFORE, PROMOTED, "5".repeat(40)] },
      { parents: [PROMOTED, BEFORE] },
      { beforeSha: "6".repeat(40) },
      { promotedTree: "7".repeat(40) },
    ]) {
      expect(decidePromotionAuditReuse({ ...fixture(), ...patch }).reuse).toBe(false);
    }
  });

  test("requires exactly one matching merged same-repository dev-to-main PR", () => {
    const good = fixture();
    const variants = [
      [],
      [good.pulls[0], structuredClone(good.pulls[0])],
      [{ ...good.pulls[0], state: "open" }],
      [{ ...good.pulls[0], merge_commit_sha: "8".repeat(40) }],
      [{ ...good.pulls[0], base: { ...good.pulls[0].base, ref: "preview" } }],
      [{ ...good.pulls[0], head: { ...good.pulls[0].head, ref: "feature" } }],
      [{ ...good.pulls[0], head: { ...good.pulls[0].head, repo: { full_name: "fork/opencodex" } } }],
    ];
    for (const pulls of variants) {
      expect(decidePromotionAuditReuse({ ...fixture(), pulls }).reuse).toBe(false);
    }
  });

  test("rejects changed proof machinery before consulting prior evidence", () => {
    expect(decidePromotionAuditReuse({ ...fixture(), proofChanged: true }).reuse).toBe(false);
  });

  test("requires the exact PR/base/head/tree artifact after a successful audit", () => {
    const cases = [
      { runs: [] },
      { runs: [{ ...fixture().runs[0], event: "push" }] },
      { runs: [{ ...fixture().runs[0], head_sha: "9".repeat(40) }] },
      { runs: [{ ...fixture().runs[0], status: "in_progress" }] },
      { jobsByRun: new Map([[42, []]]) },
      { jobsByRun: new Map([[42, [{ name: "gates", conclusion: "failure", steps: [] }]]]) },
      { jobsByRun: new Map([[42, [{ name: "gates", conclusion: "success", steps: [{ name: AUDIT_STEP, conclusion: "skipped", completed_at: "2026-09-04T09:13:29Z" }] }]]]) },
      { artifactsByRun: new Map([[42, []]]) },
      { artifactsByRun: new Map([[42, [{ name: auditEvidenceArtifactName(fixture().pulls[0], "9".repeat(40)), expired: false, created_at: "2026-09-04T09:13:30Z" }]]]) },
      { artifactsByRun: new Map([[42, [{ name: auditEvidenceArtifactName(fixture().pulls[0], TREE), expired: true, created_at: "2026-09-04T09:13:30Z" }]]]) },
    ];
    for (const patch of cases) {
      expect(decidePromotionAuditReuse({ ...fixture(), ...patch }).reuse).toBe(false);
    }
  });

  test("rejects stale, future, and malformed audit timestamps", () => {
    for (const completed_at of [
      new Date(NOW - MAX_EVIDENCE_AGE_MS - 1).toISOString(),
      new Date(NOW + 1).toISOString(),
      "not-a-date",
    ]) {
      const input = fixture();
      input.jobsByRun.get(42)[0].steps[0].completed_at = completed_at;
      expect(decidePromotionAuditReuse(input).reuse).toBe(false);
    }
  });

  test("rejects stale, future, and malformed proof-artifact timestamps", () => {
    for (const created_at of [
      new Date(NOW - MAX_EVIDENCE_AGE_MS - 1).toISOString(),
      new Date(NOW + 1).toISOString(),
      "not-a-date",
    ]) {
      const input = fixture();
      input.artifactsByRun.get(42)[0].created_at = created_at;
      expect(decidePromotionAuditReuse(input).reuse).toBe(false);
    }
  });
});
