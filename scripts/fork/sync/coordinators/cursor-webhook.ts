import { createHttpCoordinator } from "./http";
import type { FetchImplementation, ForkSyncCoordinator } from "../types";

export interface CursorWebhookOptions {
  url?: string;
  secret?: string;
  fetchImpl?: FetchImplementation;
}

export function createCursorWebhookCoordinator(
  options: CursorWebhookOptions,
): ForkSyncCoordinator {
  const rawSecret = (options.secret ?? "").trim();
  const isBearerSecret = /^crsr_/i.test(rawSecret);
  const isHeaderSecret = /^Bearer\s+/i.test(rawSecret);
  const http = createHttpCoordinator({
    ...options,
    secret: rawSecret,
    authHeader: isHeaderSecret
      ? rawSecret
      : isBearerSecret
        ? `Bearer ${rawSecret}`
        : undefined,
    signatureHeader: "x-fork-sync-signature",
    signaturePrefix: "sha256=",
    errorLabel: "Cursor webhook",
  });
  return {
    id: "cursor-webhook",
    async start(event) {
      if (!rawSecret) return;
      await http.start(event);
    },
  };
}
