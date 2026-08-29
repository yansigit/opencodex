# Task 2 report — explicit provider mutation paths

## Status

Complete.

Converted audited intentional provider/default/provider-row writers to operation-scoped `mutatePersistedConfig`/`mutateManagementConfig` callbacks:

- Management provider mutations: provider create, OpenAI account mode, set-default, arbitrary provider PATCH, delete/default fallback/custom-model cleanup.
- Provider-specific model settings: provider `newModelPolicy`, provider alias, model aliases, provider default aliases, selected models, model preset/divergence writes.
- OAuth publication/reconcile and CLI key-login/AI Studio provider commits.
- Runtime API-key failover rotation.
- Startup provider migrations: Alibaba region, OpenAI tier, model rename.

Kept non-provider/global ordinary saves out of scope for Task 3.

## RED evidence

- `bun test tests/management-persistence-boundary.test.ts`
  - Result before implementation: 19 pass, 5 fail.
  - Failures: provider POST, provider set-default PATCH, provider PATCH, provider DELETE, selected-models PUT returned HTTP 500 instead of the expected successful scoped mutation.

- `bun test tests/key-login-live-update.test.ts`
  - Result before implementation: 0 pass, 2 fail.
  - Failures: key-login commit left disk on the old key (`sk-old` instead of `sk-rotated`), and the live-update test lost `modelCosts`.

- `bun test tests/model-rename-migration.test.ts`
  - Result before implementation: 9 pass, 1 fail.
  - Failure: startup persistence did not replay the Alibaba model rename onto the latest disk config; expected `qwen3.8-max`, found `qwen3.8-max-preview`.

- `bun test tests/config-save-boundary.test.ts`
  - Result when added: 4 pass, 0 fail.
  - The new replacement allowlist regression was already satisfied by Task 1 state.

- Focused compatibility failures found after the first green pass:
  - `bun test tests/oauth-public-surface.test.ts tests/oauth-provider-reconcile.test.ts tests/oauth-login-cli-live-update.test.ts`
    - Result before follow-up fixes: 25 pass, 6 fail.
    - Causes: legacy test fixtures still simulated provider/default writes through ordinary `saveConfig`; OAuth upsert also dropped provider-row selected-model state.
  - `bun test tests/codex-retained-root-serialization.test.ts -t "two processes at the post-approval management seam serialize instead of interleaving"`
    - Result before fixture/classification fix: failed with HTTP 500 `management persistence unavailable`.
  - `bun test tests/claude-management-api.test.ts -t "Claude Desktop apply installs the alias registry in the serving process"`
    - Result before fixture fix: failed because the test added a provider row through ordinary `saveConfig`, which now intentionally preserves the persisted provider registry.

## GREEN evidence

- `bun test tests/codex-retained-root-serialization.test.ts -t "two processes at the post-approval management seam serialize instead of interleaving"` repeated 5 times
  - Result: all 5 runs passed.

- `bun test tests/claude-management-api.test.ts -t "Claude Desktop apply installs the alias registry in the serving process"`
  - Result: 1 pass, 0 fail, 2 expect() calls.

- `bun test tests/management-persistence-boundary.test.ts tests/key-login-live-update.test.ts tests/model-rename-migration.test.ts tests/config-save-boundary.test.ts tests/oauth-public-surface.test.ts tests/oauth-provider-reconcile.test.ts tests/oauth-login-cli-live-update.test.ts tests/provider-api-keys.test.ts tests/openai-provider-option-startup.test.ts tests/alibaba-region-startup.test.ts`
  - Result: 115 pass, 0 fail, 548 expect() calls.

- `bun run typecheck`
  - Result: `$ bun x tsc --noEmit`, exit 0.

## Self-review notes

- Audited writer scan now shows `replacePersistedConfig` only in `src/cli/config-command.ts` and `src/cli/init.ts`.
- Remaining `saveManagementConfig`/`persistConfig` hits in the audited management files are non-provider/global Task 3 fields or provider-context-cap top-level settings outside the Task 2 provider-row/default authority class.
- Startup migrations now avoid adopting an uncommitted projection when the persisted mutation is unavailable.
- Key failover revalidates the target key against the fresh provider pool inside the persisted mutation callback before adopting the committed provider row.

## Concerns

- The full suite was started before the resume instruction and interrupted; per the resume instruction, it was not rerun. The two focused failures observed from that interrupted run were reproduced/fixed with focused tests.
