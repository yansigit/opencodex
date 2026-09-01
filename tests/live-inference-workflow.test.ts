import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "live-inference.yml"), "utf8");

describe("live inference workflow hardening", () => {
  test("runs only trusted dev code with minimal mutation permission", () => {
    expect(workflow).toContain("branches: [dev]");
    expect(workflow).toContain("github.ref == 'refs/heads/dev'");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toMatch(/changes:[\s\S]*?permissions:\n      contents: read/);
    expect(workflow).toMatch(/live:[\s\S]*?permissions:\n      contents: read\n      issues: write/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("pull_request_target:");
  });

  test("uses ephemeral homes and removes credentials before calling the supervisor", () => {
    expect(workflow).toContain("secrets[matrix.secret_name]");
    expect(workflow).toContain("mktemp -d");
    expect(workflow).toContain("OCX_LIVE_SMOKE_BUNDLE_B64");
    expect(workflow).toContain("rm -rf --");
    expect(workflow.indexOf("Stop proxy and remove credentials"))
      .toBeLessThan(workflow.indexOf("Reconcile Jules live-inference supervision"));
  });

  test("retries once, reports sanitized results, and deletes raw result files", () => {
    expect(workflow).toContain("if run_attempt 1; then");
    expect(workflow).toContain("run_attempt 2");
    expect(workflow).toContain("scripts/live-smoke-report.ts");
    expect(workflow).toContain('rm -f -- "$result_file"');
    expect(workflow).not.toContain("result.error");
  });

  test("deduplicates Jules incidents and closes them on recovery", () => {
    expect(workflow).toContain("opencodex-live-inference-failure:${provider}");
    expect(workflow).toContain('"agent:jules": ["8250df", "Trusted Jules implementation request"]');
    expect(workflow).toContain("const labels = Object.keys(labelDefinitions)");
    expect(workflow).toContain('state: "closed", state_reason: "completed"');
    expect(workflow).toContain("raw provider responses and credential material are intentionally unavailable");
  });

  test("does not carry stale matrix models that the smoke runner ignores", () => {
    expect(workflow).not.toContain('{ provider: "cursor", model:');
    expect(workflow).not.toContain('{ provider: "openai", model:');
  });
});
