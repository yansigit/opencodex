/** Legacy fixture seam, inert unless the repository test preload explicitly arms it. */
export function testProviderFetch(provider: object): typeof globalThis.fetch | undefined {
  if ((globalThis as Record<PropertyKey, unknown>)[Symbol.for("opencodex.test.provider-fetch")] !== true) return undefined;
  const candidate = (provider as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? candidate as typeof globalThis.fetch : undefined;
}
