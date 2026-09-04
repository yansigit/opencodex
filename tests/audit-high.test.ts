import { describe, expect, test } from "bun:test";

import {
  auditWithRetries,
  isTransientAuditFailure,
  type AuditAttempt,
} from "../scripts/ci/audit-high";

describe("dependency audit retry classification", () => {
  test("retries npm advisory service failures", () => {
    expect(
      isTransientAuditFailure(
        "error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503",
      ),
    ).toBe(true);
  });

  test("retries transport errors and explicit attempt timeouts", () => {
    expect(isTransientAuditFailure("error: ETIMEDOUT fetching advisories")).toBe(true);
    expect(isTransientAuditFailure("error: registry request - DNSResolveFailed")).toBe(true);
    expect(isTransientAuditFailure("error: getaddrinfo ENOTFOUND registry.npmjs.org")).toBe(true);
    expect(isTransientAuditFailure("", true)).toBe(true);
  });

  test("does not retry real vulnerability findings", () => {
    expect(
      isTransientAuditFailure(
        "lodash  <=4.17.20\nSeverity: high\nPrototype Pollution\n1 vulnerability",
      ),
    ).toBe(false);
  });

  test("does not trust transport words outside Bun error lines", () => {
    expect(
      isTransientAuditFailure(
        "package advisory description mentions a network timeout\n1 vulnerability",
      ),
    ).toBe(false);
  });

  test("retries a transient failure and then accepts a clean audit", async () => {
    const attempts: AuditAttempt[] = [
      { exitCode: 1, output: "error: advisory endpoint - 503\n", timedOut: false },
      { exitCode: 0, output: "No vulnerabilities found\n", timedOut: false },
    ];
    const warnings: string[] = [];

    await auditWithRetries({
      label: "root",
      cwd: "/workspace",
      run: async () => attempts.shift()!,
      sleep: async () => {},
      write: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(attempts).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test("fails a vulnerability result immediately without retrying", async () => {
    let attemptCount = 0;

    await expect(
      auditWithRetries({
        label: "root",
        cwd: "/workspace",
        run: async () => {
          attemptCount += 1;
          return {
            exitCode: 1,
            output: "Severity: high\n1 vulnerability\n",
            timedOut: false,
          };
        },
        sleep: async () => {},
        write: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow("root dependency audit exited with code 1");
    expect(attemptCount).toBe(1);
  });
});
