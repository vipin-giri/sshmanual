# SSH Terminal Backend

TypeScript/Node.js bridge that opens SSH sessions via the [`ssh2`](https://www.npmjs.com/package/ssh2) library and relays terminal IO over WebSockets.

## Setup

```bash
npm install
```

Optional environment variables (create a `.env` file if needed):

```
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000
SSH_READY_TIMEOUT=20000
```

## Development

```bash
npm run dev
```

This starts the Express server with hot reload on [http://localhost:4000](http://localhost:4000) and exposes the WebSocket endpoint at `/terminal`.

## Production

```bash
npm run build
npm run start
```

## Message Contract

- Client sends JSON on the WebSocket:
  - `{"type":"connect","host":"1.2.3.4","username":"root","password":"secret","port":22}`
  - `{"type":"input","data":"ls -la"}` (UTF-8)
  - `{"type":"resize","cols":120,"rows":30}`
  - `{"type":"disconnect"}`
- Server responds with:
  - `{"type":"status","status":"connecting|connected|disconnected|error","message":"..." }`
  - `{"type":"output","data":"terminal bytes"}`

## Hardening Checklist

- Terminate TLS in front of the service.
- Replace password auth with SSH keys or single-use tokens.
- Add session limits and authentication before exposing publicly.

