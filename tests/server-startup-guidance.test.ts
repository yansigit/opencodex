import { expect, test } from "bun:test";
import { remoteDashboardStartupHint } from "../src/server";

test("loopback startup points remote dashboard users to the SSH tunnel guide", () => {
  expect(remoteDashboardStartupHint(undefined)).toContain("#ssh-port-forwarding");
  expect(remoteDashboardStartupHint("127.0.0.1")).toContain("https://opencodex.me/");
  expect(remoteDashboardStartupHint("0.0.0.0")).toBeNull();
});
