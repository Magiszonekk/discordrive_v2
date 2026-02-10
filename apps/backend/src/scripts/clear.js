#!/usr/bin/env node

/**
 * discordrive:clear — Wipe ALL Discordrive data.
 *
 * Deletes every Discord message from all channels the bots can access,
 * then clears file-related database tables. User accounts are preserved.
 *
 * Usage:  pnpm discordrive:clear
 */

const readline = require('readline');
const { config, validateConfig, toCoreConfig } = require('../config');
const { initDatabase, getDb, closeDatabase } = require('../db');
const { BotPool, resolveConfig } = require('@discordrive/core');

// ── Helpers ──────────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function abort(msg) {
  console.log(`\n${msg ?? 'Aborted.'}`);
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // 1. Init
  validateConfig();
  initDatabase(config.db.path);
  const db = getDb();

  // 2. Gather stats
  const fileCount = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const partCount = db.prepare('SELECT COUNT(*) as c FROM file_parts').get().c;
  const folderCount = db.prepare('SELECT COUNT(*) as c FROM folders').get().c;
  const shareCount = db.prepare('SELECT COUNT(*) as c FROM shares').get().c;

  console.log('\n========================================');
  console.log('       DISCORDRIVE — CLEAR ALL DATA');
  console.log('========================================\n');
  console.log(`  Files:   ${fileCount}`);
  console.log(`  Parts:   ${partCount}`);
  console.log(`  Folders: ${folderCount}`);
  console.log(`  Shares:  ${shareCount}`);
  console.log();

  if (fileCount === 0 && partCount === 0 && folderCount === 0 && shareCount === 0) {
    console.log('Database is already empty. Will still purge Discord channels.\n');
  }

  // 3. First confirmation
  const answer1 = await ask('Are you sure you want to delete ALL data? Type "yes" to continue: ');
  if (answer1 !== 'yes') abort();

  // 4. Second confirmation
  const answer2 = await ask('THIS CANNOT BE UNDONE. Type "DELETE EVERYTHING" to confirm: ');
  if (answer2 !== 'DELETE EVERYTHING') abort();

  console.log('\nStarting...\n');

  // 5. Init Discord bots (must await — need them ready)
  const coreConfig = resolveConfig(toCoreConfig());
  const botPool = new BotPool({
    tokens: coreConfig.discordTokens,
    channelIds: coreConfig.channelIds,
    botsPerChannel: coreConfig.botsPerChannel,
    botInitRetries: coreConfig.botInitRetries,
  });

  console.log('[1/4] Connecting Discord bots...');
  await botPool.init();
  console.log(`      ${botPool.getBotCount()} bot(s) connected.\n`);

  // 6. Delete tracked messages from DB
  const partMsgIds = db
    .prepare('SELECT DISTINCT message_id FROM file_parts WHERE message_id IS NOT NULL')
    .all()
    .map((r) => r.message_id);
  const thumbMsgIds = db
    .prepare('SELECT thumbnail_message_id FROM files WHERE thumbnail_message_id IS NOT NULL')
    .all()
    .map((r) => r.thumbnail_message_id);
  const trackedIds = [...new Set([...partMsgIds, ...thumbMsgIds])];

  if (trackedIds.length > 0) {
    console.log(`[2/4] Deleting ${trackedIds.length} tracked Discord message(s)...`);
    await botPool.deleteMessagesBulk(trackedIds);
    console.log('      Done.\n');
  } else {
    console.log('[2/4] No tracked messages to delete.\n');
  }

  // 7. Purge ALL remaining messages from every channel
  console.log('[3/4] Purging all remaining messages from Discord channels...');
  let totalPurged = 0;
  const seenChannels = new Set();

  for (const bot of botPool.getAllBots()) {
    for (const [channelId, channel] of bot.allChannels) {
      if (seenChannels.has(channelId)) continue;
      seenChannels.add(channelId);

      let channelPurged = 0;
      while (true) {
        const messages = await channel.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;

        const ids = [...messages.keys()];
        if (ids.length === 1) {
          try {
            await messages.first().delete();
            channelPurged++;
          } catch {
            break; // can't delete — likely system message
          }
        } else {
          try {
            await channel.bulkDelete(ids, true);
            channelPurged += ids.length;
          } catch {
            // fallback: delete one by one
            for (const msg of messages.values()) {
              try { await msg.delete(); channelPurged++; } catch { /* skip */ }
            }
          }
        }
        process.stdout.write(`\r      Channel ${channelId}: ${channelPurged} messages deleted...`);
      }
      if (channelPurged > 0) {
        process.stdout.write(`\r      Channel ${channelId}: ${channelPurged} messages deleted.   \n`);
      } else {
        console.log(`      Channel ${channelId}: already empty.`);
      }
      totalPurged += channelPurged;
    }
  }
  console.log(`      Total purged: ${totalPurged} message(s).\n`);

  // 8. Clear database tables
  console.log('[4/4] Clearing database tables...');
  db.exec(`
    DELETE FROM file_parts;
    DELETE FROM shares;
    DELETE FROM files;
    DELETE FROM folders;
    DELETE FROM upload_stats;
    DELETE FROM gallery_sync;
  `);
  console.log('      Cleared: file_parts, shares, files, folders, upload_stats, gallery_sync');
  console.log('      Kept:    users, bug_reports\n');

  // 9. Cleanup
  await botPool.destroy();
  closeDatabase();

  console.log('========================================');
  console.log('  All Discordrive data has been wiped.');
  console.log('========================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
