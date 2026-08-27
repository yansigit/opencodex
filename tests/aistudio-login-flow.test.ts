import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAiStudioNativeDaemonSourcePath } from "../src/oauth/aistudio-native-daemon";
import { parseMakerSuiteChunk } from "../src/adapters/google-aistudio-parser";

describe("Google AI Studio Native Automated Login & Parsing", () => {
  test("main.swift includes interactive login window mode and credential extraction", () => {
    const swiftPath = getAiStudioNativeDaemonSourcePath();
    expect(existsSync(swiftPath)).toBe(true);

    const code = readFileSync(swiftPath, "utf-8");
    // 1. --login CLI flag support
    expect(code).toContain("--login");
    // 2. Interactive window creation
    expect(code).toContain("NSWindow");
    // 3. Automated cookie harvesting
    expect(code).toContain("getAllCookies");
    // 4. Automated project/storage harvesting
    expect(code).toContain("selectedProject");
    expect(code).toContain("aistudio-session.json");
  });

  test("parseMakerSuiteChunk extracts model text and thinking signatures", () => {
    // Example chunk received directly from live Google AI Studio MakerSuiteService
    const sampleChunk = '[[[[[[[[null,"Hello! How can I help you today?"]],"model"]]],null,[11,9,63],null,null,null,null,"session_token"],[[[[[[null,"",null,null,null,null,null,null,null,null,null,null,null,null,"ErQCCrECARFNMg+fX56HpWmUpJsJkHqkXrBL697D+pRZTL"]]]]]]]';
    const parsed = parseMakerSuiteChunk(sampleChunk);
    expect(parsed.text).toBe("Hello! How can I help you today?");
    expect(parsed.thoughtSignature).toContain("ErQCCrECARFNMg");
  });

  test("parseMakerSuiteChunk extracts thoughts, decoded escapes, and handles empty input", () => {
    const sampleChunk = '[[[[[true,"Let me think about this step by step...\\nStep 1: Analyzed."]]],[[[null,"Line 1\\nLine 2 with \\\"quotes\\\" and \\u003ctags\\u003e"]]],[[[null,""]]]],null,null,null,null,null,null,"session_token",[[[["ErQ_test_signature_1234567890abcdefghijklmnopqrstuvwxyz"]]]]]';
    const parsed = parseMakerSuiteChunk(sampleChunk);

    expect(parsed.thought).toBe("Let me think about this step by step...\nStep 1: Analyzed.");
    expect(parsed.text).toBe('Line 1\nLine 2 with "quotes" and <tags>');
    expect(parsed.thoughtSignature).toBe("ErQ_test_signature_1234567890abcdefghijklmnopqrstuvwxyz");

    // Empty and non-string inputs
    expect(parseMakerSuiteChunk("")).toEqual({ text: "" });
    expect(parseMakerSuiteChunk(null as any)).toEqual({ text: "" });
    expect(parseMakerSuiteChunk(undefined as any)).toEqual({ text: "" });
    expect(parseMakerSuiteChunk("random garbage data without markers")).toEqual({ text: "" });
  });
});
