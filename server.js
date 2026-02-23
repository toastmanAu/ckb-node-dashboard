#!/usr/bin/env node
// CKB Dashboard server — serves static files + proxies /rpc + serves /history
// Usage: node server.js

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Crash guards — log and survive rather than die ────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', new Date().toISOString(), err.message);
  // Port conflict or other fatal bind errors — don't try to continue
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error(`[fatal] Cannot bind port — exiting.`);
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', new Date().toISOString(), reason?.message ?? reason);
});

const PORT        = 8080;
const CKB_HOST    = '192.168.68.87';
const CKB_PORT    = 8114;
const PROXY_HOST  = '127.0.0.1';
const PROXY_PORT  = 8081;
const FIBER_CKB_HOST  = '192.168.68.87'; // SSH tunnel: n100:8237 → ckbnode:8227
const FIBER_N100_HOST = '192.168.68.91';
const FIBER_CKB_PORT  = 8237;            // via SSH tunnel on N100
const FIBER_N100_PORT = 8226;
const N100_HOST       = '192.168.68.91';
const DIR         = __dirname;

// ── Internal CKB RPC helpers ──────────────────────────────────────────────
let rpcId = 1;

const CKB_TIMEOUT_MS = 10000; // 10s — abort if CKB node hangs

function ckbRequest(bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: CKB_HOST, port: CKB_PORT, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: CKB_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('CKB node request timed out')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function rpcCall(method, params = []) {
  return ckbRequest({ jsonrpc: '2.0', id: rpcId++, method, params })
    .then(r => { if (r.error) throw new Error(r.error.message); return r.result; });
}

function rpcBatch(requests) {
  const batch = requests.map((r, i) => ({ jsonrpc: '2.0', id: i, method: r.method, params: r.params || [] }));
  return ckbRequest(batch).then(results => {
    if (!Array.isArray(results)) throw new Error('Expected batch array response');
    return results.sort((a, b) => a.id - b.id).map(r => r.result);
  });
}

// ── History cache ─────────────────────────────────────────────────────────
let histCache     = null;
let histCacheTime = 0;
const HIST_TTL    = 15000;  // 15s cache
const HIST_COUNT  = 60;     // 60 blocks of header history
const TX_COUNT    = 30;     // last 30 blocks get full tx counts

function formatHashrate(h) {
  // h is BigInt H/s
  const units = [
    [10n ** 18n, 'EH/s'],
    [10n ** 15n, 'PH/s'],
    [10n ** 12n, 'TH/s'],
    [10n **  9n, 'GH/s'],
    [10n **  6n, 'MH/s'],
    [10n **  3n, 'kH/s'],
    [1n,          'H/s'],
  ];
  for (const [div, unit] of units) {
    if (h >= div) {
      const val = Number(h * 1000n / div) / 1000;
      return val.toFixed(2) + ' ' + unit;
    }
  }
  return String(h) + ' H/s';
}

async function buildHistory() {
  const now = Date.now();
  if (histCache && (now - histCacheTime) < HIST_TTL) return histCache;

  // Fetch tip + blockchain info in parallel
  const [tipHeader, chainInfo] = await Promise.all([
    rpcCall('get_tip_header'),
    rpcCall('get_blockchain_info'),
  ]);

  const tipNum  = parseInt(tipHeader.number, 16);
  const count   = Math.min(HIST_COUNT, tipNum + 1);
  const start   = tipNum - count + 1;

  // Batch-fetch headers for block time history
  const headers = await rpcBatch(
    Array.from({ length: count }, (_, i) => ({
      method: 'get_header_by_number',
      params: ['0x' + (start + i).toString(16)],
    }))
  );

  // Batch-fetch full blocks for tx counts (last TX_COUNT blocks)
  // Note: no verbosity param — CKB node returns full block JSON by default
  const txFetchCount = Math.min(TX_COUNT, count);
  const blocks = await rpcBatch(
    Array.from({ length: txFetchCount }, (_, i) => ({
      method: 'get_block_by_number',
      params: ['0x' + (tipNum - txFetchCount + 1 + i).toString(16)],
    }))
  );

  // Build tx count map: block_number → tx_count
  const txMap = {};
  blocks.forEach(b => {
    if (b && b.header) {
      const n = parseInt(b.header.number, 16);
      // transactions array includes coinbase; subtract 1 for "real" txs
      txMap[n] = Math.max(0, (b.transactions?.length ?? 1) - 1);
    }
  });

  // Build per-block data (skip first block — no previous timestamp to diff against)
  const blockData = [];
  for (let i = 1; i < headers.length; i++) {
    const h    = headers[i];
    const prev = headers[i - 1];
    if (!h || !prev) continue;
    const num       = parseInt(h.number, 16);
    const ts        = parseInt(h.timestamp, 16);
    const prevTs    = parseInt(prev.timestamp, 16);
    const blockTime = ts - prevTs;  // ms
    blockData.push({
      number:    num,
      timestamp: ts,
      txCount:   txMap[num] ?? null,
      blockTime: blockTime,
    });
  }

  // Avg block time over last 20 blocks
  const recent  = blockData.slice(-20);
  const avgMs   = recent.reduce((s, b) => s + b.blockTime, 0) / (recent.length || 1);
  const avgSec  = avgMs / 1000;

  // Network hashrate = difficulty / avg_block_time
  let hashrateStr    = '—';
  let hashratePerBlock = []; // [{number, hashrate_str}]
  try {
    const diff    = BigInt('0x' + chainInfo.difficulty.replace(/^0x/, ''));
    // Overall current hashrate
    const hrBig   = diff / BigInt(Math.max(1, Math.round(avgSec)));
    hashrateStr   = formatHashrate(hrBig);

    // Per-block hashrate estimate (rolling 10-block avg block time)
    const window = 10;
    for (let i = window; i < blockData.length; i++) {
      const slice  = blockData.slice(i - window, i);
      const wAvgMs = slice.reduce((s, b) => s + b.blockTime, 0) / slice.length;
      const wAvgS  = wAvgMs / 1000;
      const wHr    = wAvgS > 0 ? diff / BigInt(Math.max(1, Math.round(wAvgS))) : 0n;
      hashratePerBlock.push({ number: blockData[i].number, hashrate: Number(wHr / 10n ** 12n) }); // TH/s
    }
  } catch(e) { /* BigInt not available — skip */ }

  histCache = {
    blocks:          blockData,
    avgBlockTimeSec: avgSec.toFixed(2),
    networkHashrate: hashrateStr,
    hashratePerBlock,
    tipHeight:       tipNum,
  };
  histCacheTime = now;
  return histCache;
}

// ── Proxy a single/batch RPC call to the CKB node ────────────────────────
function proxyRpc(body, res) {
  const opts = {
    hostname: CKB_HOST, port: CKB_PORT, path: '/', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = http.request(opts, (ckbRes) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    ckbRes.pipe(res);
  });
  req.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: -32000, message: e.message } }));
  });
  req.write(body);
  req.end();
}

// ── Show data aggregator ──────────────────────────────────────────────────
// Fetches all service states and returns a unified JSON blob for show.html

function httpGet(hostname, port, path, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ _raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function httpPost(hostname, port, path, bodyObj, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      hostname, port, path, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

async function safeGet(hostname, port, path, timeout) {
  try { return await httpGet(hostname, port, path, timeout); }
  catch(e) { return null; }
}

async function safePost(hostname, port, path, body, timeout) {
  try { return await httpPost(hostname, port, path, body, timeout); }
  catch(e) { return null; }
}

let showDataCache     = null;
let showDataCacheTime = 0;
const SHOW_TTL        = 8000; // 8s cache

async function buildShowData() {
  const now = Date.now();
  if (showDataCache && (now - showDataCacheTime) < SHOW_TTL) return showDataCache;

  // Parallel fetch everything
  const [
    hist,
    mining,
    peers,
    dashHealth,
    uvHealth,
    fiberCkbInfo,
    fiberN100Info,
    antiscamPs,
  ] = await Promise.all([
    buildHistory().catch(() => null),
    safeGet(PROXY_HOST, PROXY_PORT, '/', 3000),
    rpcCall('get_peers').catch(() => null),
    safeGet('127.0.0.1', PORT, '/health', 2000),
    safeGet('127.0.0.1', 9988, '/', 2000),
    // Fiber ckbnode RPC via SSH tunnel (N100:8237 → ckbnode:8227)
    safePost(N100_HOST, FIBER_CKB_PORT, '/', { id: 1, jsonrpc: '2.0', method: 'get_node_info', params: [] }, 3000),
    // Fiber N100 local RPC
    safePost('127.0.0.1', FIBER_N100_PORT, '/', { id: 1, jsonrpc: '2.0', method: 'get_node_info', params: [] }, 3000),
    // Anti-scam: check process via existence of PID file or log
    safeGet('127.0.0.1', 9999, '/health', 1000), // antiscam has no HTTP, will fail = null
  ]);

  // Fiber channels
  const [fiberCkbChannels, fiberN100Channels] = await Promise.all([
    safePost(N100_HOST, FIBER_CKB_PORT, '/', { id: 2, jsonrpc: '2.0', method: 'list_channels', params: [{}] }, 3000),
    safePost('127.0.0.1', FIBER_N100_PORT, '/', { id: 2, jsonrpc: '2.0', method: 'list_channels', params: [{}] }, 3000),
  ]);

  // Parse epoch from hist
  let epochNum, epochPct;
  if (hist) {
    // epoch field from /history is in tip header — re-fetch from rpc
    try {
      const tip = await rpcCall('get_tip_header');
      const epochHex = tip.epoch; // e.g. 0x5440242003592
      // epoch encoding: bits [0:15] = block index in epoch, [16:31] = epoch length, [32:47] = epoch number
      const epochVal = BigInt('0x' + epochHex.replace(/^0x/,''));
      epochNum = Number((epochVal >> 32n) & 0xFFFFn);
      const idx    = Number(epochVal & 0xFFFFn);
      const length = Number((epochVal >> 16n) & 0xFFFFn);
      epochPct = length > 0 ? idx / length : 0;
    } catch(e) { /* skip */ }
  }

  // Whale bot: check if process is running (via PID file)
  let whaleBotRunning = false;
  try {
    const pid = require('fs').readFileSync('/home/phill/ckb-whale-bot/whale-bot.pid', 'utf8').trim();
    require('fs').accessSync('/proc/' + pid);
    whaleBotRunning = true;
  } catch(e) { whaleBotRunning = false; }

  // Anti-scam: check log file recency (updated = running)
  let antiScamRunning = false;
  try {
    const stat = require('fs').statSync('/home/phill/ckb-antiscam/antiscam.log');
    // If log was modified in last 2 hours, consider it running
    antiScamRunning = (Date.now() - stat.mtimeMs) < 2 * 60 * 60 * 1000;
  } catch(e) { antiScamRunning = false; }

  const result = {
    node: hist ? {
      tipHeight:       hist.tipHeight,
      avgBlockTimeSec: hist.avgBlockTimeSec,
      networkHashrate: hist.networkHashrate,
      epochNum,
      epochPct,
      peers: Array.isArray(peers) ? peers.length : null,
    } : null,

    mining: mining || null,

    services: {
      dashboard: !!dashHealth?.ok,
      stratum:   !!(mining && mining.nodeHealthy !== false),
      whaleBot:  whaleBotRunning,
      uvTracker: !!uvHealth,
      fiberCkb:  !!(fiberCkbInfo?.result),
      fiberN100: !!(fiberN100Info?.result),
      antiScam:  antiScamRunning,
    },

    fiber: {
      ckbNodeRunning: !!(fiberCkbInfo?.result),
      n100Running:    !!(fiberN100Info?.result),
      ckbPeers:       fiberCkbInfo?.result?.connected_peers ?? null,
      n100Peers:      fiberN100Info?.result?.connected_peers ?? null,
      ckbChannels:    fiberCkbChannels?.result?.channels?.length ?? null,
      n100Channels:   fiberN100Channels?.result?.channels?.length ?? null,
    },

    dashUptime: dashHealth ? formatUptime(dashHealth.uptime) : '—',
  };

  showDataCache     = result;
  showDataCacheTime = now;
  return result;
}

function formatUptime(secs) {
  if (!secs) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Static file server ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon',
};

function serveStatic(reqPath, res) {
  const filePath = path.join(DIR, reqPath === '/' ? 'index.html' : reqPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── Main server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.url === '/history' && req.method === 'GET') {
    buildHistory()
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()) }));
    return;
  }

  if (req.url === '/show' && req.method === 'GET') {
    serveStatic('/show.html', res);
    return;
  }

  if (req.url === '/api/show-data' && req.method === 'GET') {
    buildShowData()
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (req.url === '/rpc' && req.method === 'POST') {
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 64 * 1024; // 64 KB
    req.on('data', d => {
      bodySize += d.length;
      if (bodySize > MAX_BODY) { req.destroy(); return; }
      body += d;
    });
    req.on('end', () => proxyRpc(body, res));
    return;
  }

  if (req.url === '/mining' && req.method === 'GET') {
    const proxyReq = http.request({
      hostname: PROXY_HOST, port: PROXY_PORT, path: '/', method: 'GET',
      timeout: 5000,
    }, (proxyRes) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Solo proxy offline', status: 'offline' }));
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Solo proxy timeout', status: 'offline' }));
    });
    proxyReq.end();
    return;
  }

  serveStatic(req.url, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CKB dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Proxying /rpc → http://${CKB_HOST}:${CKB_PORT}`);
  // Pre-warm the history cache
  buildHistory().catch(e => console.warn('History pre-warm failed:', e.message));
});
