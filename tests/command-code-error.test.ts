import { describe, expect, test } from "bun:test";
import { formatCommandCodeErrorBody } from "../src/adapters/command-code";

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
});
