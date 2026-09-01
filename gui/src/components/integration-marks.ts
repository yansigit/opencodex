import {
  CLIENT_MARKS,
  MONOCHROME_CLIENT_MARKS,
  type ExportClientId,
} from "./apikeys-workspace/client-config-clients";
import type { OverviewClientId } from "../pages/integrations/overview-clients";

const NATIVE_MARKS: Record<Exclude<OverviewClientId, ExportClientId>, string> = {
  codex: "/provider-icons/openai.svg",
  claude: "/provider-icons/claude-color.svg",
  claudeDesktop: "/provider-icons/claude-color.svg",
  grok: "/provider-icons/grok.svg",
};

export const INTEGRATION_MARKS: Record<OverviewClientId, string | null> = {
  ...NATIVE_MARKS,
  opencode: CLIENT_MARKS.opencode ?? null,
  pi: CLIENT_MARKS.pi ?? null,
  omp: CLIENT_MARKS.omp ?? null,
  hermes: CLIENT_MARKS.hermes ?? null,
  openclaw: CLIENT_MARKS.openclaw ?? null,
  kimi: CLIENT_MARKS.kimi ?? null,
  gajae: CLIENT_MARKS.gajae ?? null,
  dsh: CLIENT_MARKS.dsh ?? null,
  mcode: CLIENT_MARKS.mcode ?? null,
  zcode: CLIENT_MARKS.zcode ?? null,
  prime: CLIENT_MARKS.prime ?? null,
  aside: CLIENT_MARKS.aside ?? null,
};

export const MASKED_MARKS: ReadonlySet<string> = new Set([
  ...[...MONOCHROME_CLIENT_MARKS]
    .map(clientId => CLIENT_MARKS[clientId])
    .filter((src): src is string => src !== undefined),
  NATIVE_MARKS.grok,
]);

export function markFor(clientId: OverviewClientId): string | null {
  return INTEGRATION_MARKS[clientId];
}
