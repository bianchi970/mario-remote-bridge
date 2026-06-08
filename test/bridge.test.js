'use strict';

/**
 * test/bridge.test.js — test end-to-end del bridge relay
 *
 * Avvia server su porte casuali, connette un Pi mock, verifica i casi principali.
 */

const http = require('http');
const { WebSocket } = require('ws');
const { createBridgeServer } = require('../server');

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`OK ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function startServer(opts) {
  return new Promise((resolve) => {
    const bridge = createBridgeServer(opts);
    // aspetta che entrambe le porte siano in ascolto
    bridge.relayServer.once('listening', () => resolve(bridge));
  });
}

function connectPi(agentPort, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${agentPort}${token ? `?token=${token}` : ''}`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function getPort(server) {
  return server.address().port;
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function run() {
  const AGENT_TOKEN = 'secret-agent';
  const RELAY_TOKEN = 'secret-relay';

  // ── Setup: bridge su porte casuali ───────────────────────────────────────
  const bridge = await startServer({
    agentPort:     0,      // OS sceglie
    relayPort:     0,
    relayHost:     '127.0.0.1',
    agentToken:    AGENT_TOKEN,
    relayToken:    RELAY_TOKEN,
    relayTimeoutMs: 500,   // breve per i test
  });

  const agentPort = getPort(bridge.wss.address() ? bridge.wss : { address: () => ({ port: 0 }) });
  const relayPort = getPort(bridge.relayServer);

  // wss port: WebSocketServer non ha .address() standard — lo ricaviamo dall'opzione
  // Usiamo il fatto che wss è passato port:0 → recuperiamo dalla wss stessa
  const wsPort = bridge.wss._server ? bridge.wss._server.address().port : agentPort;

  // ── 1. Status iniziale ────────────────────────────────────────────────────
  const status1 = await httpGet(relayPort, '/status');
  ok('status 200', status1.status === 200);
  ok('agent_connected false inizialmente', JSON.parse(status1.body).agent_connected === false);

  // ── 2. Relay senza Pi → 503 ──────────────────────────────────────────────
  const r503 = await httpPost(relayPort, '/relay',
    { method: 'GET', path: '/api/hub/health' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('relay 503 senza Pi', r503.status === 503);

  // ── 3. Token relay errato → 401 ──────────────────────────────────────────
  const r401 = await httpPost(relayPort, '/relay',
    { method: 'GET', path: '/api/hub/health' },
    { Authorization: 'Bearer WRONG' },
  );
  ok('relay 401 token errato', r401.status === 401);

  // ── 4. JSON malformato → 400 ─────────────────────────────────────────────
  const r400 = await new Promise((resolve) => {
    const payload = 'NOT JSON';
    const req = http.request({
      hostname: '127.0.0.1', port: relayPort, path: '/relay', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length,
                 Authorization: `Bearer ${RELAY_TOKEN}` },
    }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.write(payload);
    req.end();
  });
  ok('relay 400 json malformato', r400.status === 400);

  // ── 5. Pi con token sbagliato → chiuso dal server ────────────────────────
  const badPi = new WebSocket(`ws://127.0.0.1:${wsPort}?token=WRONG`);
  const badClose = await new Promise((resolve) => badPi.on('close', (code) => resolve(code)));
  ok('Pi token errato → chiusura 1008', badClose === 1008);

  // ── 6. Pi si connette con token corretto ─────────────────────────────────
  const piWs = await connectPi(wsPort, AGENT_TOKEN);
  ok('Pi connesso', piWs.readyState === WebSocket.OPEN);

  // ── 7. Status mostra agent_connected = true ──────────────────────────────
  await new Promise((r) => setTimeout(r, 50)); // lascia propagare
  const status2 = await httpGet(relayPort, '/status');
  ok('agent_connected true dopo connessione', JSON.parse(status2.body).agent_connected === true);

  // ── 8-10. Relay E2E ───────────────────────────────────────────────────────
  piWs.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    piWs.send(JSON.stringify({
      id:           msg.id,
      status:       200,
      headers:      { 'content-type': 'application/json' },
      body:         JSON.stringify({ ok: true, echoed_path: msg.path, echoed_method: msg.method }),
    }));
  });

  const relayOk = await httpPost(relayPort, '/relay',
    { method: 'GET', path: '/api/hub/devices' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('relay E2E status 200', relayOk.status === 200);
  const rb = JSON.parse(relayOk.body);
  ok('relay E2E path preservato', rb.echoed_path === '/api/hub/devices');
  ok('relay E2E method preservato', rb.echoed_method === 'GET');

  // ── 11. Timeout — Pi non risponde ────────────────────────────────────────
  // Crea bridge separato con Pi silenzioso
  const bridge2 = await startServer({
    agentPort: 0, relayPort: 0, relayHost: '127.0.0.1',
    agentToken: AGENT_TOKEN, relayToken: RELAY_TOKEN, relayTimeoutMs: 300,
  });
  const wsPort2    = bridge2.wss._server.address().port;
  const relayPort2 = getPort(bridge2.relayServer);

  const silentPi = await connectPi(wsPort2, AGENT_TOKEN);
  // silentPi non risponde mai
  const relayTout = await httpPost(relayPort2, '/relay',
    { method: 'GET', path: '/api/hub/health' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('relay 504 su timeout', relayTout.status === 504);
  silentPi.close();
  bridge2.close();

  // ── 12. Pi si disconnette → agent_connected torna false ──────────────────
  piWs.close();
  await new Promise((r) => setTimeout(r, 100));
  const status3 = await httpGet(relayPort, '/status');
  ok('agent_connected false dopo disconnessione', JSON.parse(status3.body).agent_connected === false);

  bridge.close();

  console.log(`\nTotal: ${passed + failed} Passed: ${passed} Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
