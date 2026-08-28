# Task 1 report: resilient Dashboard and Providers data states

## Implementation

- Changed the Dashboard overview loader to reject aborts, HTTP failures, malformed/empty payloads, and preserve the existing client-resource snapshot on failed polls.
- Dashboard now derives cold connectivity failure separately from stale-data reconnecting state. Cold failures keep the full cannot-connect surface and offer Retry; a failed poll after health has loaded keeps all content visible, shows a compact localized reconnecting notice with Retry, and clears on the next successful poll.
- Codex-autostart mutation failures now roll back only the setting and no longer set the overview connectivity error.
- Providers tracks config-read failure independently from its cached config. Cold and refresh failures render an inline localized error with repeated Retry actions while cached configuration remains visible.
- Add Provider surfaces provider-catalog request failure separately from an empty search, suppresses the false “No match” state, retains the Custom Provider fallback, and exposes Retry.
- Added the new reconnecting/catalog-failure copy to English and all eight translated catalogs.

## Files

- `gui/src/pages/dashboard-core-poll.ts`
- `gui/src/pages/use-dashboard-data.ts`
- `gui/src/pages/Dashboard.tsx`
- `gui/src/pages/use-providers-fetch.ts`
- `gui/src/pages/Providers.tsx`
- `gui/src/components/AddProviderModal.tsx`
- `gui/src/components/provider-catalog/ProviderCatalog.tsx`
- `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr}.ts`
- `gui/tests/dashboard-providers-resilience.test.tsx`

## Tests and results

TDD RED evidence, before production edits:

```text
bun test tests/dashboard-providers-resilience.test.tsx
0 pass, 3 fail
overview resource timed out with the old successful {health:null, providers:[], error:true} payload
Providers had no inline Retry control
Add Provider had no distinct preset failure state
```

TDD GREEN evidence:

```text
bun test tests/dashboard-providers-resilience.test.tsx
4 pass, 0 fail, 10 expect() calls
```

Focused regressions:

```text
bun test tests/dashboard-contracts.test.ts tests/providers-codex-completion-toast.test.tsx tests/add-provider-modal-backdrop.test.tsx
19 pass, 0 fail, 124 expect() calls
```

Required validation:

- `bun run lint:i18n` — passed.
- `bun run lint` — passed.
- `bun run build` — passed (`tsc -b && vite build`; Vite emitted only the existing large-chunk advisory).
- `bun test tests` — passed: 1,144 tests, 0 failures, 10,181 assertions. Output included only the repository’s known unrelated React `act(...)` warnings.
- `git diff --check` — passed.

## Self-review

- Failure handling is centralized at the overview/config resource boundaries; sibling callers retain their existing behavior.
- Failed or malformed overview/config reads never write session cache and never replace a last-known-good payload.
- Retry buttons call the existing resource/config fetch functions and can be clicked repeatedly.
- New UI copy is localized in every catalog; no hardcoded visible labels were added.
- No new dependencies, timers, or abstractions were introduced.

## Concerns

None. The Vite build retains its pre-existing chunk-size advisory, and the full suite retains only known unrelated `act(...)` warnings.
