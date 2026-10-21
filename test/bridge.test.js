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

// Il Pi si autentica con l'intestazione, come il client vero (21/10/2026): il
// token nell'indirizzo finiva nei log di nginx, e il server non lo accetta più.
function connectPi(agentPort, token, hubId) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    if (hubId)  params.set('hub_id', hubId);
    const qs  = params.toString();
    const url = `ws://127.0.0.1:${agentPort}${qs ? `?${qs}` : ''}`;
    const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function getPort(server) {
  return server.address().port;
}

// ── Helpers mock Pi ───────────────────────────────────────────────────────────

/** Attacca handler echo standard a un Pi ws. Risponde con echoed_path e il hubId indicato. */
function attachEcho(ws, hubId) {
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    ws.send(JSON.stringify({
      id:           msg.id,
      status:       200,
      headers:      { 'content-type': 'application/json' },
      body:         JSON.stringify({ ok: true, echoed_path: msg.path, echoed_method: msg.method, from_hub: hubId }),
    }));
  });
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
  const badPi = new WebSocket(`ws://127.0.0.1:${wsPort}`, { headers: { Authorization: 'Bearer WRONG' } });
  const badClose = await new Promise((resolve) => badPi.on('close', (code) => resolve(code)));
  ok('Pi token errato → chiusura 1008', badClose === 1008);

  // ⛔ Il token GIUSTO nell'indirizzo non entra: un indirizzo finisce nei log.
  const inChiaro = new WebSocket(`ws://127.0.0.1:${wsPort}?token=${AGENT_TOKEN}`);
  const chiusoInChiaro = await new Promise((resolve) => inChiaro.on('close', (code) => resolve(code)));
  ok('Pi con il token nell\'indirizzo → chiusura 1008', chiusoInChiaro === 1008);

  // ── 6. Pi si connette con token corretto ─────────────────────────────────
  const piWs = await connectPi(wsPort, AGENT_TOKEN, 'default');
  ok('Pi connesso', piWs.readyState === WebSocket.OPEN);

  // ── 7. Status mostra agent_connected = true ──────────────────────────────
  await new Promise((r) => setTimeout(r, 50)); // lascia propagare
  const status2 = await httpGet(relayPort, '/status');
  ok('agent_connected true dopo connessione', JSON.parse(status2.body).agent_connected === true);

  // ── 8-10. Relay E2E ───────────────────────────────────────────────────────
  attachEcho(piWs, 'default');

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

  const silentPi = await connectPi(wsPort2, AGENT_TOKEN, 'default');
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

  // ── 13-17. Multi-hub: bridge con due Pi e hub_id diversi ─────────────────
  const bridge3 = await startServer({
    agentPort: 0, relayPort: 0, relayHost: '127.0.0.1',
    agentToken: AGENT_TOKEN, relayToken: RELAY_TOKEN, relayTimeoutMs: 500,
  });
  const wsPort3    = bridge3.wss._server.address().port;
  const relayPort3 = getPort(bridge3.relayServer);

  const piA = await connectPi(wsPort3, AGENT_TOKEN, 'hub-A');
  const piB = await connectPi(wsPort3, AGENT_TOKEN, 'hub-B');
  attachEcho(piA, 'hub-A');
  attachEcho(piB, 'hub-B');
  await new Promise((r) => setTimeout(r, 50));

  // 13. Status mostra agents_connected=2 e hub_ids
  const status4 = await httpGet(relayPort3, '/status');
  const s4 = JSON.parse(status4.body);
  ok('multi-hub: agents_connected=2', s4.agents_connected === 2);
  ok('multi-hub: hub_ids contiene hub-A e hub-B',
    Array.isArray(s4.hub_ids) && s4.hub_ids.includes('hub-A') && s4.hub_ids.includes('hub-B'));

  // 14. Relay hub-A → risposta da hub-A
  const rA = await httpPost(relayPort3, '/relay',
    { hub_id: 'hub-A', method: 'GET', path: '/api/hub/devices' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('multi-hub: relay hub-A risponde hub-A', rA.status === 200 && JSON.parse(rA.body).from_hub === 'hub-A');

  // 15. Relay hub-B → risposta da hub-B
  const rB = await httpPost(relayPort3, '/relay',
    { hub_id: 'hub-B', method: 'GET', path: '/api/hub/devices' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('multi-hub: relay hub-B risponde hub-B', rB.status === 200 && JSON.parse(rB.body).from_hub === 'hub-B');

  // 16. Relay hub-id inesistente → 503
  const rMiss = await httpPost(relayPort3, '/relay',
    { hub_id: 'hub-INESISTENTE', method: 'GET', path: '/api/hub/health' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('multi-hub: hub_id inesistente → 503', rMiss.status === 503);

  // 17. Relay senza hub_id con più Pi connessi → 503 (ambiguo, non usare backward compat)
  const rNoId = await httpPost(relayPort3, '/relay',
    { method: 'GET', path: '/api/hub/health' },
    { Authorization: `Bearer ${RELAY_TOKEN}` },
  );
  ok('multi-hub: relay senza hub_id e 2 Pi → 503', rNoId.status === 503);

  piA.close();
  piB.close();
  bridge3.close();

  console.log(`\nTotal: ${passed + failed} Passed: ${passed} Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
