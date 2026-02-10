import crypto from 'crypto';
import { promisify } from 'util';
import type { ShareOptions, ShareResult, ResolvedConfig } from '../types.js';
import type { DiscordriveDatabase } from '../db/database.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

/**
 * Create a share link for a file.
 *
 * For the library use case, the simplest path is `allowInsecure: true` which
 * stores the key on the server and embeds it in the URL. This enables Discord/social
 * embeds without a password prompt.
 */
export async function createFileShare(
  fileId: number,
  deps: { db: DiscordriveDatabase; config: ResolvedConfig },
  options?: ShareOptions,
): Promise<ShareResult> {
  const { db, config } = deps;

  const file = db.getFileById(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  const isEncrypted = !!file.encryption_header;
  const encKey = options?.encryptionKey ?? config.encryptionKey;
  const allowInsecure = options?.allowInsecure ?? true;
  const allowEmbed = options?.allowEmbed ?? true;

  let encryptedKey: string | null = null;
  let encryptedKeySalt: string | null = null;
  let keyWrapMethod: string | null = null;
  let urlKey: string | null = null;

  if (isEncrypted && encKey) {
    if (allowInsecure) {
      // Store key on server — enables embeds, no password needed
      urlKey = encKey;
    }

    if (options?.password) {
      // Wrap the encryption key with a password using PBKDF2 + AES-GCM
      const salt = crypto.randomBytes(32);
      const iterations = 100000;
      const derivedKey = await pbkdf2Async(options.password, salt, iterations, 32, 'sha256');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey as Buffer, iv);
      const encrypted = Buffer.concat([cipher.update(encKey, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Combined: iv (12) + encrypted + authTag (16)
      encryptedKey = Buffer.concat([iv, encrypted, authTag]).toString('base64');
      encryptedKeySalt = salt.toString('base64');
      keyWrapMethod = `pbkdf2-aes-gcm-${iterations / 1000}k`;
    }
  }

  const share = db.createShare(fileId, null, {
    encryptedKey,
    encryptedKeySalt,
    keyWrapMethod,
    requirePassword: !!options?.password,
    allowInsecure,
    urlKey,
    mediaWidth: options?.mediaWidth ?? file.media_width ?? null,
    mediaHeight: options?.mediaHeight ?? file.media_height ?? null,
    allowEmbed,
  });

  return buildShareResult(share.token, config);
}

/**
 * Create a share link for a folder.
 */
export async function createFolderShare(
  folderId: number,
  deps: { db: DiscordriveDatabase; config: ResolvedConfig },
  options?: ShareOptions,
): Promise<ShareResult> {
  const { db, config } = deps;

  const folder = db.getFolderById(folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);

  const share = db.createShare(null, folderId, {
    allowInsecure: options?.allowInsecure ?? true,
    allowEmbed: options?.allowEmbed ?? true,
  });

  return buildShareResult(share.token, config);
}

function buildShareResult(token: string, config: ResolvedConfig): ShareResult {
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  const shareBase = `${base}/s/${token}`;

  // Find the share in DB to get the id
  // We use the token directly since it was just created
  return {
    id: 0, // Will be filled by caller if needed
    token,
    url: shareBase,
    downloadUrl: `${shareBase}/download`,
    streamUrl: `${shareBase}/stream`,
    thumbUrl: `${shareBase}/thumb`,
  };
}
