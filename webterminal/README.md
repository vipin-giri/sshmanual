# Web Terminal Frontend

Next.js single-page interface that pairs with the Node.js SSH bridge in `../server`. The UI collects SSH credentials and streams the remote terminal over WebSockets using Xterm.js.

## Prerequisites

- Node.js 18+
- Backend bridge from `../server` running locally (default `http://localhost:4000`)

## Run Locally

Install dependencies, copy the sample env file, and start the dev server:

```bash
npm install
cp env.example .env.local    # or copy manually on Windows
npm run dev
```

The app is served at [http://localhost:3000](http://localhost:3000). It expects the backend WebSocket endpoint at `ws://localhost:4000/terminal`. To point at a different host, set:

```bash
set NEXT_PUBLIC_TERMINAL_WS_URL=ws://your-host:port/terminal   # PowerShell
# or
export NEXT_PUBLIC_TERMINAL_WS_URL=ws://your-host:port/terminal # bash
```

## Build for Production

```bash
npm run build
npm run start
```

## Security Notes

- Credentials are sent directly to the backend WebSocket; run the frontend and backend on a trusted network.
- Add authentication, TLS, and secret handling before exposing this stack to the internet.
