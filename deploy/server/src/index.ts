import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { Client, ClientChannel } from 'ssh2';

type StatusMessage =
  | { type: 'status'; status: 'connecting' | 'connected' | 'disconnected' | 'error'; message?: string }
  | { type: 'output'; data: string };

interface ConnectMessage {
  type: 'connect';
  host: string;
  username: string;
  password: string;
  port?: number;
  cols?: number;
  rows?: number;
}

interface InputMessage {
  type: 'input';
  data: string;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface DisconnectMessage {
  type: 'disconnect';
}

type IncomingMessage = ConnectMessage | InputMessage | ResizeMessage | DisconnectMessage;

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? undefined, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const port = Number(process.env.PORT ?? 4000);
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/terminal' });

const sendStatus = (ws: WebSocket, message: StatusMessage) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

wss.on('connection', (ws) => {
  let sshClient: Client | null = null;
  let sshStream: ClientChannel | null = null;
  let connected = false;
  let pendingResize: { cols: number; rows: number } | null = null;

  const cleanup = () => {
    if (sshStream) {
      sshStream.end();
      sshStream = null;
    }
    if (sshClient) {
      sshClient.end();
      sshClient = null;
    }
    connected = false;
    pendingResize = null;
  };

  ws.on('message', (raw) => {
    let parsed: IncomingMessage;
    try {
      parsed = JSON.parse(raw.toString()) as IncomingMessage;
    } catch (error) {
      sendStatus(ws, { type: 'status', status: 'error', message: 'Invalid message format' });
      return;
    }

    if (parsed.type === 'connect') {
      if (connected) {
        sendStatus(ws, { type: 'status', status: 'error', message: 'Already connected' });
        return;
      }

      const { host, username, password, port: sshPort = 22, cols = 80, rows = 24 } = parsed;
      if (!host || !username || !password) {
        sendStatus(ws, { type: 'status', status: 'error', message: 'Missing required credentials' });
        return;
      }

      sshClient = new Client();

      sendStatus(ws, { type: 'status', status: 'connecting' });

      sshClient
        .on('ready', () => {
          sendStatus(ws, { type: 'status', status: 'connected' });
          connected = true;

          sshClient?.shell({ cols, rows, term: 'xterm-color' }, (err: Error | undefined, stream?: ClientChannel) => {
            if (err || !stream) {
              sendStatus(ws, { type: 'status', status: 'error', message: err?.message ?? 'Failed to open shell' });
              cleanup();
              return;
            }
            sshStream = stream;
            if (pendingResize) {
              const { cols: pendingCols, rows: pendingRows } = pendingResize;
              sshStream.setWindow(pendingRows, pendingCols, pendingRows * 8, pendingCols * 8);
              pendingResize = null;
            }
            stream
              .on('data', (data: Buffer) => {
                sendStatus(ws, { type: 'output', data: data.toString('utf-8') });
              })
              .on('close', () => {
                sendStatus(ws, { type: 'status', status: 'disconnected', message: 'Remote stream closed' });
                cleanup();
              })
              .stderr.on('data', (data: Buffer) => {
                sendStatus(ws, { type: 'output', data: data.toString('utf-8') });
              });
          });
        })
        .on('error', (error: Error) => {
          sendStatus(ws, { type: 'status', status: 'error', message: error.message });
          cleanup();
        })
        .on('end', () => {
          sendStatus(ws, { type: 'status', status: 'disconnected', message: 'SSH session ended' });
          cleanup();
        })
        .connect({
          host,
          username,
          password,
          port: sshPort,
          tryKeyboard: false,
          readyTimeout: Number(process.env.SSH_READY_TIMEOUT ?? 20000),
        });
      return;
    }

    switch (parsed.type) {
      case 'input':
        if (!connected || !sshStream) {
          sendStatus(ws, { type: 'status', status: 'error', message: 'No active connection' });
          return;
        }
        sshStream.write(parsed.data);
        break;
      case 'resize':
        if (sshStream) {
          sshStream.setWindow(parsed.rows, parsed.cols, parsed.rows * 8, parsed.cols * 8);
        } else {
          pendingResize = { cols: parsed.cols, rows: parsed.rows };
        }
        break;
      case 'disconnect':
        if (connected || sshStream) {
          sendStatus(ws, { type: 'status', status: 'disconnected', message: 'Disconnected by client' });
        }
        cleanup();
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    cleanup();
  });

  ws.on('error', () => {
    cleanup();
  });
});

server.listen(port, () => {
  console.log(`Terminal backend running on http://localhost:${port}`);
});

