# mario-remote-bridge — CLAUDE.md

Regole condivise: `C:\HomeMARIO\CLAUDE.md`

## Ruolo
Relay sicuro WebSocket tra Raspberry Pi (mario-hub) e VPS Hetzner.
Mantiene il tunnel persistente. Non interpreta comandi né esegue logica di casa.

## Stack
Node.js 22, WebSocket (`ws`), `dotenv`. Nessuna dipendenza AI.

## Comandi
```bash
npm start     # node server.js
npm run dev   # node --watch server.js
npm test      # node test/bridge.test.js
```
