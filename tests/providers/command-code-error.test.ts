import { describe, expect, test } from "bun:test";
import { formatCommandCodeErrorBody } from "../../src/adapters/command-code";
import { classifyError } from "../../src/lib/errors";
import { beginRequestAttempt, finishRequestAttempt } from "../../src/server/request-log";

describe("Command Code error fidelity", () => {
  test("extracts the upstream nested error message", () => {
    expect(formatCommandCodeErrorBody(
      400,
      new Headers({ "content-type": "application/json" }),
      JSON.stringify({
        success: false,
        error: {
          code: "BAD_REQUEST",
          status: 400,
          message: "You have insufficient credits to make this request.",
        },
      }),
    )).toBe("You have insufficient credits to make this request.");
  });

  test("does not echo non-JSON upstream bodies", () => {
    expect(formatCommandCodeErrorBody(400, new Headers(), "<html>bad request</html>")).toBe("");
  });

  test("extracts the flat API error shape and redacts secrets", () => {
    const secret = ["sk", "command", "code", "secret", "value"].join("-");
    expect(formatCommandCodeErrorBody(
      400,
      new Headers({ "content-type": "application/json" }),
      JSON.stringify({ code: "BAD_REQUEST", status: 400, message: `insufficient credits for ${secret}` }),
    )).toBe("insufficient credits for [REDACTED]");
  });

  test("carries credit depletion through wire classification and attempt logging", () => {
    const formatted = formatCommandCodeErrorBody(
      400,
      new Headers({ "content-type": "application/json" }),
      JSON.stringify({
        success: false,
        error: {
          code: "BAD_REQUEST",
          status: 400,
          message: "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
        },
      }),
    );
    expect(classifyError(400, "upstream_error", formatted)).toMatchObject({
      type: "insufficient_quota",
      code: "insufficient_quota",
    });

    const attempt = beginRequestAttempt(1, "command-code", "deepseek/deepseek-v4-flash", "command-code");
    finishRequestAttempt(attempt, 400, 50, undefined, formatted);
    expect(attempt.errorCode).toBe("insufficient_quota");
  });
});
