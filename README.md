# mario-remote-bridge

Relay sicuro tra Pi MARIO (LAN) e mario-web (VPS), senza port-forward.

```
mario-web → POST /relay (BRIDGE_RELAY_TOKEN) → bridge VPS → WS → Pi → hub
```

## Porte

| Porta | Uso |
|-------|-----|
| 7001  | WebSocket — Pi si connette outbound con `?token=BRIDGE_AGENT_TOKEN` |
| 7002  | HTTP relay — mario-web chiama `/relay` (localhost-only, dietro Nginx) |

## Setup server (VPS)

```bash
cp .env.example .env   # imposta i due token
npm install
npm start
```

## Setup client (Pi)

```bash
# .env sul Pi
MARIO_BRIDGE_URL=wss://bridge.example.com:7001
MARIO_BRIDGE_TOKEN=<stesso BRIDGE_AGENT_TOKEN>
HUB_URL=http://localhost:4001

node client.js
```

## Test

```bash
npm test   # 13 test end-to-end, nessun HW richiesto
```

## Variabili d'ambiente

**Server**

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `BRIDGE_AGENT_TOKEN` | — | Token Pi (obbligatorio) |
| `BRIDGE_RELAY_TOKEN` | — | Token mario-web (obbligatorio) |
| `AGENT_PORT` | 7001 | Porta WS |
| `RELAY_PORT` | 7002 | Porta HTTP relay |
| `RELAY_HOST` | 127.0.0.1 | Bind relay (127.0.0.1 = solo via Nginx) |
| `RELAY_TIMEOUT_MS` | 10000 | Timeout risposta Pi (ms) |

**Client (Pi)**

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `MARIO_BRIDGE_URL` | — | URL WS bridge (obbligatorio) |
| `MARIO_BRIDGE_TOKEN` | — | Token agente (obbligatorio) |
| `HUB_URL` | http://localhost:4001 | URL hub locale |
| `RECONNECT_DELAY_MS` | 5000 | Backoff iniziale riconnessione |
| `MAX_RECONNECT_MS` | 60000 | Backoff massimo |
