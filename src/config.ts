export interface Config {
  discordAppId: string;
  discordPublicKey: string;
  discordBotToken: string;
  publicUrl: string;
  redisUrl: string;
  dataDir: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Ceiling on the combined size of one uploader's live files. */
  maxUserBytes: number;
  port: number;
}

const DEFAULTS = {
  DATA_DIR: "/data",
  MAX_FILE_BYTES: "2147483648",
  MAX_TOTAL_BYTES: "4831838208",
  MAX_USER_BYTES: "2147483648",
  PORT: "3000",
} as const;

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number {
  const raw = env[name]?.trim() || fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer, got: ${raw}`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = required(env, "PUBLIC_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(publicUrl)) {
    throw new ConfigError(
      `PUBLIC_URL must start with http:// or https://, got: ${publicUrl}`,
    );
  }

  const publicKey = required(env, "DISCORD_PUBLIC_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    throw new ConfigError(
      "DISCORD_PUBLIC_KEY must be 64 hex characters (a 32-byte Ed25519 key)",
    );
  }

  return {
    discordAppId: required(env, "DISCORD_APP_ID"),
    discordPublicKey: publicKey.toLowerCase(),
    discordBotToken: required(env, "DISCORD_BOT_TOKEN"),
    publicUrl,
    redisUrl: required(env, "REDIS_URL"),
    dataDir: env.DATA_DIR?.trim() || DEFAULTS.DATA_DIR,
    maxFileBytes: positiveInt(env, "MAX_FILE_BYTES", DEFAULTS.MAX_FILE_BYTES),
    maxTotalBytes: positiveInt(
      env,
      "MAX_TOTAL_BYTES",
      DEFAULTS.MAX_TOTAL_BYTES,
    ),
    maxUserBytes: positiveInt(env, "MAX_USER_BYTES", DEFAULTS.MAX_USER_BYTES),
    port: positiveInt(env, "PORT", DEFAULTS.PORT),
  };
}

export { ConfigError };
