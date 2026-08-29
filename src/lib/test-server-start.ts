/** Test-only listener seam, inert unless the repository test preload explicitly arms it. */
export function allowPlaintextRemoteForTests(): boolean {
  return process.env.OCX_TEST_HOME_GUARD === "1"
    && (globalThis as Record<PropertyKey, unknown>)[Symbol.for("opencodex.test.plaintext-remote")] === true;
}
