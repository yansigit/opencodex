import type { Locale } from "./catalogs";

export type LogGuardLabelKey =
  | "inspectionOnly"
  | "externalSqliteHome"
  | "inspectionUnavailable"
  | "metricsSkippedLarge"
  | "protection"
  | "compat"
  | "quiet"
  | "disable"
  | "repair"
  | "compact"
  | "pagesUnit"
  | "compactComplete"
  | "compactPartial"
  | "confirmCompact"
  | "cancel"
  | "applying"
  | "error.generic"
  | "error.codex_running"
  | "error.process_enumeration_failed"
  | "error.busy"
  | "error.unsupported_schema"
  | "error.trigger_collision"
  | "error.unsafe_path"
  | "error.database_error"
  | "error.config_write_failed";

const LABELS: Record<Locale, Record<LogGuardLabelKey, string>> = {
  en: {
    compact: 'Compact',
    compactComplete: "Compaction complete (logical / on-disk reclaimed)",
    pagesUnit: "pages",
    compactPartial: "Compaction partial (logical / on-disk reclaimed)",
    confirmCompact: 'Confirm compaction',
    cancel: 'Cancel',
    inspectionOnly: 'Inspection only',
    externalSqliteHome: 'External SQLite storage',
    inspectionUnavailable: "Diagnostic log inspection is unavailable.",
    metricsSkippedLarge: "Row metrics skipped: the database is above {threshold}, and scanning it would stall the proxy.",
    protection: "Protection",
    compat: "Compatibility",
    quiet: "Quiet",
    disable: "Disable protection",
    repair: "Repair protection",
    applying: "Applying protection…",
    "error.generic": "Could not change Codex log protection.",
    "error.codex_running": "Quit Codex before changing log protection.",
    "error.process_enumeration_failed": "Could not verify that Codex is stopped. Protection was not changed.",
    "error.busy": "The Codex logs database is busy. Quit Codex and try again.",
    "error.unsupported_schema": "This Codex logs schema is not supported for protection.",
    "error.trigger_collision": "A reserved Log Guard trigger name is already in use. Protection was not changed.",
    "error.unsafe_path": "The Codex logs database path failed the safety check.",
    "error.database_error": "Could not update the Codex logs database.",
    "error.config_write_failed": "The database changed, but OpenCodex could not save the protection setting. Fix config storage, then run Repair.",
  },
  de: {
    compact: 'Komprimieren',
    compactComplete: "Komprimierung abgeschlossen (logisch / auf Datentraeger freigegeben)",
    pagesUnit: "Seiten",
    compactPartial: "Komprimierung teilweise (logisch / auf Datentraeger freigegeben)",
    confirmCompact: 'Komprimierung bestätigen',
    cancel: 'Abbrechen',
    inspectionOnly: 'Nur Inspektion',
    externalSqliteHome: 'Externer SQLite-Speicher',
    inspectionUnavailable: "Die Diagnoseprotokoll-Inspektion ist nicht verfügbar.",
    metricsSkippedLarge: "Zeilenmetriken übersprungen: Die Datenbank ist größer als {threshold}; ein Scan würde den Proxy blockieren.",
    protection: "Schutz",
    compat: "Kompatibilität",
    quiet: "Leise",
    disable: "Schutz deaktivieren",
    repair: "Schutz reparieren",
    applying: "Schutz wird angewendet…",
  },
  fr: {
    compact: "Compacter",
    compactComplete: "Compactage termine (logique / recupere sur disque)",
    pagesUnit: "pages",
    compactPartial: "Compactage partiel (logique / recupere sur disque)",
    confirmCompact: "Confirmer le compactage",
    cancel: "Annuler",
    inspectionOnly: "Inspection uniquement",
    externalSqliteHome: "Stockage SQLite externe",
    inspectionUnavailable: "L’inspection des journaux de diagnostic est indisponible.",
    metricsSkippedLarge: "Métriques de lignes ignorées : la base dépasse {threshold} et son analyse bloquerait le proxy.",
    protection: "Protection",
    compat: "Compatibilité",
    quiet: "Silencieux",
    disable: "Désactiver la protection",
    repair: "Réparer la protection",
    applying: "Application de la protection…",
  },
  ko: {
    compact: '압축',
    compactComplete: "압축 완료 (논리 / 디스크 회수량)",
    pagesUnit: "페이지",
    compactPartial: "압축 부분 완료 (논리 / 디스크 회수량)",
    confirmCompact: '압축 확인',
    cancel: '취소',
    inspectionOnly: '검사 전용',
    externalSqliteHome: '외부 SQLite 저장소',
    inspectionUnavailable: "진단 로그 검사를 사용할 수 없습니다.",
    metricsSkippedLarge: "행 지표를 건너뛰었습니다. 데이터베이스가 {threshold}보다 커서 스캔하면 프록시가 멈춥니다.",
    protection: "보호",
    compat: "호환 모드",
    quiet: "조용한 모드",
    disable: "보호 비활성화",
    repair: "보호 복구",
    applying: "보호 적용 중…",
  },
  zh: {
    compact: '压缩',
    compactComplete: "压缩完成（逻辑 / 磁盘回收）",
    pagesUnit: "页",
    compactPartial: "压缩部分完成（逻辑 / 磁盘回收）",
    confirmCompact: '确认压缩',
    cancel: '取消',
    inspectionOnly: '仅检查',
    externalSqliteHome: '外部 SQLite 存储',
    inspectionUnavailable: "诊断日志检查当前不可用。",
    metricsSkippedLarge: "已跳过行指标：数据库超过 {threshold}，扫描会阻塞代理。",
    protection: "保护",
    compat: "兼容模式",
    quiet: "静默模式",
    disable: "禁用保护",
    repair: "修复保护",
    applying: "正在应用保护…",
  },
  "zh-TW": {
    compact: '壓縮',
    compactComplete: "压缩完成（逻辑 / 磁盘回收）",
    pagesUnit: "頁",
    compactPartial: "压缩部分完成（逻辑 / 磁盘回收）",
    confirmCompact: '確認壓縮',
    cancel: '取消',
    inspectionOnly: '僅檢查',
    externalSqliteHome: '外部 SQLite 儲存空間',
    inspectionUnavailable: "診斷記錄檢查目前無法使用。",
    metricsSkippedLarge: "已略過列指標：資料庫超過 {threshold}，掃描會阻塞代理。",
    protection: "保護",
    compat: "相容模式",
    quiet: "靜默模式",
    disable: "停用保護",
    repair: "修復保護",
    applying: "正在套用保護…",
  },
  ru: {
    compact: 'Сжать',
    compactComplete: "Сжатие завершено (логически / освобождено на диске)",
    pagesUnit: "страниц",
    compactPartial: "Сжатие частичное (логически / освобождено на диске)",
    confirmCompact: 'Подтвердить сжатие',
    cancel: 'Отмена',
    inspectionOnly: 'Только проверка',
    externalSqliteHome: 'Внешнее хранилище SQLite',
    inspectionUnavailable: "Проверка диагностических журналов недоступна.",
    metricsSkippedLarge: "Метрики строк пропущены: база больше {threshold}, и её сканирование заблокировало бы прокси.",
    protection: "Защита",
    compat: "Совместимость",
    quiet: "Тихий режим",
    disable: "Отключить защиту",
    repair: "Восстановить защиту",
    applying: "Применение защиты…",
  },
  ja: {
    compact: '圧縮',
    compactComplete: "圧縮完了（論理 / ディスク解放）",
    pagesUnit: "ページ",
    compactPartial: "圧縮は部分的に完了（論理 / ディスク解放）",
    confirmCompact: '圧縮を確認',
    cancel: 'キャンセル',
    inspectionOnly: '検査のみ',
    externalSqliteHome: '外部 SQLite ストレージ',
    inspectionUnavailable: "診断ログの検査を利用できません。",
    metricsSkippedLarge: "行メトリクスをスキップしました。データベースが {threshold} を超えており、走査するとプロキシが停止します。",
    protection: "保護",
    compat: "互換モード",
    quiet: "静音モード",
    disable: "保護を無効化",
    repair: "保護を修復",
    applying: "保護を適用中…",
  },
  tr: {
    compact: 'Sıkıştır',
    compactComplete: "Sikistirma tamamlandi (mantiksal / diskte geri kazanilan)",
    pagesUnit: "sayfa",
    compactPartial: "Sikistirma kismi (mantiksal / diskte geri kazanilan)",
    confirmCompact: 'Sıkıştırmayı onayla',
    cancel: 'İptal',
    inspectionOnly: 'Yalnızca inceleme',
    externalSqliteHome: 'Harici SQLite depolaması',
    inspectionUnavailable: "Tanılama günlüğü incelemesi kullanılamıyor.",
    metricsSkippedLarge: "Satır ölçümleri atlandı: veritabanı {threshold} sınırının üzerinde ve taranması proxy’yi kilitler.",
    protection: "Koruma",
    compat: "Uyumluluk",
    quiet: "Sessiz",
    disable: "Korumayı devre dışı bırak",
    repair: "Korumayı onar",
    applying: "Koruma uygulanıyor…",
  },
};

export function logGuardLabel(locale: Locale, key: LogGuardLabelKey): string {
  return LABELS[locale][key];
}
