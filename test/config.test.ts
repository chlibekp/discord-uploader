import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { publicKeyHex } from "./helpers.js";

const base = {
  DISCORD_APP_ID: "123",
  DISCORD_PUBLIC_KEY: publicKeyHex,
  DISCORD_BOT_TOKEN: "token",
  PUBLIC_URL: "https://uploader.test",
  REDIS_URL: "redis://localhost:6379",
} as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ ...base });
    expect(config.dataDir).toBe("/data");
    expect(config.maxFileBytes).toBe(2147483648);
    expect(config.maxTotalBytes).toBe(4831838208);
    expect(config.port).toBe(3000);
  });

  it("strips a trailing slash from PUBLIC_URL", () => {
    expect(loadConfig({ ...base, PUBLIC_URL: "https://x.test///" }).publicUrl).toBe("https://x.test");
  });

  it.each(["DISCORD_APP_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "PUBLIC_URL", "REDIS_URL"])(
    "rejects a missing %s",
    (name) => {
      const env = { ...base };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  it("rejects a PUBLIC_URL without a scheme", () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: "uploader.test" })).toThrow(/must start with/);
  });

  it("rejects a public key that is not 32 hex-encoded bytes", () => {
    expect(() => loadConfig({ ...base, DISCORD_PUBLIC_KEY: "abcd" })).toThrow(/64 hex/);
  });

  it("rejects a non-numeric size limit", () => {
    expect(() => loadConfig({ ...base, MAX_FILE_BYTES: "big" })).toThrow(/positive integer/);
    expect(() => loadConfig({ ...base, MAX_TOTAL_BYTES: "-5" })).toThrow(/positive integer/);
  });
});
