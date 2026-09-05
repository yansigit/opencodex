import * as readline from "node:readline";
import { modelSelectionGuidance } from "./model-selection-guidance";
import { initializeProviderModelSelection } from "../providers/initial-model-selection";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { injectCodexConfig } from "../codex/inject";
import { classifyOpenAiTierBackup, getConfigPath, getDefaultConfig, initializePersistedConfigIfMissing, isValidProviderName, preserveOpenAiTierRollbackSnapshot, saveConfig } from "../config";
import { interactiveConfirm } from "./interactive-confirm";
import { enrichProviderFromCatalog } from "../oauth/key-providers";
import { deriveInitProviders } from "../providers/derive";
import type { OcxConfig, OcxProviderConfig } from "../types";

function createPrompt(): { ask(question: string): Promise<string>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => { closed = true; });
  // When stdin is a pipe, all input may arrive in one chunk and readline closes
  // immediately after the first question consumes its line. Consume the
  // interface as an async iterator instead, which retains already-buffered
  // lines for subsequent prompts.
  const pipedLines = !process.stdin.isTTY ? rl[Symbol.asyncIterator]() : null;
  return {
    ask(question: string): Promise<string> {
      if (pipedLines) {
        process.stdout.write(question);
        return pipedLines.next().then(({ value, done }) => {
          if (done) throw new Error("stdin reached EOF while waiting for input");
          return value as string;
        });
      }
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("stdin closed before the prompt could be answered"));
          return;
        }
        const onClose = () => {
          reject(new Error("stdin reached EOF while waiting for input"));
        };
        rl.once("close", onClose);
        rl.question(question, answer => {
          rl.off("close", onClose);
          resolve(answer);
        });
      });
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

type InitKind = "forward" | "oauth" | "key" | "local";
export interface InitProvider {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  kind: InitKind;
  dashboardUrl?: string;
  defaultModel?: string;
}

/**
 * The full CLI provider menu, derived from the canonical provider registry so `ocx init`,
 * the GUI picker, key-login catalog, OAuth seeds, and metadata aliases cannot drift.
 */
export function buildInitProviders(): InitProvider[] {
  return deriveInitProviders();
}

const KIND_HEADING: Record<InitKind, string> = {
  forward: "ChatGPT login",
  oauth: "Account login (OAuth — then run: ocx login <id>)",
  key: "API key (paste a key from the provider's dashboard)",
  local: "Local servers (usually no key)",
};

function printMenu(providers: InitProvider[]): void {
  console.log("Choose your default provider (you can add more later):");
  let lastKind: InitKind | null = null;
  providers.forEach((p, i) => {
    if (p.kind !== lastKind) { console.log(`\n  ${KIND_HEADING[p.kind]}:`); lastKind = p.kind; }
    console.log(`   ${String(i + 1).padStart(2)}. ${p.label}`);
  });
  console.log(`\n   ${providers.length + 1}. custom (enter URL manually)`);
}

const envKeyFor = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

/** Post-init cleanup of `.pre-openai-tiers-v2.bak` with rollback preservation (issue #257). */
export function cleanupOpenAiTierBackupAfterInit(configPath = getConfigPath()): void {
  const backup = `${configPath}.pre-openai-tiers-v2.bak`;
  try {
    if (!existsSync(backup)) return;
    if (classifyOpenAiTierBackup(readFileSync(backup)) === "stale") {
      unlinkSync(backup);
      return;
    }
    const preserved = preserveOpenAiTierRollbackSnapshot(configPath);
    console.warn(`⚠️  Kept your pre-migration config rollback snapshot at ${preserved}`);
  } catch { /* cleanup is best-effort; never block init on backup housekeeping */ }
}

export function parseInitArgs(args: string[]): { yes: boolean; error?: string } {
  const unknown = args.find(arg => arg !== "--yes");
  return unknown === undefined
    ? { yes: args.includes("--yes") }
    : { yes: false, error: `Unknown option: ${unknown}. Usage: ocx init [--yes]` };
}

export async function runInit(args: string[] = []): Promise<void> {
  const parsed = parseInitArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  // Do not create a readline reader until overwrite consent has completed.
  // interactiveConfirm may temporarily enable raw mode on stdin; keeping a
  // second reader alive here can replay its key into the first setup prompt.
  let prompt: ReturnType<typeof createPrompt> | undefined;
  try {
    console.log("\n🔧 opencodex (ocx) setup\n");

    const existingConfig = existsSync(getConfigPath());
    let replaceExisting = parsed.yes;
    if (existingConfig && !replaceExisting) {
      if (!process.stdin.isTTY) {
        console.error("❌ An opencodex config already exists. Re-run `ocx init --yes` to replace it.");
        process.exitCode = 2;
        return;
      }
      replaceExisting = await interactiveConfirm({
        question: "Overwrite existing config?",
        defaultYes: false,
        hint: "y/n · enter",
      });
      if (!replaceExisting) {
        console.log("Keeping existing config.");
        return;
      }
    }

    prompt = createPrompt();
    const providers = buildInitProviders();
    printMenu(providers);

    const choice = await prompt.ask("\nSelect default provider (number): ");
    const idx = parseInt(choice, 10) - 1;

    let providerName: string;
    let providerConfig: OcxProviderConfig;
    let oauthHint = false;

    if (idx >= 0 && idx < providers.length) {
      const p = providers[idx];
      providerName = p.id;
      console.log(`\n📡 ${p.label}`);
      console.log(`   Base URL: ${p.baseUrl}`);

      if (p.kind === "forward") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "forward" };
        console.log("   No API key needed — forwards your existing `codex login`.");
      } else if (p.kind === "oauth") {
        providerConfig = { adapter: p.adapter, baseUrl: p.baseUrl, authMode: "oauth", ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) };
        oauthHint = true;
      } else {
        // key + local: collect a key (local usually blank).
        if (p.dashboardUrl) console.log(`   🔑 Get your key: ${p.dashboardUrl}`);
        // Template URL with placeholders (e.g. Cloudflare's {account_id}) needs a resolved value.
        let baseUrl = p.baseUrl;
        if (/\{[^}]*\}/.test(baseUrl)) {
          const resolved = (await prompt.ask(`   Your endpoint URL (${baseUrl}): `)).trim();
          if (!resolved) {
            console.error("   A resolved URL is required — replace the {placeholder} with your actual value.");
            process.exit(1);
          }
          baseUrl = resolved;
        }
        const env = envKeyFor(p.id);
        const hint = p.kind === "local" ? "API key (usually blank — press Enter): " : `API key (paste, or env var $${env}): `;
        const apiKey = (await prompt.ask(`\n${hint}`)).trim();
        const modelChoice = (await prompt.ask(`Default model${p.defaultModel ? ` [${p.defaultModel}]` : " (optional)"}: `)).trim();
        const defaultModel = modelChoice || p.defaultModel;
        providerConfig = {
          adapter: p.adapter,
          baseUrl,
          ...(p.kind === "key" ? { apiKey: apiKey || `\${${env}}` } : apiKey ? { apiKey } : {}),
          ...(defaultModel ? { defaultModel } : {}),
        };
        // Apply the catalog's models / vision classification (same enrichment as the GUI).
        enrichProviderFromCatalog(p.id, providerConfig);
      }
    } else {
      providerName = (await prompt.ask("Provider name: ")).trim();
      if (!isValidProviderName(providerName)) {
        console.error("Provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key.");
        process.exit(1);
      }
      const baseUrl = await prompt.ask("Base URL (e.g. http://localhost:11434/v1): ");
      const adapter = await prompt.ask("Adapter [openai-chat]: ") || "openai-chat";
      const apiKey = await prompt.ask("API key (optional): ");
      const defaultModel = await prompt.ask("Default model: ");
      providerConfig = {
        adapter: adapter.trim(),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      };
    }

    const portStr = await prompt.ask("\nProxy port [10100]: ");
    const port = parseInt(portStr, 10) || 10100;

    initializeProviderModelSelection(providerName, providerConfig);
    const config: OcxConfig = {
      ...getDefaultConfig(),
      port,
      providers: { [providerName]: providerConfig },
      defaultProvider: providerName,
      modelDiscovery: { newModelPolicy: "off" },
    };

    if (replaceExisting) {
      saveConfig(config);
    } else {
      const outcome = initializePersistedConfigIfMissing(config);
      if (outcome !== "created") {
        console.error(outcome === "exists"
          ? "❌ Config was created by another process while setup was running; keeping that config."
          : "❌ Config became invalid while setup was running; no changes were made.");
        process.exitCode = 1;
        return;
      }
    }
    // Init writes a fresh config, so a stale pre-migration backup from a previous
    // installation would make the next `ocx start` crash on a stale-backup
    // collision (issue #257). But only a STALE backup (unparseable, or already a
    // post-migration v2 snapshot) may be deleted; a backup that still parses as a
    // valid pre-migration (v1) config is a user-intentional rollback point and is
    // preserved by renaming it out of the collision path (sol review 260722).
    cleanupOpenAiTierBackupAfterInit();
    console.log(`\n✅ Config saved to ~/.opencodex/config.json`);
    if (oauthHint) console.log(`🔐 Authenticate this provider with:  ocx login ${providerName}`);

    const injectAnswer = await prompt.ask("Inject into Codex config.toml? [Y/n]: ");
    if (injectAnswer.trim().toLowerCase() !== "n") {
      console.log("Fetching available models from provider...");
      const result = await injectCodexConfig(port, config);
      console.log(result.success ? `✅ ${result.message}` : `⚠️  ${result.message}`);
    }

    const shimAnswer = await prompt.ask("Install Codex autostart shim? [Y/n]: ");
    if (shimAnswer.trim().toLowerCase() !== "n") {
      try {
        const { installCodexShim } = await import("../codex/shim");
        const result = installCodexShim();
        console.log(result.installed ? `✅ ${result.message}` : `⚠️  ${result.message}`);
      } catch (err) {
        console.log(`⚠️  Codex autostart shim skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\n🚀 Setup complete! Run 'ocx start' to start the proxy.`);
    for (const line of modelSelectionGuidance(providerName)) console.log(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/stdin (closed|reached EOF)/i.test(message)) {
      console.error(`\n❌ ${message}. Re-run \`ocx init\` in an interactive terminal.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prompt?.close();
  }
}
