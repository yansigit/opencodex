import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types/config";
import { providerObservationAccountKeyForTests } from "../../src/providers/quota";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";

describe("provider observation account key", () => {
  function configWithKey(apiKey: string): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          authMode: "key",
          apiKey,
        },
      },
    } as OcxConfig;
  }

  test("two different API keys for one provider do not share an observation identity", () => {
    // A key-auth provider has NO account set, so `activeAccountId ?? "default"` collapsed every
    // key in the pool onto one identity: rotating from a spent key to a fresh one inherited the
    // spent key's usage history and read as a reset (measured 97% -> 12% fired a false
    // surprise). The report cache already discriminates these via apiKeyPoolEntryId.
    const spent = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-spent-key-aaa"));
    const fresh = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-fresh-key-bbb"));

    expect(spent).not.toBe(fresh);
    // Neither may be the bare provider name, which is what collapsed them.
    expect(spent).not.toBe("deepseek");
  });

  test("the same key resolves to the same identity across calls", () => {
    // Stability is what makes the persisted baseline usable at all.
    const first = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-stable-key"));
    const second = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-stable-key"));
    expect(first).toBe(second);
  });

  test("keychain and plaintext forms of the same key share one observation identity", () => {
    setProviderKeychainEntryFactoryForTests((_service, account) => ({
      getPassword: () => account === "deepseek" ? "sk-stable-key" : null,
      setPassword: () => {},
      deletePassword: () => true,
    }));
    try {
      const plaintext = providerObservationAccountKeyForTests("deepseek", configWithKey("sk-stable-key"));
      const keychain = providerObservationAccountKeyForTests("deepseek", configWithKey("keychain:deepseek"));
      expect(keychain).toBe(plaintext);
    } finally {
      setProviderKeychainEntryFactoryForTests(null);
    }
  });

  test("a provider with no key at all still yields a usable identity", () => {
    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "ollama",
      providers: { ollama: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" } },
    } as OcxConfig;
    expect(providerObservationAccountKeyForTests("ollama", config)).toContain("ollama");
  });
});
