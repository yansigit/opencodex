import { describe, expect, test } from "bun:test";
import { fetchWithTransientRetry, isTransientUpstreamStatus } from "../src/lib/upstream-retry";

function resetError(): Error {
  return Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
}

function bodyResponse(status: number, headers?: Record<string, string>): Response {
  // ReadableStream body so cancel() is observable.
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const res = new Response(status === 204 ? null : stream, { status, headers });
  return Object.assign(res, { __wasCancelled: () => cancelled });
}

describe("isTransientUpstreamStatus", () => {
  test("classifies gateway/Cloudflare transients, excludes 4xx and 507", () => {
    for (const s of [500, 502, 503, 504, 520, 521, 522]) expect(isTransientUpstreamStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 429, 499, 507, 529]) expect(isTransientUpstreamStatus(s)).toBe(false);
  });
});

describe("fetchWithTransientRetry", () => {
  test("does not replay a 502 by default", async () => {
    const first = bodyResponse(502) as Response & { __wasCancelled: () => boolean };
    const responses = [first, bodyResponse(200)];
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => responses[calls++]!, { slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
    expect(first.__wasCancelled()).toBe(false);
  });

  test("opt-in retries a 502 then returns the 200; failed body is cancelled", async () => {
    const first = bodyResponse(502) as Response & { __wasCancelled: () => boolean };
    const responses = [first, bodyResponse(200)];
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => responses[calls++]!, { attempts: 3, slowAttemptMs: 60_000 });
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(first.__wasCancelled()).toBe(true);
  });

  test("exhausts attempts on persistent 502 and returns the final 502 with body intact", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(502); }, { attempts: 3, slowAttemptMs: 60_000 });
    expect(calls).toBe(3);
    expect(res.status).toBe(502);
    expect(res.body).not.toBeNull();
  });

  test("shares one three-send budget across 5xx and reset recovery", async () => {
    const outcomes: Array<Response | Error> = [bodyResponse(502), resetError(), bodyResponse(200)];
    const recoveries: Array<string | undefined> = [];
    let calls = 0;
    const res = await fetchWithTransientRetry(async recovery => {
      recoveries.push(recovery);
      const outcome = outcomes[calls++]!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }, { attempts: 3, slowAttemptMs: 60_000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(recoveries).toEqual([undefined, "transient-5xx", "connection-reset"]);
  });

  test("never exceeds three sends for persistent mixed failures", async () => {
    const outcomes: Array<Response | Error> = [bodyResponse(502), resetError(), resetError(), bodyResponse(200)];
    let calls = 0;
    await expect(fetchWithTransientRetry(async () => {
      const outcome = outcomes[calls++]!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }, { attempts: 3, slowAttemptMs: 60_000 })).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("shares replay budget across separate sends (including a 429 replay)", async () => {
    const replayBudget = { remaining: 2 };
    // The 429 send itself does not consume the transient allowance; its same-target replay
    // must share the generation budget with the original send.
    const limited = await fetchWithTransientRetry(async () => bodyResponse(429), { attempts: 3, slowAttemptMs: 60_000, replayBudget });
    expect(limited.status).toBe(429);
    expect(replayBudget.remaining).toBe(2);
    let firstCalls = 0;
    const first = await fetchWithTransientRetry(async () => {
      firstCalls++;
      return bodyResponse(firstCalls === 1 ? 502 : 503);
    }, { attempts: 3, slowAttemptMs: 60_000, replayBudget });
    expect(first.status).toBe(503);
    expect(firstCalls).toBe(3);
    expect(replayBudget.remaining).toBe(0);

    let replayCalls = 0;
    const replay = await fetchWithTransientRetry(async () => {
      replayCalls++;
      return bodyResponse(replayCalls === 1 ? 502 : 200);
    }, { attempts: 3, slowAttemptMs: 60_000, replayBudget });
    expect(replay.status).toBe(502);
    expect(replayCalls).toBe(1);
  });

  test("does not retry non-transient statuses", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(400); }, { slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(400);
  });

  test("honors Retry-After header for the backoff delay", async () => {
    let calls = 0;
    const started = Date.now();
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      return calls === 1 ? bodyResponse(503, { "retry-after": "1" }) : bodyResponse(200);
    }, { attempts: 3, slowAttemptMs: 60_000 });
    expect(res.status).toBe(200);
    // Retry-After: 1s should dominate the 400ms base backoff.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test("returns the 5xx as-is when the caller aborted", async () => {
    const ac = new AbortController();
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      ac.abort();
      return bodyResponse(502);
    }, { abortSignal: ac.signal, attempts: 3, slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });

  test("does not retry a slow failed attempt (slow-502 incident shape)", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 30));
      return bodyResponse(502);
    }, { attempts: 3, slowAttemptMs: 10 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });
});
