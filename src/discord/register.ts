import type { Config } from "../config.js";

export const UPLOAD_COMMAND = {
  name: "upload",
  description: "Upload an image or video",
  type: 1,
  // 0 = guild install, 1 = user install. Both, so the command follows the user.
  integration_types: [0, 1],
  // 0 = guild, 1 = bot DM, 2 = private channel (DMs and group DMs).
  contexts: [0, 1, 2],
} as const;

/**
 * Overwrite the application's global commands. PUT is a full replace, so this is
 * idempotent and safe to run on every boot.
 *
 * A failure is reported but never fatal: previously registered commands keep
 * working, and refusing to start over a transient Discord 5xx would take the
 * whole service down for no gain. Global command changes can take up to an hour
 * to propagate.
 */
export async function registerCommands(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://discord.com/api/v10/applications/${config.discordAppId}/commands`;

  try {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([UPLOAD_COMMAND]),
    });

    if (!res.ok) {
      console.error(`Command registration failed: ${res.status} ${await res.text()}`);
      return false;
    }
    console.log("Registered global command /upload");
    return true;
  } catch (err) {
    console.error("Command registration request failed:", err);
    return false;
  }
}
