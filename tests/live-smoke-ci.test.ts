import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeLiveSmokeBundle } from "../scripts/live-smoke-ci";

describe("live smoke CI credential bundle", () => {
  test("writes only the validated config and auth files into the requested ephemeral home", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocx-live-smoke-"));
    const secret = "provider-secret-that-must-not-be-logged";
    const bundle = Buffer.from(JSON.stringify({
      config: { defaultProvider: "openai", providers: { openai: { apiKey: secret } } },
      auth: { openai: { activeAccountId: "acct", accounts: [{ id: "acct", credential: { access: secret } }] } },
    }), "utf8").toString("base64");

    try {
      await materializeLiveSmokeBundle(bundle, home);
      expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({ defaultProvider: "openai" });
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toMatchObject({ openai: { activeAccountId: "acct" } });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects malformed or non-object bundles before writing anything", async () => {
    const home = await mkdtemp(join(tmpdir(), "ocx-live-smoke-"));
    try {
      await expect(materializeLiveSmokeBundle("not-base64-json", home)).rejects.toThrow("invalid live smoke credential bundle");
      await expect(readFile(join(home, "config.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
