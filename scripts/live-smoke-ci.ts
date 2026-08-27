import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LiveSmokeBundle {
  config: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

function parseBundle(encoded: string): LiveSmokeBundle {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (!value.config || typeof value.config !== "object" || Array.isArray(value.config)) throw new Error();
    if (value.auth !== undefined && (!value.auth || typeof value.auth !== "object" || Array.isArray(value.auth))) throw new Error();
    return value as LiveSmokeBundle;
  } catch {
    throw new Error("invalid live smoke credential bundle");
  }
}

export async function materializeLiveSmokeBundle(encoded: string, home: string): Promise<void> {
  const bundle = parseBundle(encoded);
  const target = resolve(home);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(`${target}/config.json`, `${JSON.stringify(bundle.config)}\n`, { mode: 0o600 });
  await chmod(`${target}/config.json`, 0o600);
  if (bundle.auth !== undefined) {
    await writeFile(`${target}/auth.json`, `${JSON.stringify(bundle.auth)}\n`, { mode: 0o600 });
    await chmod(`${target}/auth.json`, 0o600);
  }
  await chmod(target, 0o700);
}

if (import.meta.main) {
  const encoded = process.env.OCX_LIVE_SMOKE_BUNDLE_B64?.trim();
  const home = process.env.OPENCODEX_HOME?.trim();
  if (!encoded || !home) {
    console.error("live smoke credential bundle or OPENCODEX_HOME is not configured");
    process.exit(2);
  }
  await materializeLiveSmokeBundle(encoded, home).catch(() => {
    console.error("invalid live smoke credential bundle");
    process.exit(2);
  });
}
