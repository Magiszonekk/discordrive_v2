const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env file to access all configuration (3 levels up: src -> apps/backend -> apps -> discordrive root)
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

// Debug: Check if env vars are loaded
const originalTokenCount = Object.keys(process.env).filter(k => /^DISCORD_TOKEN(_\d+)?$/.test(k)).length;
console.log(`[Manager] Loaded .env: ${originalTokenCount} Discord tokens found`);

// Parse DISCORD_PROXIES from .env
const proxiesEnv = process.env.DISCORD_PROXIES || '';
const proxies = proxiesEnv
  .split(',')
  .map(p => p.trim())
  .filter(p => p.length > 0);

console.log(`[Manager] Found ${proxies.length} proxy(ies) in DISCORD_PROXIES`);

// Calculate instance count and bot distribution
const totalBots = originalTokenCount;
const totalInstances = 1 + proxies.length;
const botsPerInstance = Math.ceil(totalBots / totalInstances);

console.log(`[Manager] Distributing ${totalBots} bots across ${totalInstances} instance(s)`);
console.log(`[Manager] ~${botsPerInstance} bots per instance`);

// Available channels
const channels = [
  process.env.DISCORD_CHANNEL_ID,
  process.env.DISCORD_CHANNEL_2_ID,
].filter(Boolean);

// Generate INSTANCES array dynamically
const INSTANCES = [];
let botOffset = 1; // Start from bot 1
const basePort = 4001;

// Instance 1: Direct (no proxy)
const directBotCount = Math.min(botsPerInstance, totalBots);
const directBots = Array.from(
  { length: directBotCount },
  (_, i) => String(botOffset + i)
);

INSTANCES.push({
  id: 1,
  port: basePort,
  botTokens: directBots,
  channelId: channels[0 % channels.length], // Round-robin channels
  useProxychains: false,
});

botOffset += directBotCount;

// Instances 2+: One per proxy
proxies.forEach((proxyUrl, idx) => {
  const instanceId = idx + 2;
  const remainingBots = totalBots - botOffset + 1;
  const instanceBotCount = Math.min(botsPerInstance, remainingBots);

  const instanceBots = Array.from(
    { length: instanceBotCount },
    (_, i) => String(botOffset + i)
  );

  INSTANCES.push({
    id: instanceId,
    port: basePort + (idx + 1) * 10, // 4001, 4011, 4021, etc.
    botTokens: instanceBots,
    channelId: channels[(instanceId - 1) % channels.length],
    useProxychains: true,
    proxyUrl: proxyUrl,
    proxychainsConfig: `/tmp/proxychains-instance${instanceId}.conf`,
  });

  botOffset += instanceBotCount;
});

console.log(`[Manager] Generated ${INSTANCES.length} instance configuration(s)`);

// Function to generate proxychains config files dynamically
function generateProxychainsConfig(proxyUrl, configPath) {
  // Parse proxy URL: socks5h://127.0.0.1:49152
  const match = proxyUrl.match(/^(socks5h?|http|https):\/\/([^:]+):(\d+)$/);

  if (!match) {
    throw new Error(`Invalid proxy URL format: ${proxyUrl}`);
  }

  const [, protocol, host, port] = match;

  // Map protocol names (socks5h → socks5 for proxychains)
  const pcProtocol = protocol.replace('socks5h', 'socks5');

  const config = `# Auto-generated proxychains configuration
strict_chain
proxy_dns

[ProxyList]
${pcProtocol} ${host} ${port}
`;

  fs.writeFileSync(configPath, config, 'utf-8');
  console.log(`[Manager] Generated proxychains config: ${configPath}`);
}

function startInstance(config) {
  const env = { ...process.env };

  // Skip dotenv loading (we're managing env vars manually)
  env.SKIP_DOTENV = 'true';

  // Override port for this instance
  env.PORT = config.port.toString();

  // In multi-instance mode: set upload channel override so each instance uploads only to its assigned
  // channel, while still having read access to ALL channels (for fetchMessage/healthcheck).
  // In single-instance mode (no proxies): no override needed, native multi-channel logic handles it.
  if (INSTANCES.length > 1) {
    env.DISCORD_UPLOAD_CHANNEL_ID = config.channelId;
    // Remove DISCORD_PROXIES — proxy routing is handled by proxychains at OS level.
    // Without this, BotPool applies SocksProxyAgent on top of proxychains (double proxy),
    // breaking WebSocket connections for even-numbered bots.
    delete env.DISCORD_PROXIES;
    // Sibling URLs: all OTHER instances (for cross-instance message fallback)
    const siblingUrls = INSTANCES
      .filter(inst => inst.id !== config.id)
      .map(inst => `http://127.0.0.1:${inst.port}`)
      .join(',');
    env.SIBLING_INSTANCE_URLS = siblingUrls;
  }

  // Filter Discord tokens - only include bots for this instance
  const allTokenKeys = Object.keys(process.env)
    .filter(k => /^DISCORD_TOKEN(_\d+)?$/.test(k));

  // Clear all token env vars first
  allTokenKeys.forEach(key => delete env[key]);

  // Re-add only the tokens for this instance's bots
  config.botTokens.forEach((tokenNum, idx) => {
    const sourceKey = tokenNum === '1' ? 'DISCORD_TOKEN' : `DISCORD_TOKEN_${tokenNum}`;
    const targetKey = idx === 0 ? 'DISCORD_TOKEN' : `DISCORD_TOKEN_${idx + 1}`;

    if (process.env[sourceKey]) {
      env[targetKey] = process.env[sourceKey];
    }
  });

  // Debug: Log env vars being passed
  const tokenKeys = Object.keys(env).filter(k => /^DISCORD_TOKEN(_\d+)?$/.test(k));
  const channelKeys = Object.keys(env).filter(k => /^DISCORD_CHANNEL(_\d+)?_ID$/.test(k));
  console.log(`[Manager] Instance ${config.id} env: ${tokenKeys.length} tokens, ${channelKeys.length} channels`);
  console.log(`[Manager]   DISCORD_TOKEN=${env.DISCORD_TOKEN ? 'SET' : 'MISSING'}, DISCORD_CHANNEL_ID=${env.DISCORD_CHANNEL_ID ? 'SET' : 'MISSING'}`);

  // Determine command and args
  let command, args;

  if (config.useProxychains) {
    // Wrap Node process with proxychains
    command = 'proxychains4';
    args = ['-f', config.proxychainsConfig, 'node', 'src/index.js'];
    console.log(`[Manager] Instance ${config.id}: Port ${config.port}, Bots ${config.botTokens.join(',')}, Proxy: ${config.proxyUrl}`);
  } else {
    // Direct Node process
    command = 'node';
    args = ['src/index.js'];
    console.log(`[Manager] Instance ${config.id}: Port ${config.port}, Bots ${config.botTokens.join(',')}, Proxy: NONE (direct)`);
  }

  const proc = spawn(command, args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit', // Forward stdout/stderr to parent
  });

  proc.on('exit', (code) => {
    console.error(`[Manager] Instance ${config.id} exited with code ${code}`);
    console.error(`[Manager] Restarting instance ${config.id} in 5 seconds...`);
    setTimeout(() => startInstance(config), 5000);
  });

  proc.on('error', (err) => {
    console.error(`[Manager] Instance ${config.id} failed to start:`, err.message);
  });

  return proc;
}

// Graceful shutdown handler
process.on('SIGINT', () => {
  console.log('\n[Manager] Received SIGINT, shutting down all instances...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Manager] Received SIGTERM, shutting down all instances...');
  process.exit(0);
});

// Generate proxychains configs for all proxy instances
INSTANCES
  .filter(inst => inst.useProxychains)
  .forEach(inst => {
    generateProxychainsConfig(inst.proxyUrl, inst.proxychainsConfig);
  });

// Start all instances
console.log('[Manager] ========================================');
console.log('[Manager] Multi-Instance Discordrive Backend');
console.log('[Manager] ========================================');
INSTANCES.forEach(startInstance);
console.log('[Manager] All instances started. Press Ctrl+C to stop.');
