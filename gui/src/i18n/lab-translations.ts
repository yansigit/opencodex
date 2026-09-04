import type { TKey } from "./en";

export type LabLocale = "en" | "de" | "fr" | "ko" | "zh" | "zh-TW" | "ru" | "ja" | "tr";
export type LabCatalogKey = Exclude<Extract<TKey, `lab.${string}`>, `lab.production.${string}`>;
export type LabSupplementKey =
  | "subjectKindUnknown"
  | "artifact.present"
  | "artifact.corrupt"
  | "artifact.purged_unavailable"
  | "selectVerdict"
  | "community.title"
  | "community.notLocalVerdict"
  | "community.bundles"
  | "community.activeRecords"
  | "community.revokedRecords";

const en: Record<LabCatalogKey, string> = {
  "lab.title": "Compatibility Lab",
  "lab.subtitle": "Read-only compatibility verdict matrix from lab projection evidence.",
  "lab.loadFailed": "Could not load compatibility lab data",
  "lab.projectionUnavailable": "Lab projection is not available. Run conformance or live probes first.",
  "lab.projectionIncompatible": "Lab projection schema is incompatible. Rebuild the projection.",
  "lab.statusTitle": "Projection status",
  "lab.matrixTitle": "Compatibility matrix",
  "lab.verdictsTitle": "Verdict records",
  "lab.filter.layer": "Evidence layer",
  "lab.filter.verdict": "Verdict",
  "lab.filter.subject": "Subject ID",
  "lab.filter.all": "All",
  "lab.col.subject": "Subject",
  "lab.col.layer": "Layer",
  "lab.col.suite": "Suite",
  "lab.col.verdict": "Verdict",
  "lab.col.asOf": "As of",
  "lab.col.protocol": "Protocol conformance",
  "lab.col.live": "Live route compatibility",
  "lab.col.task": "Task effectiveness",
  "lab.empty": "No compatibility verdicts in the projection yet.",
  "lab.subjectKind": "Kind",
  "lab.observationCount": "Observations",
  "lab.eventCount": "Events",
  "lab.verdictCount": "Verdicts",
  "lab.subjectCount": "Subjects",
  "lab.builtAt": "Built",
  "lab.loading": "Loading compatibility evidence…",
  "lab.loadMore": "Load more",
  "lab.detailTitle": "Verdict detail",
  "lab.detailClose": "Close",
  "lab.detailSubject": "Subject",
  "lab.detailObservations": "Observations",
  "lab.detailEvents": "Evidence events",
  "lab.detailArtifacts": "Artifact metadata",
  "lab.detailLoadFailed": "Could not load verdict detail",
  "lab.refresh": "Refresh",
  "lab.verdict.UNKNOWN": "Unknown",
  "lab.verdict.CLAIMED": "Claimed",
  "lab.verdict.PROBED": "Probed",
  "lab.verdict.VERIFIED": "Verified",
  "lab.verdict.DEGRADED": "Degraded",
  "lab.verdict.BLOCKED": "Blocked",
  "lab.verdict.UNSUPPORTED": "Unsupported",
  "lab.layer.protocol_conformance": "Protocol conformance",
  "lab.layer.live_route_compatibility": "Live route compatibility",
  "lab.layer.task_effectiveness": "Task effectiveness",
};

const de: Record<LabCatalogKey, string> = {
};

const fr: Record<LabCatalogKey, string> = {
};

const ja: Record<LabCatalogKey, string> = {
};

const ko: Record<LabCatalogKey, string> = {
};

const ru: Record<LabCatalogKey, string> = {
};

const tr: Record<LabCatalogKey, string> = {
};

const zh: Record<LabCatalogKey, string> = {
};

const zhTW: Record<LabCatalogKey, string> = {
};

export const LAB_CATALOG_OVERRIDES: Record<LabLocale, Record<LabCatalogKey, string>> = {
  en,
  de,
  fr,
  ko,
  zh,
  "zh-TW": zhTW,
  ru,
  ja,
  tr,
};

const supplements: Record<LabLocale, Record<LabSupplementKey, string>> = {
  en: {
    subjectKindUnknown: "Unknown",
    "artifact.present": "Present",
    "artifact.corrupt": "Corrupt",
    "artifact.purged_unavailable": "Purged / unavailable",
    selectVerdict: "View verdict for {subject}",
    "community.title": "Community evidence",
    "community.notLocalVerdict": "Untrusted read-only context. Not included in this local verdict.",
    "community.bundles": "Bundles",
    "community.activeRecords": "Active records",
    "community.revokedRecords": "Revoked records",
  },
  de: {
    subjectKindUnknown: "Unbekannt",
    selectVerdict: "Urteil für {subject} anzeigen",
  },
  fr: {
    subjectKindUnknown: "Inconnu",
    selectVerdict: "Afficher le verdict pour {subject}",
  },
  ko: {
    subjectKindUnknown: "알 수 없음",
    selectVerdict: "{subject}의 판정 보기",
  },
  zh: {
    subjectKindUnknown: "未知",
    selectVerdict: "查看 {subject} 的判定",
  },
    subjectKindUnknown: "未知",
    selectVerdict: "查看 {subject} 的判定",
  },
  ru: {
    subjectKindUnknown: "Неизвестно",
    selectVerdict: "Открыть вердикт для {subject}",
  },
  ja: {
    subjectKindUnknown: "不明",
    selectVerdict: "{subject} の判定を表示",
  },
  tr: {
    subjectKindUnknown: "Bilinmiyor",
    selectVerdict: "{subject} için kararı görüntüle",
  },
};

export function labSupplement(
  locale: LabLocale,
  key: LabSupplementKey,
  vars?: Record<string, string | number>,
): string {
  let value = supplements[locale][key];
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}
