import { createServer, type Server } from "node:http";
import { sanitizeDiagnostic } from "../artifacts/sanitize";
import {
  CURSOR_ORACLE_LOOPBACK_HOST,
  CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES,
  CURSOR_ORACLE_MAX_RAW_BYTES,
  CURSOR_ORACLE_UPSTREAM,
} from "./constants";
import { writeRawScratch } from "./isolate";
import { CursorOracleProtocolObserver, type CursorOracleProtocolObservation } from "./protocol-observer";

export interface LoopbackObservation {
  method: string;
  path: string;
  requestByteLength: number;
  requestSanitized: boolean;
  responseStatus: number | null;
  responseByteLength: number;
  responseSanitized: boolean;
  diagnostics: Array<{ code: string }>;
  endpointCounts: Record<string, number>;
  clientVersions: string[];
  protocol: CursorOracleProtocolObservation;
  rawPaths?: string[];
}

export interface LoopbackProxy {
  baseUrl: string;
  host: string;
  port: number;
  upstream: string;
  server: Server;
  getObservation(): LoopbackObservation;
  close(): Promise<void>;
}

function redactPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, "http://placeholder");
    return sanitizeDiagnostic(u.pathname);
  } catch {
    return sanitizeDiagnostic(rawUrl);
  }
}

function endpointCase(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1) ?? "other";
  return /^[A-Z][A-Za-z0-9]{0,63}$/.test(name) ? name : "other";
}

const OPAQUE_BOOTSTRAP_CASES = new Set([
  "GetMe",
  "GetUserPrivacyMode",
  "ListMarketplaces",
  "GetServerConfig",
  "GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "GetTeamReposOrEmptyIfNotInTeam",
  "GetGlobalCommands",
  "GetCliDownloadUrl",
  "GetManagedSkills",
  "GetEffectiveUserPlugins",
  "AvailableModels",
  "GetUsableModels",
  "GetDefaultModelForCli",
  "TrackEvents",
  "SubmitLogs",
]);

const SAFE_CURSOR_CLIENT_VERSION = /^cli-\d{4}\.\d{2}\.\d{2}-[a-z0-9]{7,40}$/;

function shouldRedactBody(body: Uint8Array): boolean {
  return body.length > 0;
}

/**
 * Loopback-only random endpoint that proxies to hard-coded api2.cursor.sh upstream.
 * Ephemeral auth header is forwarded but never captured (values replaced with [redacted]).
 * Sanitized observation V1: only header names, truncated sanitized path, byte lengths.
 */
export async function createLoopbackProxy(opts: {
  configDir?: string;
  keepRaw?: boolean;
  admissionToken?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<LoopbackProxy> {
  const upstream = CURSOR_ORACLE_UPSTREAM;
  const protocolObserver = new CursorOracleProtocolObserver();
  const clientVersions = new Set<string>();
  let responseSequence = 0;
  let observation: LoopbackObservation = {
    method: "",
    path: "",
    requestByteLength: 0,
    requestSanitized: false,
    responseStatus: null,
    responseByteLength: 0,
    responseSanitized: false,
    diagnostics: [],
    endpointCounts: Object.create(null) as Record<string, number>,
    clientVersions: [],
    protocol: protocolObserver.snapshot(),
    rawPaths: opts.keepRaw ? [] : undefined,
  };

  const server = createServer(async (req, res) => {
    const rawUrl = req.url ?? "/";
    const requestPath = redactPath(rawUrl);
    const endpoint = endpointCase(requestPath);
    const responseStreamKey = `${endpoint}:${++responseSequence}`;
    const opaquePassThrough = rawUrl.startsWith("/auth/") || OPAQUE_BOOTSTRAP_CASES.has(endpoint);
    // cursor-agent applies --header to agent protocol RPCs, not auth/bootstrap.
    // Keep identity traffic opaque and require the per-run secret everywhere observed.
    if (!opaquePassThrough && opts.admissionToken && req.headers["x-ocx-oracle-token"] !== opts.admissionToken) {
      observation.diagnostics.push({ code: `admission_rejected_${endpointCase(redactPath(req.url ?? "/")).toLowerCase()}` });
      res.writeHead(403).end();
      return;
    }
    const method = req.method ?? "POST";
    const sanitizedPath = requestPath;
    if (!opaquePassThrough) {
      observation.method = method;
      observation.path = sanitizedPath;
      observation.endpointCounts[endpoint] = (observation.endpointCounts[endpoint] ?? 0) + 1;
      const clientVersion = Array.isArray(req.headers["x-cursor-client-version"])
        ? req.headers["x-cursor-client-version"][0]
        : req.headers["x-cursor-client-version"];
      if (clientVersion && SAFE_CURSOR_CLIENT_VERSION.test(clientVersion)) clientVersions.add(clientVersion);
      observation.diagnostics.push({ code: "request_received" });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES) {
        if (!opaquePassThrough) observation.diagnostics.push({ code: "request_body_too_large" });
        req.resume();
        res.writeHead(413).end();
        if (!opaquePassThrough) {
          observation.requestByteLength = total;
          observation.requestSanitized = true;
        }
        break;
      }
      chunks.push(buf);
    }
    if (total > CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES) return;
    const reqBody = Buffer.concat(chunks);
    if (!opaquePassThrough) {
      observation.requestByteLength = reqBody.length;
      observation.requestSanitized = shouldRedactBody(reqBody);
      const contentEncoding = Array.isArray(req.headers["content-encoding"])
        ? req.headers["content-encoding"].join(",")
        : req.headers["content-encoding"];
      protocolObserver.observeRequest(endpoint, reqBody, contentEncoding);
    }

    if (opts.keepRaw && !opaquePassThrough && reqBody.length > 0 && reqBody.length <= CURSOR_ORACLE_MAX_RAW_BYTES) {
      try {
        const p = writeRawScratch({ configDir: opts.configDir, prefix: "oracle-req", bytes: reqBody, suffix: ".bin" });
        observation.rawPaths?.push(p);
      } catch (e) {
        observation.diagnostics.push({ code: "raw_request_write_failed" });
      }
    }

    const upstreamUrl = new URL(rawUrl, upstream);
    if (upstreamUrl.origin !== new URL(upstream).origin) {
      observation.diagnostics.push({ code: "upstream_origin_rejected" });
      res.writeHead(403).end();
      return;
    }
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      const lower = k.toLowerCase();
      const value = Array.isArray(v) ? v.join(", ") : v;
      if (lower === "host" || lower === "connection" || lower === "content-length" || lower === "transfer-encoding") continue;
      if (lower === "x-ocx-oracle-token") continue;
      forwardHeaders[k] = value;
    }
    forwardHeaders["accept-encoding"] = "identity";

    let upstreamRes: Response | null = null;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const timeout = setTimeout(() => ctrl.abort(), 30_000);
      try {
        upstreamRes = await (opts.fetchImpl ?? fetch)(upstreamUrl, {
          method,
          headers: forwardHeaders,
          body: reqBody.length > 0 ? reqBody : undefined,
          signal: ctrl.signal,
          redirect: "error",
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      if (!opaquePassThrough) observation.diagnostics.push({ code: "upstream_unavailable" });
      if (!res.writableEnded) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "oracle_upstream_unavailable", upstream }));
      }
      if (!opaquePassThrough) {
        observation.responseStatus = 502;
        observation.responseByteLength = 0;
        observation.responseSanitized = true;
      }
      req.off("aborted", abort);
      res.off("close", abort);
      return;
    }

    if (!opaquePassThrough) {
      observation.responseStatus = upstreamRes.status;
    }
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of upstreamRes.headers.entries()) {
      const lower = k.toLowerCase();
      if (lower === "connection" || lower === "transfer-encoding" || lower === "content-length") continue;
      respHeaders[k] = v;
    }
    try {
      res.writeHead(upstreamRes.status, respHeaders);
      const rawChunks: Buffer[] = [];
      let responseBytes = 0;
      let captureRaw = Boolean(opts.keepRaw && !opaquePassThrough);
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          const buf = Buffer.from(chunk);
          responseBytes += buf.length;
          if (captureRaw && responseBytes <= CURSOR_ORACLE_MAX_RAW_BYTES) rawChunks.push(buf);
          else if (captureRaw) {
            captureRaw = false;
            rawChunks.length = 0;
            if (!opaquePassThrough) observation.diagnostics.push({ code: "raw_response_omitted_too_large" });
          }
          if (!res.write(buf)) await new Promise<void>((resolve) => res.once("drain", resolve));
          if (!opaquePassThrough) protocolObserver.observeResponseChunk(endpoint, buf, responseStreamKey);
        }
      }
      res.end();
      if (!opaquePassThrough) {
        observation.responseByteLength = responseBytes;
        observation.responseSanitized = responseBytes > 0;
      }
      if (captureRaw && responseBytes > 0) {
        try {
          const p2 = writeRawScratch({ configDir: opts.configDir, prefix: "oracle-res", bytes: Buffer.concat(rawChunks), suffix: ".bin" });
          observation.rawPaths?.push(p2);
        } catch {
          observation.diagnostics.push({ code: "raw_response_write_failed" });
        }
      }
    } catch (e) {
      if (!opaquePassThrough) observation.diagnostics.push({ code: "response_write_failed" });
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, CURSOR_ORACLE_LOOPBACK_HOST, () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("loopback bind failed");
  if (addr.address !== CURSOR_ORACLE_LOOPBACK_HOST) {
    server.close();
    throw new Error("loopback bound to non-loopback address");
  }
  const port = addr.port;
  const baseUrl = `http://${CURSOR_ORACLE_LOOPBACK_HOST}:${port}`;

  return {
    baseUrl,
    host: CURSOR_ORACLE_LOOPBACK_HOST,
    port,
    upstream,
    server,
    getObservation: () => ({
      ...observation,
      endpointCounts: { ...observation.endpointCounts },
      clientVersions: [...clientVersions].sort(),
      protocol: protocolObserver.snapshot(),
      rawPaths: observation.rawPaths ? [...observation.rawPaths] : undefined,
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
