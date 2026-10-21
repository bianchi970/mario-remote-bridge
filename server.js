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
 * Multi-hub: ogni Pi si identifica con hub_id (query param WS).
 * Il relay payload include hub_id facoltativo per instradare al Pi corretto.
 * Backward compat: se hub_id assente e c'è un solo Pi connesso, usa quello.
 *
 * Flusso:
 *   Pi  → WS connect ?token=TOKEN&hub_id=ID
 *   Web → POST /relay { hub_id?, method, path, headers, body }
 *      → WS → Pi → hub → risposta → Web
 */

const http    = require('http');
const crypto  = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Crea e avvia il bridge.
 * @param {object} opts
 * @param {number}  opts.agentPort
 * @param {string}  opts.agentHost
 * @param {number}  opts.relayPort
 * @param {string}  opts.relayHost
 * @param {string}  opts.agentToken
 * @param {string}  opts.relayToken
 * @param {number}  opts.relayTimeoutMs
 * @returns {{ wss: WebSocketServer, relayServer: http.Server, close: () => void }}
 */
function createBridgeServer({
  agentPort       = 7001,
  agentHost       = '127.0.0.1',
  relayPort       = 7002,
  relayHost       = '127.0.0.1',
  agentToken      = '',
  relayToken      = '',
  relayTimeoutMs  = 10_000,
} = {}) {
  /** Map<hub_id, WebSocket> — un socket per Pi registrato. */
  const agents = new Map();

  /** Richieste in attesa di risposta. id → { resolve, reject, timer, ws } */
  const pending = new Map();

  // ── Relay core ─────────────────────────────────────────────────────────────

  // Route AI richiedono più tempo per la pipeline Ollama/Gemma (~90 s).
  const AI_RELAY_PATHS   = ['/brain/interpret', '/brain/diagnose'];
  const AI_RELAY_TIMEOUT = 130_000;

  function relay({ hub_id, method, path, headers = {}, body = null }) {
    let socket = null;

    if (hub_id) {
      socket = agents.get(hub_id) || null;
    } else if (agents.size === 1) {
      // backward compat: un solo Pi connesso, usalo
      socket = agents.values().next().value;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('agent_disconnected'));
    }

    const id = crypto.randomUUID();
    const ms = AI_RELAY_PATHS.some(p => (path || '').includes(p)) ? AI_RELAY_TIMEOUT : relayTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, ms);

      pending.set(id, { resolve, reject, timer, ws: socket });

      socket.send(JSON.stringify({ id, method, path, headers, body }), (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── WebSocket server — porta agentPort ─────────────────────────────────────

  const wss = new WebSocketServer({ port: agentPort, host: agentHost });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const hubId  = url.searchParams.get('hub_id') || 'default';

    // Auth: solo l'intestazione Bearer. Il token nell'indirizzo (`?token=`) finiva
    // nei log di nginx, e dal 21/10/2026 il client non lo manda più: chi lo
    // manda ancora lì non entra (prima era accettato «per compatibilità»).
    const authHeader  = (req.headers['authorization'] || '');
    const token       = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (agentToken && token !== agentToken) {
      ws.close(1008, 'unauthorized');
      return;
    }

    console.log(`[bridge] Pi agent connesso hub_id="${hubId}" da ${req.socket.remoteAddress}`);

    // Disconnetti agente precedente per lo stesso hub_id
    if (agents.has(hubId)) {
      const old = agents.get(hubId);
      if (old.readyState === WebSocket.OPEN) old.close(1001, 'replaced');
    }
    agents.set(hubId, ws);

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
      console.log(`[bridge] Pi agent disconnesso hub_id="${hubId}"`);
      if (agents.get(hubId) === ws) agents.delete(hubId);

      // Rigetta solo le pending di questo ws
      for (const [id, entry] of pending) {
        if (entry.ws === ws) {
          clearTimeout(entry.timer);
          entry.reject(new Error('agent_disconnected'));
          pending.delete(id);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[bridge] WS error:', err.message);
    });
  });

  wss.on('listening', () => {
    console.log(`[bridge] WS agent     → ws://${agentHost}:${agentPort}`);
  });

  // ── HTTP relay server — porta relayPort ────────────────────────────────────

  const relayServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agent_connected:  agents.size > 0,          // backward compat
        agents_connected: agents.size,
        hub_ids:          [...agents.keys()],
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
    agentHost:      process.env.AGENT_HOST                || '127.0.0.1',
    relayPort:      parseInt(process.env.RELAY_PORT       || '7002', 10),
    relayHost:      process.env.RELAY_HOST                || '127.0.0.1',
    agentToken:     AGENT_TOKEN,
    relayToken:     RELAY_TOKEN,
    relayTimeoutMs: parseInt(process.env.RELAY_TIMEOUT_MS || '10000', 10),
  });
}
