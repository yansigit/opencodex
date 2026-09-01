import { spawnSync } from "node:child_process";

/**
 * Probe `/healthz` without depending on TypeScript from the plain-Node launcher.
 * Unknown states fail closed so package files are never replaced beneath a live proxy.
 */
export function probeProxyLiveness(port, hostname = "127.0.0.1", timeoutMs = 1500) {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return "dead";
  let host = typeof hostname === "string" && hostname.trim() !== "" ? hostname.trim() : "127.0.0.1";
  if (host === "0.0.0.0" || host === "*") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const script = [
    "const http = require('node:http');",
    "const [host, port, timeout] = process.argv.slice(1);",
    "const req = http.get({ host, port: Number(port), path: '/healthz', timeout: Number(timeout) }, res => {",
    "  let body = '';",
    "  res.setEncoding('utf8');",
    "  res.on('data', chunk => { body += chunk; });",
    "  res.on('end', () => {",
    "    try {",
    "      const parsed = JSON.parse(body);",
    "      const isOpencodex = parsed && typeof parsed === 'object'",
    "        && (parsed.service === 'opencodex'",
    "          || (parsed.service === undefined",
    "            && parsed.status === 'ok'",
    "            && typeof parsed.version === 'string'",
    "            && typeof parsed.uptime === 'number'));",
    "      if (res.statusCode !== 200) process.stdout.write('UNKNOWN');",
    "      else process.stdout.write(isOpencodex ? 'LIVE' : 'DEAD');",
    "    } catch { process.stdout.write('UNKNOWN'); }",
    "  });",
    "});",
    "req.on('timeout', () => { process.stdout.write('UNKNOWN'); req.destroy(); });",
    "req.on('error', err => process.stdout.write(err && err.code === 'ECONNREFUSED' ? 'DEAD' : 'UNKNOWN'));",
  ].join("\n");
  try {
    const probe = spawnSync(
      process.execPath,
      ["-e", script, host, String(port), String(timeoutMs)],
      { encoding: "utf8", timeout: timeoutMs + 1500, windowsHide: true },
    );
    const out = probe.stdout ?? "";
    if (out.includes("LIVE")) return "live";
    if (out.includes("DEAD")) return "dead";
    return "unknown";
  } catch {
    return "unknown";
  }
}
