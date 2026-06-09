'use strict';

/**
 * mario-remote-bridge — client.js
 *
 * Gira sul Pi come servizio systemd standalone.
 * Apre connessione WebSocket outbound verso il bridge (VPS).
 * Riceve richieste HTTP dal bridge, le forwarda all'hub locale, risponde.
 *
 * Env obbligatori:
 *   MARIO_BRIDGE_URL     URL WebSocket del bridge  (es. ws://bridge.example.it:7001)
 *   MARIO_BRIDGE_TOKEN   Token agente (deve corrispondere a BRIDGE_AGENT_TOKEN sul server)
 *
 * Env opzionali:
 *   HUB_ID               Identificatore univoco di questo impianto (default: "default")
 *   HUB_URL              URL dell'hub locale  (default: http://localhost:4001)
 *   RECONNECT_DELAY_MS   Attesa base prima di riconnettersi  (default: 5000)
 *   MAX_RECONNECT_MS     Attesa massima tra riconnessioni    (default: 60000)
 */

const http   = require('http');
const https  = require('https');
const { WebSocket } = require('ws');

// ── Connessione al bridge ──────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  opts.bridgeUrl
 * @param {string}  opts.bridgeToken
 * @param {string}  opts.hubId           identificatore univoco impianto (default: "default")
 * @param {string}  opts.hubUrl
 * @param {number}  opts.reconnectDelayMs
 * @param {number}  opts.maxReconnectMs
 * @returns {{ stop: () => void }}
 */
function createBridgeClient({
  bridgeUrl,
  bridgeToken      = '',
  hubId            = 'default',
  hubUrl           = 'http://localhost:4001',
  reconnectDelayMs = 5_000,
  maxReconnectMs   = 60_000,
} = {}) {
  if (!bridgeUrl) throw new Error('bridgeUrl obbligatorio');

  let ws         = null;
  let delay      = reconnectDelayMs;
  let stopped    = false;
  let reconnTimer = null;

  function connect() {
    if (stopped) return;

    const params = new URLSearchParams();
    if (bridgeToken) params.set('token', bridgeToken);
    if (hubId)       params.set('hub_id', hubId);
    const qs = params.toString();
    const url = bridgeUrl + (qs ? `?${qs}` : '');

    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[bridge-client] connesso hub_id="${hubId}" → ${bridgeUrl}`);
      delay = reconnectDelayMs; // reset backoff
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      const { id } = msg;
      if (!id) return;

      try {
        const result = await forwardToHub(hubUrl, msg);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, ...result }));
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            id,
            status:       503,
            headers:      { 'content-type': 'application/json' },
            body:         JSON.stringify({ error: err.message }),
          }));
        }
      }
    });

    ws.on('close', (code) => {
      console.log(`[bridge-client] disconnesso (${code}) — riconnessione tra ${delay}ms`);
      if (!stopped) {
        reconnTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, maxReconnectMs);
      }
    });

    ws.on('error', (err) => {
      console.error('[bridge-client] errore:', err.message);
      // 'close' seguirà automaticamente
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnTimer);
    if (ws) ws.close();
  }

  connect();
  return { stop };
}

// ── Forward HTTP verso l'hub locale ──────────────────────────────────────────

/**
 * Invia la richiesta all'hub locale e restituisce la risposta.
 * @param {string} hubUrl
 * @param {{ method:string, path:string, headers?:object, body?:string|null }} msg
 * @returns {Promise<{ status:number, headers:object, body:string }>}
 */
function forwardToHub(hubUrl, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(hubUrl + path);
    const lib = u.protocol === 'https:' ? https : http;

    const reqHeaders = {
      'content-type': 'application/json',
      ...Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      ),
    };

    const options = {
      hostname: u.hostname,
      port:     Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      path:     u.pathname + u.search,
      method:   (method || 'GET').toUpperCase(),
      headers:  reqHeaders,
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status:  res.statusCode || 200,
        headers: { 'content-type': res.headers['content-type'] || 'application/json' },
        body:    raw,
      }));
    });

    req.on('error', reject);
    req.setTimeout(8_000, () => req.destroy(new Error('Hub timeout')));

    const m = options.method;
    if (body !== null && (m === 'POST' || m === 'PUT' || m === 'PATCH')) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

module.exports = { createBridgeClient, forwardToHub };

// ── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  require('dotenv').config();

  const BRIDGE_URL   = process.env.MARIO_BRIDGE_URL   || '';
  const BRIDGE_TOKEN = process.env.MARIO_BRIDGE_TOKEN || '';
  const HUB_ID       = process.env.HUB_ID             || 'default';
  const HUB_URL      = process.env.HUB_URL            || 'http://localhost:4001';

  if (!BRIDGE_URL) {
    console.error('[bridge-client] MARIO_BRIDGE_URL non impostato — uscita');
    process.exit(1);
  }

  createBridgeClient({
    bridgeUrl:        BRIDGE_URL,
    bridgeToken:      BRIDGE_TOKEN,
    hubId:            HUB_ID,
    hubUrl:           HUB_URL,
    reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS || '5000', 10),
    maxReconnectMs:   parseInt(process.env.MAX_RECONNECT_MS   || '60000', 10),
  });

  console.log(`[bridge-client] avviato hub_id="${HUB_ID}" → ${BRIDGE_URL}`);
}
