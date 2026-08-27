/**
 * Resilient streaming chunk parser for Google AI Studio MakerSuite private RPC protocol.
 */

export interface MakerSuiteParsedResult {
  text: string;
  thought?: string;
  thoughtSignature?: string;
}

export function parseMakerSuiteChunk(raw: string): MakerSuiteParsedResult {
  const result: MakerSuiteParsedResult = { text: "" };
  if (!raw || typeof raw !== "string") return result;

  // 1. Extract regular model response text: [null, "escaped_text"]
  const textMatches = raw.matchAll(/\[\s*null\s*,\s*"((?:[^"\\]|\\.)*)"/g);
  for (const m of textMatches) {
    if (!m[1]) continue;
    try {
      const decoded = JSON.parse('"' + m[1] + '"');
      if (decoded) result.text += decoded;
    } catch (err) {
      void err;
      result.text += m[1];
    }
  }

  // 2. Extract model reasoning / thoughts: [true, "escaped_thought"]
  const thoughtMatches = raw.matchAll(/\[\s*true\s*,\s*"((?:[^"\\]|\\.)*)"/g);
  for (const m of thoughtMatches) {
    if (!m[1]) continue;
    try {
      const decoded = JSON.parse('"' + m[1] + '"');
      if (decoded) result.thought = (result.thought ?? "") + decoded;
    } catch (err) {
      void err;
      result.thought = (result.thought ?? "") + m[1];
    }
  }

  // 3. Extract Gemini thought signature token if present
  const sigMatch = raw.match(/"(ErQ[A-Za-z0-9+/=_-]{30,})"/);
  if (sigMatch?.[1]) {
    result.thoughtSignature = sigMatch[1];
  }

  return result;
}

