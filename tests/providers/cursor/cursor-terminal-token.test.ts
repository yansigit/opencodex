import { describe, expect, test } from "bun:test";
import { CursorTerminalTokenSanitizer, TERMINAL_TOKENS } from "../../../src/adapters/cursor/terminal-token";

function sanitize(chunks: string[], terminal = true): string {
  const sanitizer = new CursorTerminalTokenSanitizer();
  return chunks.map(chunk => sanitizer.feed(chunk)).join("") + sanitizer.flush(terminal);
}

describe("Cursor terminal-token sanitizer", () => {
  for (const token of TERMINAL_TOKENS) {
    test(`${token} is stripped across every chunk boundary`, () => {
      const input = `answer\n${token}\n`;
      for (let split = 0; split <= input.length; split++) {
        expect(sanitize([input.slice(0, split), input.slice(split)])).toBe("answer\n");
      }
    });
  }

  test("inline and code mentions are preserved when ordinary text follows", () => {
    expect(sanitize(["Use `<eos>` in tests."])).toBe("Use `<eos>` in tests.");
    expect(sanitize(["literal <eos>", " remains visible"])).toBe("literal <eos> remains visible");
  });

  test("incomplete candidates and non-terminal boundaries flush unchanged", () => {
    expect(sanitize(["answer<|eot_"], true)).toBe("answer<|eot_");
    expect(sanitize(["answer<eos>"], false)).toBe("answer<eos>");
  });

  test("a terminal sequence of recognized tokens is stripped as one suffix", () => {
    expect(sanitize(["answer\n<eos>\n</s>\n<|eot_id|>\n"])).toBe("answer\n");
  });
});
