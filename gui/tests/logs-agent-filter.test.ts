import { expect, test } from "bun:test";
import { DEFAULT_LOG_FILTER_STATE, filterLogs } from "../src/pages/logs-filter";

const logs = [
  { model: "main", provider: "openai", status: 200, timestamp: 1, agentKind: "main" },
  { model: "child", provider: "openai", status: 200, timestamp: 2, agentKind: "subagent" },
  { model: "review", provider: "openai", status: 200, timestamp: 3, agentKind: "internal" },
  { model: "old", provider: "openai", status: 200, timestamp: 4 },
  { model: "bad", provider: "openai", status: 200, timestamp: 5, agentKind: "corrupt" },
];

test("agent filter selects main, subagent, internal, and only missing/invalid unknown rows", () => {
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, agentKind: "all" })).toHaveLength(5);
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, agentKind: "main" }).map(log => log.model)).toEqual(["main"]);
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, agentKind: "subagent" }).map(log => log.model)).toEqual(["child"]);
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, agentKind: "internal" }).map(log => log.model)).toEqual(["review"]);
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, agentKind: "unknown" }).map(log => log.model)).toEqual(["old", "bad"]);
});
