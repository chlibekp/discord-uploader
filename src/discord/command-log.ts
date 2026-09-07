import type { Config } from "../config.js";

/**
 * Post a command execution log to the configured Discord webhook.
 * Failures are logged and swallowed — this must never interrupt the command flow.
 */
export async function logCommandExecution(
  config: Config,
  username: string,
  command: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!config.commandLogWebhookUrl) return;

  try {
    const res = await fetchImpl(config.commandLogWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Command Executed",
            fields: [
              { name: "User", value: username, inline: true },
              { name: "Command", value: `\`/${command}\``, inline: true },
            ],
            color: 5793266,
            timestamp: new Date().toISOString(),
          },
        ],
        username: "Command Logger",
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      console.error(
        `Command log webhook failed: ${res.status} ${await res.text()}`,
      );
    }
  } catch (err) {
    console.error("Command log webhook request failed:", err);
  }
}
