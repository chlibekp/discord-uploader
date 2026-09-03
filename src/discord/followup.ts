import type { Config } from "../config.js";
import type { FileRecord } from "../types.js";

const EMBED_COLOR = 5793266;

export interface FollowupPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  allowed_mentions: { parse: [] };
}

/**
 * A danger button whose custom_id carries the file id. Pressing it fires a
 * message-component interaction back to /interactions, where ownership is
 * checked before anything is deleted.
 */
export function deleteButtonRow(record: FileRecord): unknown {
  return {
    type: 1,
    components: [{ type: 2, style: 4, label: "Delete", custom_id: `del:${record.id}` }],
  };
}

export function fileUrl(config: Config, record: FileRecord): string {
  return `${config.publicUrl}/f/${record.id}/${encodeURIComponent(record.name)}`;
}

export function watchUrl(config: Config, record: FileRecord): string {
  return `${config.publicUrl}/v/${record.id}`;
}

/**
 * Images go in an embed so they render large and inline.
 *
 * Videos deliberately do not: attaching any embed object suppresses Discord's
 * own unfurl of the URL, and that unfurl is what produces the inline player.
 * So a video posts a bare link to the OG page instead.
 */
export function buildFollowupPayload(config: Config, record: FileRecord): FollowupPayload {
  if (record.kind === "image") {
    return {
      embeds: [
        {
          description: `<@${record.userId}> uploaded an image`,
          image: { url: fileUrl(config, record) },
          color: EMBED_COLOR,
        },
      ],
      components: [deleteButtonRow(record)],
      allowed_mentions: { parse: [] },
    };
  }

  return {
    content: `<@${record.userId}> uploaded a video\n${watchUrl(config, record)}`,
    components: [deleteButtonRow(record)],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Post into the channel the command came from.
 *
 * This webhook is the only way a user-installed command can post where the bot
 * is not a member, and the interaction token in the path is its sole credential.
 * The token dies 15 minutes after the command, so a late upload gets `false`
 * here and the caller falls back to showing the raw link.
 */
export async function postFollowup(
  config: Config,
  interactionToken: string,
  payload: FollowupPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://discord.com/api/v10/webhooks/${config.discordAppId}/${interactionToken}`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Followup post failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Followup request failed:", err);
    return false;
  }
}
