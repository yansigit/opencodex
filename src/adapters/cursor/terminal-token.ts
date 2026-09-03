/**
 * Cursor terminal-token hygiene state machine (SDD CUR-02).
 *
 * External models (e.g. Kimi K3, DeepSeek, Grok) hosted on Cursor occasionally
 * leak raw tokenizer end-of-sequence / end-of-turn special tokens into assistant text
 * at the turn boundary (e.g. "<eos>", "</s>", "<|im_end|>").
 *
 * This candidate-only state machine buffers trailing whitespace and candidate terminal
 * token prefixes at text-delta normalization time. It suppresses ONLY complete tokens
 * at the terminal boundary of the assistant turn. If ordinary text follows or the candidate
 * diverges, held text flushes unchanged. Tool call argument deltas are never passed
 * through this sanitizer.
 */

export const TERMINAL_TOKENS = [
  "<eos>",
  "</s>",
  "<|im_end|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
  "<|eot_id|>",
  "<|end_of_text|>",
] as const;

export class CursorTerminalTokenSanitizer {
  private held = "";

  /**
   * Feed a new text delta from the upstream stream.
   * Returns text that is confirmed safe to emit immediately.
   */
  feed(chunk: string): string {
    if (!chunk) return "";
    const combined = this.held + chunk;
    this.held = "";

    const safePrefixIndex = this.findSafePrefixIndex(combined);
    const emitText = combined.slice(0, safePrefixIndex);
    this.held = combined.slice(safePrefixIndex);
    return emitText;
  }

  /**
   * Called at turn termination (e.g. done, tool call, error, or stream end).
   * If the held buffer ends in a recognized terminal token (plus optional trailing whitespace),
   * the terminal token is suppressed. Any non-token text preceding it is returned.
   * If no complete terminal token is matched, all held text is flushed unchanged.
   */
  flush(stripTerminal = true): string {
    if (!this.held) return "";
    const text = this.held;
    this.held = "";

    let remaining = text;
    let stripped = false;
    while (stripTerminal) {
      const trimmed = remaining.replace(/[ \t\r\n]+$/, "");
      const token = TERMINAL_TOKENS.find(candidate => trimmed.endsWith(candidate));
      if (!token) break;
      remaining = trimmed.slice(0, -token.length);
      stripped = true;
    }
    return stripped ? remaining : text;
  }

  private findSafePrefixIndex(str: string): number {
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const suffix = str.slice(i);
      if (this.isCandidateSuffix(suffix)) {
        return i;
      }
    }
    return len;
  }

  private isCandidateSuffix(suffix: string): boolean {
    let rest = suffix.replace(/^[ \t\r\n]*/, "");
    if (rest.length === 0) {
      return suffix.length <= 64;
    }
    while (rest) {
      if (TERMINAL_TOKENS.some(token => token.startsWith(rest))) return true;
      const token = TERMINAL_TOKENS.find(candidate => rest.startsWith(candidate));
      if (!token) return false;
      rest = rest.slice(token.length).replace(/^[ \t\r\n]*/, "");
    }
    return true;
  }
}
