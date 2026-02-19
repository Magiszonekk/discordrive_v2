// Test if node-global-proxy works with SOCKS5
const proxy = require('node-global-proxy').default;

console.log('[Test] Testing node-global-proxy with SOCKS5...');

const proxyUrl = 'socks5h://127.0.0.1:49152';

try {
  proxy.setConfig({
    http: proxyUrl,
    https: proxyUrl,
  });

  proxy.start();

  console.log('[Test] ✅ Global proxy started');
  console.log('[Test] Config:', proxy.getConfig());

  // Test basic HTTP request
  const https = require('https');

  https.get('https://ifconfig.me', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log('[Test] ✅ HTTP request via proxy successful');
      console.log('[Test] External IP:', data.trim());

      // Clean up
      proxy.stop();
      console.log('[Test] Proxy stopped');
    });
  }).on('error', (err) => {
    console.error('[Test] ❌ HTTP request failed:', err.message);
    proxy.stop();
  });

} catch (err) {
  console.error('[Test] ❌ Failed to start proxy:', err.message);
}
