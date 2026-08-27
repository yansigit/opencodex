import { describe, expect, test } from "bun:test";
import {
  getDefaultConfig,
  resolveSubagentCandidates,
  validateConfigCandidate,
} from "../src/config";
import type { OcxConfig } from "../src/types";

describe("subagentCandidates configuration schema and resolution", () => {
  describe("schema validation and graceful degradation", () => {
    test("accepts a valid candidate string array", () => {
      const defaults = getDefaultConfig();
      const result = validateConfigCandidate({
        ...defaults,
        subagentCandidates: [
          "google-antigravity/gemini-3.7-flash",
          "cursor/composer-2.5",
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.subagentCandidates).toEqual([
          "google-antigravity/gemini-3.7-flash",
          "cursor/composer-2.5",
        ]);
      }
    });

    test("trims candidate strings in array", () => {
      const defaults = getDefaultConfig();
      const result = validateConfigCandidate({
        ...defaults,
        subagentCandidates: ["  cursor/composer-2.5  "],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.subagentCandidates).toEqual(["cursor/composer-2.5"]);
      }
    });

    test("accepts a valid candidate record of string arrays", () => {
      const defaults = getDefaultConfig();
      const result = validateConfigCandidate({
        ...defaults,
        subagentCandidates: {
          coder: ["google-antigravity/gemini-3.7-flash"],
          "gpt-5.6-luna": ["cursor/composer-2.5"],
          default: ["command-code/gpt-5.6-sol"],
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.subagentCandidates).toEqual({
          coder: ["google-antigravity/gemini-3.7-flash"],
          "gpt-5.6-luna": ["cursor/composer-2.5"],
          default: ["command-code/gpt-5.6-sol"],
        });
      }
    });

    test("degrades gracefully to undefined on empty array", () => {
      const defaults = getDefaultConfig();
      const result = validateConfigCandidate({
        ...defaults,
        subagentCandidates: [],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.subagentCandidates).toBeUndefined();
      }
    });

    test("degrades gracefully to undefined on array with empty or whitespace strings", () => {
      const defaults = getDefaultConfig();
      const result = validateConfigCandidate({
        ...defaults,
        subagentCandidates: ["   "],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.subagentCandidates).toBeUndefined();
      }
    });

    test("degrades gracefully to undefined on non-array / non-record types", () => {
      const defaults = getDefaultConfig();
      for (const invalid of [123, true, "some-model"]) {
        const result = validateConfigCandidate({
          ...defaults,
          subagentCandidates: invalid,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.config.subagentCandidates).toBeUndefined();
        }
      }
    });

    test("degrades gracefully to undefined on malformed record", () => {
      const defaults = getDefaultConfig();
      const invalidRecords = [
        { "": ["model-a"] }, // empty key
        { coder: [] }, // empty array value
        { coder: ["  "] }, // empty trimmed string
        { coder: [123] }, // non-string item
        { coder: "model-a" }, // non-array value
      ];
      for (const invalid of invalidRecords) {
        const result = validateConfigCandidate({
          ...defaults,
          subagentCandidates: invalid,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.config.subagentCandidates).toBeUndefined();
        }
      }
    });
  });

  describe("resolveSubagentCandidates helper", () => {
    test("returns empty array when subagentCandidates is undefined or config is missing", () => {
      expect(resolveSubagentCandidates({} as OcxConfig)).toEqual([]);
      expect(resolveSubagentCandidates({ subagentCandidates: undefined } as OcxConfig)).toEqual([]);
      expect(resolveSubagentCandidates(undefined as unknown as OcxConfig)).toEqual([]);
    });

    test("resolves array candidates regardless of role or model requested", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: [
          "google-antigravity/gemini-3.7-flash",
          "cursor/composer-2.5",
        ],
      };
      expect(resolveSubagentCandidates(config)).toEqual([
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ]);
      expect(resolveSubagentCandidates(config, "coder")).toEqual([
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ]);
      expect(resolveSubagentCandidates(config, "gpt-5.6-luna")).toEqual([
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ]);
    });

    test("trims and deduplicates array candidates preserving order", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: [
          "  google-antigravity/gemini-3.7-flash  ",
          "cursor/composer-2.5",
          "google-antigravity/gemini-3.7-flash",
          "   ",
        ],
      };
      expect(resolveSubagentCandidates(config)).toEqual([
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ]);
    });

    test("deduplicates routed slug variants in candidate array", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: [
          "openrouter/anthropic/claude-opus-5",
          "openrouter/anthropic-claude-opus-5",
          "cursor/composer-2.5",
        ],
      };
      expect(resolveSubagentCandidates(config)).toEqual([
        "openrouter/anthropic/claude-opus-5",
        "cursor/composer-2.5",
      ]);
    });

    test("resolves exact role match from record", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          coder: ["google-antigravity/gemini-3.7-flash"],
          debugger: ["google-antigravity/gemini-3.7-flash", "cursor/composer-2.5"],
          default: ["command-code/gpt-5.6-sol"],
        },
      };
      expect(resolveSubagentCandidates(config, "coder")).toEqual([
        "google-antigravity/gemini-3.7-flash",
      ]);
      expect(resolveSubagentCandidates(config, "debugger")).toEqual([
        "google-antigravity/gemini-3.7-flash",
        "cursor/composer-2.5",
      ]);
    });

    test("resolves exact model match from record", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          "gpt-5.6-luna": ["cursor/composer-2.5", "google-antigravity/gemini-3.7-flash"],
          default: ["command-code/gpt-5.6-sol"],
        },
      };
      expect(resolveSubagentCandidates(config, "gpt-5.6-luna")).toEqual([
        "cursor/composer-2.5",
        "google-antigravity/gemini-3.7-flash",
      ]);
    });

    test("resolves slug-equivalent model match from record", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          "openrouter/anthropic-claude-opus-5": ["cursor/composer-2.5"],
        },
      };
      expect(resolveSubagentCandidates(config, "openrouter/anthropic/claude-opus-5")).toEqual([
        "cursor/composer-2.5",
      ]);
    });

    test("falls back to 'default' or '*' in record when roleOrModel not found or omitted", () => {
      const configWithDefault: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          coder: ["google-antigravity/gemini-3.7-flash"],
          default: ["cursor/composer-2.5"],
        },
      };
      expect(resolveSubagentCandidates(configWithDefault, "unknown-role")).toEqual([
        "cursor/composer-2.5",
      ]);
      expect(resolveSubagentCandidates(configWithDefault)).toEqual([
        "cursor/composer-2.5",
      ]);
      expect(resolveSubagentCandidates(configWithDefault, "")).toEqual([
        "cursor/composer-2.5",
      ]);

      const configWithStar: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          coder: ["google-antigravity/gemini-3.7-flash"],
          "*": ["command-code/gpt-5.6-sol"],
        },
      };
      expect(resolveSubagentCandidates(configWithStar, "unknown-role")).toEqual([
        "command-code/gpt-5.6-sol",
      ]);
      expect(resolveSubagentCandidates(configWithStar)).toEqual([
        "command-code/gpt-5.6-sol",
      ]);
    });

    test("returns empty array when record has no match and no default/*", () => {
      const config: OcxConfig = {
        ...getDefaultConfig(),
        subagentCandidates: {
          coder: ["google-antigravity/gemini-3.7-flash"],
        },
      };
      expect(resolveSubagentCandidates(config, "explorer")).toEqual([]);
      expect(resolveSubagentCandidates(config)).toEqual([]);
    });
  });
});
