'use strict';

/**
 * mario-remote-bridge — server.js
 *
 * Due porte:
 *   AGENT_PORT (default 7001) — WebSocket: il Pi si connette qui (outbound dal Pi)
 *   RELAY_PORT (default 7002) — HTTP: mario-web chiama qui per inviare comandi al Pi
 *
 * Env obbligatori (produzione):
 *   BRIDGE_AGENT_TOKEN   token segreto che il Pi usa per autenticarsi
 *   BRIDGE_RELAY_TOKEN   token segreto che mario-web usa per autenticarsi
 *
 * Flusso:
 *   Pi  → WS connect (BRIDGE_AGENT_TOKEN)
 *   Web → POST /relay (BRIDGE_RELAY_TOKEN) → WS → Pi → hub → risposta → Web
 */

const http    = require('http');
const crypto  = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Crea e avvia il bridge.
 * @param {object} opts
 * @param {number}  opts.agentPort
 * @param {number}  opts.relayPort
 * @param {string}  opts.relayHost
 * @param {string}  opts.agentToken
 * @param {string}  opts.relayToken
 * @param {number}  opts.relayTimeoutMs
 * @returns {{ wss: WebSocketServer, relayServer: http.Server, close: () => void }}
 */
function createBridgeServer({
  agentPort       = 7001,
  relayPort       = 7002,
  relayHost       = '127.0.0.1',
  agentToken      = '',
  relayToken      = '',
  relayTimeoutMs  = 10_000,
} = {}) {
  /** Socket WebSocket del Pi agent attualmente connesso (uno solo). */
  let agentSocket = null;

  /** Richieste in attesa di risposta dal Pi. id → { resolve, reject, timer } */
  const pending = new Map();

  // ── Relay core ─────────────────────────────────────────────────────────────

  function relay({ method, path, headers = {}, body = null }) {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('agent_disconnected'));
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, relayTimeoutMs);

      pending.set(id, { resolve, reject, timer });

      agentSocket.send(JSON.stringify({ id, method, path, headers, body }), (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── WebSocket server — porta agentPort ─────────────────────────────────────

  const wss = new WebSocketServer({ port: agentPort });

  wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';

    if (agentToken && token !== agentToken) {
      console.log('[bridge] agent rifiutato: token non valido');
      ws.close(1008, 'unauthorized');
      return;
    }

    console.log('[bridge] Pi agent connesso da', req.socket.remoteAddress);

    // Disconnetti agente precedente
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      agentSocket.close(1001, 'replaced');
    }
    agentSocket = ws;

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const entry = pending.get(msg.id);
      if (!entry) return;

      clearTimeout(entry.timer);
      pending.delete(msg.id);
      entry.resolve(msg);
    });

    ws.on('close', () => {
      console.log('[bridge] Pi agent disconnesso');
      if (agentSocket === ws) agentSocket = null;

      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('agent_disconnected'));
        pending.delete(id);
      }
    });

    ws.on('error', (err) => {
      console.error('[bridge] WS error:', err.message);
    });
  });

  wss.on('listening', () => {
    console.log(`[bridge] WS agent     → ws://0.0.0.0:${agentPort}`);
  });

  // ── HTTP relay server — porta relayPort ────────────────────────────────────

  const relayServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agent_connected:  agentSocket !== null && agentSocket.readyState === WebSocket.OPEN,
        pending_requests: pending.size,
        ts:               new Date().toISOString(),
      }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/relay') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const auth = req.headers['authorization'] || '';
    if (relayToken && auth !== `Bearer ${relayToken}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(rawBody); } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      try {
        const result = await relay(payload);
        const ct = (result.headers || {})['content-type'] || 'application/json';
        res.writeHead(result.status, { 'Content-Type': ct });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      } catch (err) {
        const status = err.message === 'agent_disconnected' ? 503 : 504;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: err.message.toUpperCase() }));
      }
    });
  });

  relayServer.listen(relayPort, relayHost, () => {
    console.log(`[bridge] HTTP relay   → http://${relayHost}:${relayPort}`);
  });

  function close() {
    wss.close();
    relayServer.close();
  }

  return { wss, relayServer, close };
}

module.exports = { createBridgeServer };

// ── Entry point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  require('dotenv').config();

  const AGENT_TOKEN = process.env.BRIDGE_AGENT_TOKEN || '';
  const RELAY_TOKEN = process.env.BRIDGE_RELAY_TOKEN || '';

  if (!AGENT_TOKEN || !RELAY_TOKEN) {
    console.error('[bridge] ERRORE: BRIDGE_AGENT_TOKEN e BRIDGE_RELAY_TOKEN obbligatori');
    process.exit(1);
  }

  createBridgeServer({
    agentPort:      parseInt(process.env.AGENT_PORT       || '7001', 10),
    relayPort:      parseInt(process.env.RELAY_PORT       || '7002', 10),
    relayHost:      process.env.RELAY_HOST                || '127.0.0.1',
    agentToken:     AGENT_TOKEN,
    relayToken:     RELAY_TOKEN,
    relayTimeoutMs: parseInt(process.env.RELAY_TIMEOUT_MS || '10000', 10),
  });
}
