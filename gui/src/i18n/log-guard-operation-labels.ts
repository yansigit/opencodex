import type { Locale } from "./catalogs";

export type LogGuardOperationLabelKey =
  | "applying"
  | "error.generic"
  | "error.codex_running"
  | "error.process_enumeration_failed"
  | "error.busy"
  | "error.unsupported_schema"
  | "error.unsafe_path"
  | "error.database_error"
  | "error.auto_vacuum_not_incremental"
  | "error.integrity_check_failed";

const LABELS: Record<Locale, Record<LogGuardOperationLabelKey, string>> = {
  en: {
    applying: "Applying Log Guard change…",
    "error.generic": "Could not update Codex log storage.",
    "error.codex_running": "Quit Codex before changing Codex log storage.",
    "error.process_enumeration_failed": "Could not verify that Codex is stopped. The Log Guard operation was not started.",
    "error.busy": "The Codex logs database is busy. Quit Codex and try again.",
    "error.unsupported_schema": "This Codex logs schema is not supported for this operation.",
    "error.unsafe_path": "The Codex logs database path failed the safety check.",
    "error.database_error": "Could not update the Codex logs database.",
    "error.auto_vacuum_not_incremental": "This Codex logs database is not configured for incremental vacuum, so space cannot be reclaimed without a full rebuild.",
    "error.integrity_check_failed": "The Codex logs database failed its integrity check. No space was reclaimed.",
  },
  de: {
    applying: "Log-Guard-Änderung wird angewendet…",
  },
  fr: {
    applying: "Application de la modification Log Guard…",
  },
  ko: {
    applying: "Log Guard 변경 적용 중…",
  },
  zh: {
    applying: "正在应用 Log Guard 更改…",
  },
  "zh-TW": {
    applying: "正在套用 Log Guard 變更…",
  },
  ru: {
    applying: "Применение изменения Log Guard…",
  },
  ja: {
    applying: "Log Guard の変更を適用中…",
  },
  tr: {
    applying: "Log Guard değişikliği uygulanıyor…",
  },
};

export function logGuardOperationLabel(locale: Locale, key: LogGuardOperationLabelKey): string {
  return LABELS[locale][key];
}
