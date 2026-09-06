import { describe, expect, test } from "bun:test";
import type { FetchImplementation, PrepareResult, PublishResult, SyncEvent } from "../../scripts/fork/sync/types";
import { createDraftPullRequestClient } from "../../scripts/fork/sync/pull-request";
import { preservationReportHash } from "../../scripts/fork/sync/overlap";

const event: SyncEvent = {
  kind: "pin-updated",
  upstreamRepo: "lidge-jun/opencodex",
  latestTag: "v2.32.0",
  latestTagSha: "1111111111111111111111111111111111111111",
  vendorMainSha: "2222222222222222222222222222222222222222",
  vendorDevSha: "3333333333333333333333333333333333333333",
  detectedAt: "2026-08-24T12:00:00.000Z",
  recommendedLane: "daily-merge",
  upstreamTag: "v2.32.0",
  upstreamSha: "1".repeat(40),
  baseRef: "refs/heads/dev",
  baseSha: "0".repeat(40),
  candidate: { upstreamRepo: "lidge-jun/opencodex", upstreamTag: "v2.32.0", upstreamSha: "1".repeat(40), baseRef: "refs/heads/dev", baseSha: "0".repeat(40) },
};

const result: PrepareResult = {
  status: "merged",
  branch: `sync/upstream-v2.32.0-${"1".repeat(12)}-${"0".repeat(12)}`,
  resolutions: [{
    path: "package.json",
    classification: "recipe",
    action: "merge package recipe",
  }],
  unresolved: [],
};

const published: PublishResult = {
  action: "created",
  branch: result.branch!,
  remoteSha: "4444444444444444444444444444444444444444",
  containsDev: true,
  containsVendorMain: true,
  handoffRequired: false,
  escalationRequired: false,
  preservationReport: {
    shas: { base: "0".repeat(40), fork: event.vendorDevSha, upstream: event.latestTagSha, merge: "4".repeat(40), dev: event.vendorDevSha, tag: event.latestTag },
    registryHash: "5".repeat(64),
    decisionHash: "6".repeat(64),
    candidates: [],
    decisions: {},
    status: "passed",
  },
  provenance: {
    headSha: "4".repeat(40),
    tagSha: event.latestTagSha,
    baseSha: "0".repeat(40),
    registryHash: "5".repeat(64),
    decisionHash: "6".repeat(64),
    reportHash: "7".repeat(64),
  },
};
published.provenance!.reportHash = preservationReportHash(published.preservationReport!);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fork sync draft pull requests", () => {
  test("creates a draft PR with the merge result", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? response([])
        : response({ number: 17 });
    };

    const number = await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(number).toBe(17);
    expect(requests.map(request => [request.input, request.init?.method ?? "GET"])).toEqual([
      ["https://api.github.com/repos/yansigit/opencodex/pulls?head=yansigit:sync/upstream-v2.32.0-111111111111-000000000000&state=open&base=dev", "GET"],
      ["https://api.github.com/repos/yansigit/opencodex/pulls", "POST"],
    ]);
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body).toMatchObject({
      title: "sync: upstream v2.32.0",
      head: "sync/upstream-v2.32.0-111111111111-000000000000",
      base: "dev",
      draft: true,
    });
    expect(body.body).toContain(event.latestTagSha);
    expect(body.body).toContain("package.json");
    expect(body.body).toContain("## Summary");
  });

  test("leaves an existing exact-head PR body and title untouched", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      return requests.length === 1
        ? response([{
          number: 23,
          title: "human-edited resolution ready for review",
          body: "Do not replace these investigation notes.",
          state: "open",
          draft: true,
          head: { ref: result.branch },
          base: { ref: "dev" },
        }])
        : response({ number: 23 });
    };

    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(requests).toHaveLength(1);
  });

  test("does not expose a merge endpoint", async () => {
    const requests: string[] = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return requests.length === 1 ? response([]) : response({ number: 1 });
    };

    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result });

    expect(requests.join("\n")).not.toContain("/merge");
  });

  test("does not create a PR for an unresolved prepare result", async () => {
    let requestCount = 0;
    const fetchImpl: FetchImplementation = async () => {
      requestCount++;
      return response([]);
    };

    await expect(createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({
      event,
      result: {
        status: "decision-handoff",
        branch: "sync/upstream-20260824",
        resolutions: [],
        unresolved: ["src/server/responses/core.ts"],
      },
    })).rejects.toThrow("merged or preservation-handoff prepare result");
    expect(requestCount).toBe(0);
  });

  test("rejects a branch that is not derived from the immutable candidate", async () => {
    let requestCount = 0;
    const fetchImpl: FetchImplementation = async () => {
      requestCount++;
      return response([]);
    };
    await expect(createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({
      event,
      result: { ...result, branch: "sync/upstream-v2.32.0-attacker" },
    })).rejects.toThrow("does not match immutable candidate identity");
    expect(requestCount).toBe(0);
  });

  test("rejects a candidate base outside refs/heads", async () => {
    const invalidEvent: SyncEvent = {
      ...event,
      baseRef: "refs/tags/dev",
      candidate: { ...event.candidate!, baseRef: "refs/tags/dev" },
    };
    await expect(createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl: async () => response([]),
    }).upsert({ event: invalidEvent, result })).rejects.toThrow("base ref is invalid");
  });

  test("does not mutate labels for an autonomous published head", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      const url = String(input);
      if (requests.length === 1) return response([]);
      if (url.endsWith("/pulls")) return response({ number: 31 });
      if (url.endsWith("/pulls/31")) return response({ number: 31, state: "open", changed_files: 1, head: { ref: result.branch, sha: published.remoteSha }, base: { ref: "dev" }, body: "" });
      if (url.endsWith("/opencodex")) return response({ default_branch: "dev" });
      if (url.includes("/files?")) return response([{ filename: "src/feature.ts" }]);
      if (url.includes("/labels")) return response([]);
      if (url.includes("/labels")) return response([]);
      return response({ names: ["autonomous-sync"] });
    };

    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({ event, result, publishResult: published });

    expect(requests).toHaveLength(2);
    expect(requests.some(request => request.input.includes("/labels"))).toBe(false);
    expect(requests.some(request => request.input.includes("/actions/workflows/pr-automation.yml/dispatches"))).toBe(false);
  });

  test("never labels a handoff or protected-surface resolution", async () => {
    const requests: string[] = [];
    const fetchImpl: FetchImplementation = async (input) => {
      requests.push(String(input));
      return requests.length === 1 ? response([]) : response({ number: 32 });
    };
    await createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret-token",
      fetchImpl,
    }).upsert({
      event,
      result: { ...result, resolutions: [{ path: ".github/workflows/release.yml", classification: "upstream-owned", action: "manual" }] },
      publishResult: { ...published, handoffRequired: true },
    });
    expect(requests).toHaveLength(2);
  });

  test("returns an existing PR without reconciling its body or labels", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: FetchImplementation = async (input, init) => {
      requests.push({ input: String(input), init });
      if (requests.length === 1) return response([{ number: 44, state: "open", draft: true, body: "Human-owned notes", head: { ref: result.branch, sha: published.remoteSha }, base: { ref: "dev" } }]);
      return response({});
    };
    const number = await createDraftPullRequestClient({ repository: "yansigit/opencodex", token: "secret", fetchImpl }).upsert({ event, result, publishResult: published });
    expect(number).toBe(44);
    expect(requests).toHaveLength(1);
    expect(requests.some(request => request.init?.method === "PATCH" || request.input.includes("/labels"))).toBe(false);
    expect(requests.some(request => request.input.includes("/actions/workflows/pr-automation.yml/dispatches"))).toBe(false);
  });

  test("fails closed when an existing PR branch points at a different published head", async () => {
    const fetchImpl: FetchImplementation = async () => response([{
      number: 45,
      state: "open",
      head: { ref: result.branch, sha: "5".repeat(40) },
      base: { ref: "dev" },
    }]);
    await expect(createDraftPullRequestClient({
      repository: "yansigit/opencodex",
      token: "secret",
      fetchImpl,
    }).upsert({ event, result, publishResult: published })).rejects.toThrow("head does not match");
  });

  test.each([
    ["clean sensitive merge", [{ filename: ".github/workflows/release.yml" }], 1],
    ["incomplete pagination", [{ filename: "src/feature.ts" }], 2],
  ])("does not label or dispatch when live files are %s", async (_name, files, changedFiles) => {
    const urls: string[] = [];
    const fetchImpl: FetchImplementation = async (input) => {
      const url = String(input); urls.push(url);
      if (urls.length === 1) return response([]);
      if (url.endsWith("/pulls")) return response({ number: 55 });
      if (url.endsWith("/pulls/55")) return response({ state: "open", changed_files: changedFiles, head: { ref: result.branch, sha: published.remoteSha }, base: { ref: "dev" }, body: "" });
      if (url.endsWith("/opencodex")) return response({ default_branch: "dev" });
      if (url.includes("/files?")) return response(files);
      return response({});
    };
    await createDraftPullRequestClient({ repository: "yansigit/opencodex", token: "secret", fetchImpl }).upsert({ event, result, publishResult: published });
    expect(urls.some(url => url.includes("/labels") || url.includes("/dispatches"))).toBe(false);
  });
});
