import { useCallback, useEffect, useState } from "react";
import {
  readPageFromHash,
  resolveAppHashChange,
  type Page,
} from "./app-routing";
import {
  DELIBERATE_NAVIGATION_EVENT,
  navigateHash,
  normalizeHashPath,
  replaceHash,
} from "./hash-routing";

/** localStorage keys written by the removed Classic/Workspace preference. */
const STALE_VIEW_KEYS = [
  "ocx-global-view",
  "ocx-view",
  "ocx-providers-view",
  "ocx-subagents-view",
  "ocx-storage-view",
  "ocx-codexauth-view",
  "ocx-apikeys-view",
  "ocx-claudecode-view",
  "ocx-usage-view",
  "ocx-logs-view",
  "ocx-models-view",
  "ocx-dashboard-view",
];

/**
 * One-shot cleanup of the layout-preference keys. There is a single layout now, so these
 * would otherwise sit in every user's storage forever.
 * TODO: delete this function (and its call) one release after 2.7.x.
 */
function clearStaleViewKeys(): void {
  try {
    for (const key of STALE_VIEW_KEYS) localStorage.removeItem(key);
  } catch {
    /* private mode / quota — nothing to clean up */
  }
}

function navigateToPage(id: Page, subPath?: string): void {
  const target = subPath ? `${id}/${subPath}` : id;
  navigateHash(target);
}

/**
 * Production App route ownership. Hash page changes push history; normalization of an
 * unknown sub-hash replaces the current entry so Back is never trapped on a URL the
 * router immediately rewrites.
 */
export function useAppRouteState() {
  const [route, setRoute] = useState(() => ({
    page: readPageFromHash(),
    transitionId: 0,
    animate: false,
  }));

  useEffect(() => { clearStaleViewKeys(); }, []);

  const applyHashAction = useCallback((rawHash: string, deliberate = false) => {
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    setRoute(current => action.page === current.page
      ? current
      : {
          page: action.page,
          transitionId: current.transitionId + Number(deliberate),
          animate: deliberate,
        });
  }, []);

  useEffect(() => {
    const onRouteHash = () => {
      applyHashAction(normalizeHashPath(window.location.hash));
    };
    const onDeliberateNavigation = (event: Event) => {
      applyHashAction((event as CustomEvent<string>).detail, true);
    };
    // hashchange covers location.hash assignment; popstate covers Back/Forward.
    window.addEventListener("hashchange", onRouteHash);
    window.addEventListener("popstate", onRouteHash);
    window.addEventListener(DELIBERATE_NAVIGATION_EVENT, onDeliberateNavigation);
    return () => {
      window.removeEventListener("hashchange", onRouteHash);
      window.removeEventListener("popstate", onRouteHash);
      window.removeEventListener(DELIBERATE_NAVIGATION_EVENT, onDeliberateNavigation);
    };
  }, [applyHashAction]);

  /*
   * Initial mount and page-driven normalization go through the SAME resolver.
   *
   * This effect used to re-implement two of the redirects by hand, which meant
   * every new legacy mapping had to be added in two places or the initial
   * mount would disagree with later hash changes: a first load on `#api` would
   * be normalized to the bare page here and lose the nested destination the
   * resolver was written to preserve.
   */
  useEffect(() => {
    const rawHash = normalizeHashPath(window.location.hash);
    const action = resolveAppHashChange(rawHash);
    if (action.replaceTo) replaceHash(action.replaceTo);
    /*
     * Initial state comes from `readPageFromHash`, so this normally agrees
     * already. The guard covers the one gap it cannot: a hash changed between
     * render and effect commit, before the `hashchange` listener below is
     * registered. Without it that change is observed by nobody and the page
     * renders against a hash it no longer matches.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect, react/react-compiler -- reconciles a hash changed before the listener existed; the equality check bounds it to one render
    if (action.page !== route.page) setRoute(current => ({ ...current, page: action.page, animate: false }));
  }, [route.page]);

  return {
    ...route,
    navigateToPage,
  };
}
