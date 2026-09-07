/**
 * Delegation settings for the Subagents tab.
 *
 * This panel used to sit on the Dashboard, which is otherwise a read-only status page — the
 * one place you could change something was also the first thing a new user saw. It reads
 * better next to the roster it affects: the roster picks who may be called, while this panel
 * holds guidance preferences and the native omitted-model synchronization setting.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Select, Switch, Tooltip } from "../../ui";
import { IconArrowDown, IconArrowUp, IconInfo, IconX } from "../../icons";
import { useT, type TKey } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import type { DelegationPatch, DelegationModelOption, NativeDefaultState } from "../../pages/use-subagent-delegation";
import type { UltraModePatch, UltraModeState, V2NativeParentOverrideState, AgentTaskRecoveryState, V2RoutedDelegationBridgeState } from "../../pages/use-subagent-delegation";

export interface SubagentDelegationSectionProps {
  model: string;
  effort: string;
  efforts: string[];
  available: DelegationModelOption[];
  guidanceEnabled: boolean;
  syncCodexDefaults: boolean;
  nativeDefaultState?: NativeDefaultState;
  saving: boolean;
  onSave: (patch: DelegationPatch) => void;
  prompt: string;
  childInstructions: string;
  childInstructionsSaving: boolean;
  onChildInstructionsSave: (value: string | null) => void;
  ultraMode: UltraModeState;
  ultraSaving: boolean;
  onUltraModeSave: (patch: UltraModePatch) => void;
  ultraLoadFailed: boolean;
  onUltraModeRetry: () => void;
  keepNativeChatGptOnV1?: boolean;
  nativeParentOverride?: V2NativeParentOverrideState;
  nativeParentOverrideSaving?: boolean;
  onNativeParentOverrideSave?: (state: V2NativeParentOverrideState) => void;
  agentTaskRecovery?: AgentTaskRecoveryState;
  agentTaskRecoverySaving?: boolean;
  onAgentTaskRecoverySave?: (state: AgentTaskRecoveryState) => void;
  routedDelegationBridge?: V2RoutedDelegationBridgeState;
  routedDelegationBridgeSaving?: boolean;
  onRoutedDelegationBridgeSave?: (enabled: boolean) => void;
  fallback: string[];
  fallbackPollMs: number;
  fallbackBusy: boolean;
  availableModels: string[];
  onFallbackChange: (models: string[]) => void;
  onFallbackPollMsChange: (pollMs: number) => void;
  onFallbackSave: () => void;
}

export default function SubagentDelegationSection({
  model,
  effort,
  efforts,
  available,
  guidanceEnabled,
  syncCodexDefaults,
  nativeDefaultState = "disabled",
  saving,
  onSave,
  prompt,
  childInstructions,
  childInstructionsSaving,
  onChildInstructionsSave,
  ultraMode,
  ultraSaving,
  onUltraModeSave,
  ultraLoadFailed,
  onUltraModeRetry,
  keepNativeChatGptOnV1 = false,
  nativeParentOverride = { enabled: false, model: null, active: false },
  nativeParentOverrideSaving = false,
  onNativeParentOverrideSave = () => {},
  agentTaskRecovery = { enabled: false, model: null },
  agentTaskRecoverySaving = false,
  onAgentTaskRecoverySave = () => {},
  routedDelegationBridge = { enabled: false },
  routedDelegationBridgeSaving = false,
  onRoutedDelegationBridgeSave = () => {},
  fallback, fallbackPollMs, fallbackBusy, availableModels, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
}: SubagentDelegationSectionProps) {
  const t = useT();
  // A present empty/whitespace hint is an upstream override that suppresses the
  // Proactive message, so it must render as OFF (and the toggle can install the
  // preset). Only a nonblank hint is "on".
  const ultraOn = (ultraMode.hintText ?? "").trim().length > 0;
  const safeNativeDefaultState = nativeDefaultState === "active"
    || nativeDefaultState === "pending"
    || nativeDefaultState === "blocked"
    ? nativeDefaultState
    : "disabled";
  const nativeParentTargets = available.filter(option => option.canonical !== true);
  const nativeRecoveryTargets = available.filter(option => (
    option.provider === "openai" && option.namespaced === option.model
  ));
  const nativeParentCanActivate = ultraMode.multiAgentV2Enabled && !keepNativeChatGptOnV1 && nativeParentOverride.model !== null;
  const routedPreferred = available.some(option => option.namespaced === model
    && !(option.provider === "openai" && option.namespaced === option.model));
  const nativeMayUseV2 = ultraMode.enabled || (ultraMode.multiAgentMode !== "v1"
    && !(ultraMode.multiAgentMode === "v2" && ultraMode.keepNativeChatGptOnV1));
  const showV2Compatibility = !ultraLoadFailed && ultraMode.loaded === true && routedPreferred && nativeMayUseV2;
  const availableModelSet = new Set(availableModels);
  const fallbackSet = new Set(fallback);
  const [pollDraft, setPollDraft] = useState(() => ({ pollMs: fallbackPollMs, text: String(fallbackPollMs) }));
  // Keep blank/invalid input text while reconciling accepted settings from a load or save.
  if (!Object.is(pollDraft.pollMs, fallbackPollMs)) {
    setPollDraft({ pollMs: fallbackPollMs, text: Number.isFinite(fallbackPollMs) ? String(fallbackPollMs) : "" });
  }
  const fallbackControlsRef = useRef<HTMLDivElement>(null);
  const [identity, setIdentity] = useState(() => ({
    models: fallback,
    rows: fallback.map((rowModel, id) => ({ model: rowModel, id })),
    nextId: fallback.length,
  }));
  let rows = identity.rows;
  // Keys are render state. Guarded prop reconciliation retains each occurrence;
  // event handlers move the same identities with their corresponding models.
  if (identity.models !== fallback) {
    const remaining = [...identity.rows];
    let nextId = identity.nextId;
    rows = fallback.map(modelName => {
      const old = remaining.findIndex(row => row.model === modelName);
      return old >= 0 ? remaining.splice(old, 1)[0] : { model: modelName, id: nextId++ };
    });
    setIdentity({ models: fallback, rows, nextId });
  }
  const pendingFocus = useRef<{ row: number; action: string } | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const row = fallbackControlsRef.current?.querySelectorAll(".swi-fallback-row")[target.row];
    const enabledActions = row?.querySelectorAll<HTMLButtonElement>("button[data-action]:not(:disabled)");
    const action = Array.from(enabledActions ?? []).find(button => button.dataset.action === target.action)
      ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?? fallbackControlsRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]');
    action?.focus();
  }, [fallback]);
  const validPollMs = Number.isInteger(fallbackPollMs) && fallbackPollMs >= 5000 && fallbackPollMs <= 600000;
  const moveFallback = (index: number, direction: -1 | 1) => {
    const next = [...fallback];
    const target = index + direction;
    if (fallbackBusy || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    const nextRows = [...rows];
    [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
    setIdentity({ ...identity, models: next, rows: nextRows });
    pendingFocus.current = { row: target, action: direction === -1 ? "up" : "down" };
    onFallbackChange(next);
  };

  return (
    <div className="swi-delegation">
      {ultraLoadFailed && (
        <div className="swi-delegation-row">
          <div className="setting-copy">
            <div className="font-semibold">{t("sub.ultraMode")}</div>
            <div className="muted setting-hint">{t("sub.ultraModeLoadFail")}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onUltraModeRetry}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.routedDelegationBridge")}</div>
          <div className="muted setting-hint">{t("sub.routedDelegationBridgeHint")}</div>
        </div>
        <Switch
          on={routedDelegationBridge.enabled}
          onClick={() => onRoutedDelegationBridgeSave(!routedDelegationBridge.enabled)}
          disabled={routedDelegationBridgeSaving}
          label={t("sub.routedDelegationBridge")}
        />
        {!ultraMode.multiAgentV2Enabled && routedDelegationBridge.enabled && (
          <div className="muted setting-hint">{t("sub.routedDelegationBridgeInactive")}</div>
        )}
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.delegation.model")}</div>
          <div className="muted setting-hint">{t("sub.delegation.modelHint")}</div>
        </div>
        <div className="swi-delegation-controls">
          <Select
            value={model}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...available.map(m => ({ value: m.namespaced, label: formatNamespacedModelId(`${m.provider}/${m.model}`, t) })),
            ]}
            onChange={v => onSave({ model: v || null, effort: effort || null })}
            disabled={saving}
            label={t("dash.injectionLabel")}
            align="right"
          />
          {model && efforts.length > 0 && (
            <Select
              value={effort}
              options={[
                { value: "", label: t("dash.injectionEffortNone") },
                ...efforts.map(e => ({ value: e, label: e })),
              ]}
              onChange={v => onSave({ model: model || null, effort: v || null })}
              disabled={saving}
              label={t("dash.injectionEffortLabel")}
              align="right"
            />
          )}
        </div>
      </div>

      {showV2Compatibility && (
        <div className="swi-delegation-row swi-v2-compatibility" role="note">
          <div className="setting-copy">
            <div className="font-semibold">{t("sub.v2Compatibility.title")}</div>
            <p className="muted setting-hint">{t("sub.v2Compatibility.risk")}</p>
            <p className="muted setting-hint">{t("sub.v2Compatibility.recoveryUnknown")}</p>
            <a href="https://github.com/lidge-jun/opencodex/issues/92" target="_blank" rel="noreferrer">{t("sub.v2Compatibility.details")}</a>
          </div>
        </div>
      )}

      <div className="swi-delegation-row swi-fallback-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.fallbackLabel")}</div>
          <div className="muted setting-hint">{t("sub.fallbackHint")}</div>
        </div>
        <div className="swi-fallback-controls" ref={fallbackControlsRef}>
          {fallback.map((modelName, index) => (
            <div key={rows[index].id} className="swi-fallback-row">
              <span className="swi-fallback-model">{index + 1}. {modelName}
                {!availableModelSet.has(modelName) && <span className="muted setting-hint">{t("sub.fallbackUnavailable")}</span>}
              </span>
              <span className="swi-fallback-actions">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="up" onClick={() => moveFallback(index, -1)} disabled={fallbackBusy || index === 0} aria-label={t("sub.moveUp", { m: modelName })}><IconArrowUp /></button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="down" onClick={() => moveFallback(index, 1)} disabled={fallbackBusy || index === fallback.length - 1} aria-label={t("sub.moveDown", { m: modelName })}><IconArrowDown /></button>
                <button type="button" className="btn btn-ghost btn-icon btn-sm" data-action="remove" onClick={() => {
                  const next = fallback.filter((_, i) => i !== index);
                  setIdentity({ ...identity, models: next, rows: rows.filter((_, i) => i !== index) });
                  pendingFocus.current = { row: Math.max(0, Math.min(index, fallback.length - 2)), action: "remove" };
                  onFallbackChange(next);
                }} disabled={fallbackBusy} aria-label={t("sub.removeAria", { m: modelName })}><IconX /></button>
              </span>
            </div>
          ))}
          <Select value="" label={t("sub.fallbackAdd")} options={[
            { value: "", label: t("sub.fallbackAdd") },
            ...availableModels.filter(modelName => !fallbackSet.has(modelName)).map(modelName => ({ value: modelName, label: modelName })),
          ]} onChange={value => { if (value && !fallbackSet.has(value)) onFallbackChange([...fallback, value]); }} disabled={fallbackBusy} />
          <label className="setting-hint">{t("sub.fallbackPoll")}
            <input className="input" type="number" min={5000} max={600000} step={1000} value={pollDraft.text} onChange={e => {
              const text = e.currentTarget.value;
              const parsed = Number(text);
              const pollMs = text.trim() !== "" && Number.isFinite(parsed) ? parsed : Number.NaN;
              setPollDraft({ pollMs, text });
              onFallbackPollMsChange(pollMs);
            }} disabled={fallbackBusy} aria-invalid={!validPollMs} /> ms
          </label>
          {!validPollMs && <div className="setting-hint" role="alert">{t("sub.fallbackPollInvalid")}</div>}
          <button type="button" className="btn btn-primary btn-sm" onClick={onFallbackSave} disabled={fallbackBusy || !validPollMs}>{t("common.save")}</button>
        </div>
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("dash.syncCodexSubagentDefaults")}</div>
          <div className="muted setting-hint">{t("dash.syncCodexSubagentDefaultsHint")}</div>
          <div className="muted setting-hint">{t(`sub.nativeDefaultState.${safeNativeDefaultState}`)}</div>
        </div>
        <button
          type="button"
          className={`switch ${syncCodexDefaults ? "on" : ""}`}
          onClick={() => onSave({ syncCodexSubagentDefaults: !syncCodexDefaults })}
          disabled={saving || !model}
          aria-label={t("dash.syncCodexSubagentDefaults")}
          aria-pressed={syncCodexDefaults}
        >
          <span className="knob" />
        </button>
      </div>

      {/*
        Prompt-injection guidance, ultra mode and its editor are policy tuning, not daily
        decisions: one closed disclosure keeps them reachable under the two settings that are.
      */}
      <details className="swi-advanced">
        <summary className="muted text-label">{t("sub.advanced")}</summary>
      {/*
        The multi-agent surface switch (v1 / base / v2). It lived on Models and on the
        dashboard; both were editors for the same /api/v2 value. It is a delegation
        setting, so it sits above the model that gets delegated to. The long help text
        stays reachable from the focusable info button.
      */}
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {t("models.v2Label")}
            <Tooltip content={t("models.v2Help")} side="top" maxWidth={380}>
              <IconInfo width={13} height={13} aria-hidden="true" />
              <span className="sr-only">{t("models.v2Label")}</span>
            </Tooltip>
          </div>
          <div className="muted setting-hint">
            <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
        </div>
        <div className="swi-delegation-controls">
          <div className="segmented models-segmented" role="radiogroup" aria-label={t("models.v2Label")}>
            {(["v1", "default", "v2"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={ultraMode.multiAgentMode === mode}
                className={`btn btn-sm${ultraMode.multiAgentMode === mode ? " btn-primary" : " btn-ghost"}`}
                style={{ background: ultraMode.multiAgentMode === mode ? undefined : "transparent", color: ultraMode.multiAgentMode === mode ? undefined : "var(--muted)" }}
                disabled={ultraSaving || ultraLoadFailed}
                onClick={() => { if (ultraMode.multiAgentMode !== mode) onUltraModeSave({ multiAgentMode: mode }); }}
              >
                {t(`models.v2Mode_${mode}` as TKey)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("dash.multiAgentGuidance")}</div>
          <div className="muted setting-hint">{t("dash.multiAgentGuidanceHint")}</div>
        </div>
        <button
          type="button"
          className={`switch ${guidanceEnabled ? "on" : ""}`}
          onClick={() => onSave({ multiAgentGuidanceEnabled: !guidanceEnabled })}
          disabled={saving}
          aria-label={t("dash.multiAgentGuidance")}
          aria-pressed={guidanceEnabled}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.ultraMode")}</div>
          <div className="muted setting-hint">{t("sub.ultraModeHint")}</div>
        </div>
        <button
          type="button"
          className={`switch ${ultraOn ? "on" : ""}`}
          onClick={() => onUltraModeSave({ multiAgentModeHintText: ultraOn ? null : ULTRA_MODE_PRESET })}
          // Turning OFF (clear) is always safe, even when v2 is disabled — a stale
          // hint would otherwise silently re-activate on the next v2 enable.
          disabled={saving || ultraSaving || (!ultraOn && !ultraMode.multiAgentV2Enabled)}
          aria-label={t("sub.ultraMode")}
          aria-pressed={ultraOn}
        >
          <span className="knob" />
        </button>
        {!ultraMode.multiAgentV2Enabled && (
          <div className="muted setting-hint">{t("sub.ultraModeV2Required")}</div>
        )}
      </div>
      {ultraOn && (
        <div className="swi-delegation-row swi-ultra-mode-editor">
          <UltraModeEditor
            key={ultraMode.hintText}
            initialHint={ultraMode.hintText ?? ""}
            disabled={saving || ultraSaving}
            onSave={onUltraModeSave}
            preset={ULTRA_MODE_PRESET}
            labels={{
              text: t("sub.ultraModeText"),
              preset: t("sub.ultraModePreset"),
              save: t("common.save"),
            }}
          />
        </div>
      )}

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.nativeParentOverride")}</div>
          <div className="muted setting-hint">{t("sub.nativeParentOverrideHint")}</div>
          <div className="muted setting-hint">{t("sub.nativeParentOverridePrivacyWarning")}</div>
        </div>
        <div className="swi-delegation-controls">
          <Select
            value={nativeParentOverride.model ?? ""}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...nativeParentTargets.map(option => ({
                value: option.namespaced,
                label: formatNamespacedModelId(`${option.provider}/${option.model}`, t),
              })),
            ]}
            onChange={value => onNativeParentOverrideSave({
              enabled: value ? nativeParentOverride.enabled : false,
              model: value || null,
              active: nativeParentOverride.active,
            })}
            disabled={nativeParentOverrideSaving}
            label={t("sub.nativeParentOverrideModel")}
            align="right"
          />
          <Switch
            on={nativeParentOverride.enabled}
            onClick={() => onNativeParentOverrideSave({
              enabled: !nativeParentOverride.enabled,
              model: nativeParentOverride.model,
              active: nativeParentOverride.active,
            })}
            disabled={nativeParentOverrideSaving || (!nativeParentOverride.enabled && !nativeParentCanActivate)}
            label={t("sub.nativeParentOverride")}
          />
        </div>
        {!nativeParentCanActivate && !nativeParentOverride.active && (
          <div className="muted setting-hint">{t("sub.nativeParentOverrideV2Required")}</div>
        )}
      </div>

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.agentTaskRecovery")}</div>
          <div className="muted setting-hint">{t("sub.agentTaskRecoveryHint")}</div>
        </div>
        <div className="swi-delegation-controls">
          <Select
            value={agentTaskRecovery.model ?? ""}
            options={[
              { value: "", label: t("sub.agentTaskRecoveryDefault") },
              // Recovery unwraps ciphertext through the ChatGPT backend, so only
              // native catalog rows are valid targets. A saved value that no longer
              // resolves in the catalog still displays instead of being discarded.
              ...(agentTaskRecovery.model
                && !nativeRecoveryTargets.some(option => option.model === agentTaskRecovery.model)
                ? [{ value: agentTaskRecovery.model, label: agentTaskRecovery.model }]
                : []),
              ...nativeRecoveryTargets.map(option => ({
                value: option.model,
                label: formatNamespacedModelId(option.provider + "/" + option.model, t),
              })),
            ]}
            onChange={v => onAgentTaskRecoverySave({
              enabled: agentTaskRecovery.enabled,
              model: v || null,
            })}
            disabled={agentTaskRecoverySaving}
            label={t("sub.agentTaskRecoveryModel")}
            align="right"
          />
          <Switch
            on={agentTaskRecovery.enabled}
            onClick={() => onAgentTaskRecoverySave({
              enabled: !agentTaskRecovery.enabled,
              model: agentTaskRecovery.model,
            })}
            disabled={agentTaskRecoverySaving}
            label={t("sub.agentTaskRecovery")}
          />
        </div>
      </div>

      <div className="swi-delegation-row swi-prompt-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.injectionPrompt")}</div>
          <div className="muted setting-hint">
            {t("sub.injectionPromptHint")}{" "}
            <code>{"{{model}}"}</code>{" "}
            <code>{"{{effort}}"}</code>{" "}
            <code>{"{{roster}}"}</code>{" "}
            <code>{"{{fallback}}"}</code>{" "}
            <code>{"{{roles}}"}</code>
          </div>
        </div>
        <PromptDraftEditor
          key={`prompt:${prompt}`}
          initialValue={prompt}
          disabled={saving}
          ariaLabel={t("sub.injectionPrompt")}
          saveLabel={t("sub.injectionPromptSave")}
          onSave={value => onSave({ prompt: value.trim() ? value : null })}
        />
      </div>

      <div className="swi-delegation-row swi-prompt-editor">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.childInstructions")}</div>
          <div className="muted setting-hint">{t("sub.childInstructionsHint")}</div>
        </div>
        <PromptDraftEditor
          key={`child:${childInstructions}`}
          initialValue={childInstructions}
          disabled={saving || childInstructionsSaving}
          ariaLabel={t("sub.childInstructions")}
          saveLabel={t("sub.childInstructionsSave")}
          onSave={value => onChildInstructionsSave(value.trim() ? value : null)}
        />
      </div>
      </details>
    </div>
  );
}

/**
 * Local-draft editor for the Ultra mode hint. Drafts are owned here and committed
 * explicitly; the parent remounts this editor (via `key`) whenever the committed
 * server value changes, so a stale draft never survives a reload or toggle flip.
 */
function UltraModeEditor({
  initialHint,
  disabled,
  onSave,
  preset,
  labels,
}: {
  initialHint: string;
  disabled: boolean;
  onSave: (patch: UltraModePatch) => void;
  preset: string;
  labels: { text: string; preset: string; save: string };
}) {
  const [draft, setDraft] = useState(initialHint);
  const commit = () => {
    if (draft.trim().length === 0) return;
    onSave({ multiAgentModeHintText: draft });
  };
  return (
    <>
      <textarea
        className="input swi-ultra-mode-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        rows={4}
        aria-label={labels.text}
      />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setDraft(preset)}
        disabled={disabled}
      >
        {labels.preset}
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={commit}
        disabled={disabled || draft.trim().length === 0}
      >
        {labels.save}
      </button>
    </>
  );
}

/** Canonical Proactive delegation text mirrored from codex-rs (multi_agent_mode_instructions.rs). */
export const ULTRA_MODE_PRESET =
  "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently. Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself. This mode remains active until a later multi-agent mode developer message changes it.";

function PromptDraftEditor({
  initialValue,
  disabled,
  ariaLabel,
  saveLabel,
  onSave,
}: {
  initialValue: string;
  disabled: boolean;
  ariaLabel: string;
  saveLabel: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="swi-prompt-draft">
      <textarea
        className="input swi-ultra-mode-textarea"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        disabled={disabled}
        rows={4}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => onSave(draft)}
        disabled={disabled}
        aria-label={saveLabel}
      >
        {saveLabel}
      </button>
    </div>
  );
}
