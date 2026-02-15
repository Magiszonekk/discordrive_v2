import type { FilePartRecord } from '../types.js';
import type { BotPool } from '../discord/bot-pool.js';
import type { DiscordriveDatabase } from '../db/database.js';

/**
 * Extract the attachment filename from a Discord CDN URL.
 * e.g. "https://cdn.discordapp.com/attachments/123/456/video.mp4.part001of013?ex=..." -> "video.mp4.part001of013"
 */
function extractFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    // Fallback: strip query params and get last segment
    const withoutQuery = url.split('?')[0];
    const segments = withoutQuery.split('/');
    return decodeURIComponent(segments[segments.length - 1]);
  }
}

/**
 * Resolve fresh Discord CDN URLs by fetching messages via the Discord API.
 * Groups parts by message_id to minimize API calls.
 * Optionally updates the DB cache with fresh URLs.
 */
export async function resolvePartUrls(
  parts: FilePartRecord[],
  botPool: BotPool,
  db?: DiscordriveDatabase,
  options?: { graceful?: boolean },
): Promise<FilePartRecord[]> {
  if (parts.length === 0) return parts;
  const graceful = options?.graceful ?? false;

  // Group parts by message_id
  const messageGroups = new Map<string, FilePartRecord[]>();
  for (const part of parts) {
    const group = messageGroups.get(part.message_id);
    if (group) {
      group.push(part);
    } else {
      messageGroups.set(part.message_id, [part]);
    }
  }

  const updatedParts = new Map<number, FilePartRecord>();

  for (const [messageId, groupParts] of messageGroups) {
    let message: any;
    try {
      message = await botPool.fetchMessage(messageId);
    } catch (err: any) {
      if (graceful) {
        console.warn(`[Discordrive] Graceful: failed to fetch message ${messageId}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (!message) {
      if (graceful) {
        console.warn(`[Discordrive] Graceful: message ${messageId} not found, skipping ${groupParts.length} parts`);
        continue;
      }
      throw new Error(`Failed to fetch Discord message ${messageId} — file data may have been deleted from Discord`);
    }

    const attachments = Array.from(message.attachments.values()) as Array<{ name: string; url: string; size: number }>;

    for (const part of groupParts) {
      const oldFilename = extractFilenameFromUrl(part.discord_url);

      // Primary: match by filename
      let freshAttachment = attachments.find(a => a.name === oldFilename);

      if (!freshAttachment) {
        // Fallback: match by index order within the message
        const sorted = [...groupParts].sort((a, b) => a.part_number - b.part_number);
        const idx = sorted.findIndex(p => p.id === part.id);
        if (idx >= 0 && idx < attachments.length) {
          freshAttachment = attachments[idx];
        }
      }

      if (!freshAttachment) {
        if (graceful) {
          console.warn(`[Discordrive] Graceful: cannot map part ${part.part_number} (file ${part.file_id}) to attachment in message ${messageId}`);
          continue;
        }
        throw new Error(
          `Cannot map part ${part.part_number} (file ${part.file_id}) to attachment in message ${messageId}`,
        );
      }

      updatedParts.set(part.id, { ...part, discord_url: freshAttachment.url });
    }
  }

  // Optionally update DB cache
  if (db && updatedParts.size > 0) {
    const updates = [...updatedParts.values()].map(p => ({
      id: p.id,
      discordUrl: p.discord_url,
    }));
    try {
      db.updatePartUrls(updates);
    } catch {
      // Non-critical — log but don't fail the download
      console.warn('[Discordrive] Failed to update URL cache in DB');
    }
  }

  return parts.map(p => updatedParts.get(p.id) || p);
}
