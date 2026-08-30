/** Cursor oracle hard-coded policy */
export const CURSOR_ORACLE_UPSTREAM = "https://api2.cursor.sh" as const;
export const CURSOR_ORACLE_LOOPBACK_HOST = "127.0.0.1" as const;
export const CURSOR_ORACLE_SCRATCH_SUBDIR = "oracle-raw" as const;
export const CURSOR_ORACLE_OBSERVATION_SUBDIR = "oracle-observations" as const;
export const CURSOR_ORACLE_RAW_TTL_MS = 24 * 60 * 60 * 1000;
export const CURSOR_ORACLE_MAX_RAW_BYTES = 2 * 1024 * 1024;
export const CURSOR_ORACLE_MAX_FORWARD_BODY_BYTES = 16 * 1024 * 1024;
export const CURSOR_ORACLE_DEFAULT_TIMEOUT_MS = 120_000;
export const CURSOR_ORACLE_LOOPBACK_PORT_HINT = 0;
export const CURSOR_ORACLE_EPHEMERAL_AUTH_HEADERS = ["authorization","x-cursor-api-key","x-api-key","cursor-api-key"] as const;
