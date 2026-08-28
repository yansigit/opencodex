# Task 2 report: bounded Compatibility Matrix first paint

## Implementation

- Changed the initial matrix loader to fetch exactly one subject page with the existing `limit=50` query instead of collecting every subject page.
- Kept the existing verdict pagination and detail observation pagination/cursor validation unchanged; the legacy subject collector remains covered by its fail-closed and safety-cap tests.
- Replaced the custom subject `Select` with a labelled native search input and `datalist`.
- Added a shared suggestion helper that deduplicates the first subject page with subject IDs visible in the current verdict rows, caps output at 50, and uses an empty kind for unknown exact IDs.
- Kept exact typed/pasted IDs flowing through `verdictQueryFromFilters` as the existing `subjectId` query parameter.
- No new visible copy or dependencies were added.

## Exact TDD evidence

RED, immediately after adding the focused tests and before production edits:

```text
bun test tests/compatibility-lab.test.tsx
0 pass
1 fail
1 error
SyntaxError: Export named 'subjectSuggestions' not found in module '.../gui/src/pages/compatibility-matrix-shared.ts'
```

GREEN after the minimal implementation:

```text
bun test tests/compatibility-lab.test.tsx tests/compatibility-pagination-cap.test.ts
30 pass
0 fail
56 expect() calls
```

The focused tests cover one initial subject GET with `limit=50` and no cursor, native input/datalist rendering, 50-item deduplication/capping including verdict-visible IDs, exact `subjectId` query construction, malformed payload rejection, non-advancing subject cursors, and observation pagination.

## Validation

- `cd gui && bun test tests/compatibility-lab.test.tsx tests/compatibility-pagination-cap.test.ts` — passed: 30 tests, 0 failures, 56 assertions.
- `cd gui && bun run lint` — passed.
- `cd gui && bun run lint:i18n` — passed.
- `cd gui && bun test tests` — passed: 1,150 tests, 0 failures, 10,200 assertions. Existing unrelated React `act(...)` warnings remain.
- `cd gui && bun run build` — passed (`tsc -b && vite build`); Vite emitted the existing large-chunk advisory.
- `git diff --check` — passed.

## Files

- `gui/src/pages/CompatibilityMatrix.tsx`
- `gui/src/pages/compatibility-matrix-api.ts`
- `gui/src/pages/compatibility-matrix-shared.ts`
- `gui/tests/compatibility-lab.test.tsx`

## Self-review

- First paint has no path to `fetchAllSubjects`; it invokes only `fetchSubjectPage` once alongside the first verdict page.
- Verdict and observation pagination contracts were not weakened; strict parsers and cursor guards remain in place.
- Unknown pasted IDs are not rejected client-side and still reach the server filter; unknown suggestion entries display the existing localized unknown-kind supplement.
- Suggestions are deduplicated by exact subject ID and bounded before rendering.
- The change remains read-only and issues only existing GET requests.

## Concerns

None. The build’s large-chunk advisory and full-suite React `act(...)` warnings predate this change.
