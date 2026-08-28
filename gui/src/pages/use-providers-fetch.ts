import { useCallback, useRef } from "react";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { writeSessionListCache } from "../session-list-cache";
import type { OAuthStatus, ProvidersConfig } from "./providers-shared";

export function useProvidersFetch({
  apiBase,
  setConfig,
  setOauthProviders,
  setOauthStatus,
  invalidateProviderQuotas,
  setConfigLoadFailed,
  configCacheKey,
}: {
  apiBase: string;
  setConfig: React.Dispatch<React.SetStateAction<ProvidersConfig | null>>;
  setOauthProviders: React.Dispatch<React.SetStateAction<string[]>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  /** Bump the shell's quota revision; `force` adds `?refresh=1` to its next read. */
  invalidateProviderQuotas: (force?: boolean) => void;
  /** Mirrors config fetch health so the page can offer an inline retry without replacing cached data. */
  setConfigLoadFailed?: (failed: boolean) => void;
  /** Session seed key for instant Providers shell paint (no secrets — hasApiKey flags only). */
  configCacheKey?: string;
}) {
  const configRequestEpochRef = useRef(0);
  const fetchConfig = useCallback(async () => {
    const requestEpoch = ++configRequestEpochRef.current;
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await readJsonOrThrow<ProvidersConfig>(res);
      if (!data || typeof data !== "object" || !data.providers || typeof data.providers !== "object") {
        throw new Error("empty config response");
      }
      if (requestEpoch !== configRequestEpochRef.current) return;
      setConfig(data ?? null);
      if (configCacheKey && data) writeSessionListCache(configCacheKey, data);
      setConfigLoadFailed?.(false);
    } catch {
      if (requestEpoch !== configRequestEpochRef.current) return;
      setConfigLoadFailed?.(true);
    }
  }, [apiBase, configCacheKey, setConfig, setConfigLoadFailed]);

  const fetchOauth = useCallback(async () => {
    try {
      // Codex openai status is owned by useCodexAccountPool — do not duplicate /accounts.
      const provRes = await fetch(`${apiBase}/api/oauth/providers`);
      const provData = await readJsonOrThrow<{ providers?: string[] }>(provRes);
      const provs: string[] = provData?.providers ?? [];
      setOauthProviders(provs);
      const oauthEntries = await Promise.all(provs.map(async p => {
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${encodeURIComponent(p)}`).catch(() => null);
        const s = sRes ? (await readJsonIfOk<OAuthStatus>(sRes) ?? { loggedIn: false }) : { loggedIn: false };
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(oauthEntries));
    } catch { /* ignore */ }
  }, [apiBase, setOauthProviders, setOauthStatus]);

  /*
   * The workspace shell owns the single quota read; this only invalidates it. Keeping the
   * name means all twelve existing mutation call sites keep working unchanged, and a
   * mutation can no longer race the shell's own fetch for the same data.
   */
  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    invalidateProviderQuotas(refresh);
  }, [invalidateProviderQuotas]);

  return { fetchConfig, fetchOauth, fetchProviderQuotas };
}
