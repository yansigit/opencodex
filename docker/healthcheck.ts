export async function containerHealthcheck(
  url = "https://127.0.0.1:10100/healthz",
): Promise<boolean> {
  const response = await fetch(url, {
    // This fixed loopback request is a liveness probe, not a remote identity check.
    // External clients must verify the configured certificate and server name.
    tls: { rejectUnauthorized: false },
  }).catch(() => null);
  return response?.ok === true;
}

if (import.meta.main && !await containerHealthcheck()) process.exit(1);
