'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import styles from './page.module.css';

type TerminalType = import('@xterm/xterm').Terminal;
type FitAddonType = import('@xterm/addon-fit').FitAddon;
type IDisposable = import('@xterm/xterm').IDisposable;

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

type StatusPayload = {
  type: 'status';
  status: ConnectionState | 'connecting' | 'connected' | 'disconnected' | 'error';
  message?: string;
};

type OutputPayload = {
  type: 'output';
  data: string;
};

type BackendMessage = StatusPayload | OutputPayload;

const DEFAULT_WS_URL = 'ws://localhost:4000/terminal';

export default function Home() {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<FitAddonType | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputDisposableRef = useRef<IDisposable | null>(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<ConnectionState>('idle');
  const [statusMessage, setStatusMessage] = useState<string | undefined>();

  const backendWsUrl = process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? DEFAULT_WS_URL;

  const updateStatus = (next: ConnectionState, message?: string) => {
    setStatus(next);
    setStatusMessage(message);
  };

  useEffect(() => {
    if (!terminalContainerRef.current) {
      return;
    }

    let isCancelled = false;
    let localResizeObserver: ResizeObserver | null = null;

    const setupTerminal = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);

      if (!terminalContainerRef.current || isCancelled) {
        return;
      }

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: '"Fira Code", "JetBrains Mono", monospace',
        theme: {
          background: '#0b1220',
          foreground: '#e2e8f0',
          cursor: '#38bdf8',
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalContainerRef.current);
      fitAddon.fit();
      terminal.focus();
      terminal.writeln('\u001b[36mWeb Terminal ready.\u001b[0m');
      terminal.writeln('Provide your SSH credentials and click CONNECT.\r\n');

      termRef.current = terminal;
      fitAddonRef.current = fitAddon;

      localResizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          queueResizeEvent();
        }
      });

      localResizeObserver.observe(terminalContainerRef.current);
    };

    setupTerminal().catch((error) => {
      console.error('Failed to initialise terminal', error);
      updateStatus('error', 'Unable to load terminal dependencies.');
    });

    return () => {
      isCancelled = true;
      if (localResizeObserver) {
        localResizeObserver.disconnect();
      }
      if (inputDisposableRef.current) {
        inputDisposableRef.current.dispose();
        inputDisposableRef.current = null;
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleWindowResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        queueResizeEvent();
      }
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  const queueResizeEvent = () => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }
    resizeTimeoutRef.current = setTimeout(() => {
      sendResize();
    }, 120);
  };

  const sendResize = () => {
    const socket = socketRef.current;
    const terminal = termRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    );
  };

  const teardownSocket = (shouldClose = false) => {
    if (socketRef.current) {
      if (shouldClose) {
        try {
          socketRef.current.close();
        } catch (error) {
          console.error('Failed to close WebSocket', error);
        }
      }
      socketRef.current = null;
    }
  };

  const handleDisconnect = () => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'disconnect' }));
    }
    teardownSocket(true);
    updateStatus('disconnected', 'Disconnected');
  };

  const attachTerminalInput = () => {
    const terminal = termRef.current;
    if (!terminal) {
      return;
    }

    if (inputDisposableRef.current) {
      inputDisposableRef.current.dispose();
      inputDisposableRef.current = null;
    }

    inputDisposableRef.current = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });
  };

  const connectToBackend = () => {
    const socket = new WebSocket(backendWsUrl);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      updateStatus('connecting', 'Establishing SSH session…');
      socket.send(
        JSON.stringify({
          type: 'connect',
          host,
          username,
          password,
          port: Number(port) || 22,
          cols: termRef.current?.cols,
          rows: termRef.current?.rows,
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data) as BackendMessage;

        if (payload.type === 'status') {
          const { status: nextStatus, message } = payload;
          const normalized = (nextStatus === 'error' ? 'error' : (nextStatus as ConnectionState));
          updateStatus(normalized, message);

          if (normalized === 'connected') {
            termRef.current?.focus();
            termRef.current?.write('\r\n');
            sendResize();
          }

          if (normalized === 'disconnected' || normalized === 'error') {
            teardownSocket();
          }
        }

        if (payload.type === 'output') {
          termRef.current?.write(payload.data);
        }
      } catch (err) {
        updateStatus('error', 'Unable to parse message from server.');
      }
    });

    socket.addEventListener('close', () => {
      updateStatus('disconnected', 'Connection closed.');
      teardownSocket();
    });

    socket.addEventListener('error', (event) => {
      console.error('WebSocket error', event);
      updateStatus('error', 'WebSocket error. Check backend availability.');
      teardownSocket();
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (!host || !username || !password) {
      updateStatus('error', 'Host, username, and password are required.');
      return;
    }

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      updateStatus('error', 'Session already active.');
      return;
    }

    termRef.current?.write('\r\nConnecting to ' + host + '...\r\n');
    updateStatus('connecting', 'Opening WebSocket…');
    attachTerminalInput();
    connectToBackend();
  };

  const isBusy = status === 'connecting';
  const isConnected = status === 'connected';

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.panel}>
          <header className={styles.heading}>
            <h1>Secure SSH Console</h1>
            <p>
              Enter the remote host credentials to bootstrap a live SSH session directly in your browser. Never leave
              the tab to manage servers again.
            </p>
          </header>

          <form className={styles.form} onSubmit={handleSubmit} suppressHydrationWarning>
            <div className={styles.field}>
              <label htmlFor="host">Host / IP</label>
              <input
                id="host"
                name="host"
                type="text"
                placeholder="192.168.0.42"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                suppressHydrationWarning
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="port">Port</label>
              <input
                id="port"
                name="port"
                type="number"
                min={1}
                max={65535}
                placeholder="22"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                suppressHydrationWarning
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                placeholder="root"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                suppressHydrationWarning
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                suppressHydrationWarning
              />
            </div>

            <div className={styles.actions}>
              <button
                className={`${styles.button} ${styles.buttonPrimary}`}
                type="submit"
                disabled={isBusy}
                suppressHydrationWarning
              >
                {isBusy ? 'Connecting…' : isConnected ? 'Reconnect' : 'Connect'}
              </button>
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                type="button"
                onClick={handleDisconnect}
                disabled={!isConnected && !socketRef.current}
                suppressHydrationWarning
              >
                Disconnect
              </button>
            </div>
          </form>

          <div className={`${styles.status} ${status === 'error' ? styles.statusError : ''}`}>
            {statusMessage ?? (status === 'idle' ? 'Awaiting credentials.' : status.toUpperCase())}
          </div>
          <div className={styles.helperText}>
            Tip: Run the backend server locally at <code>http://localhost:4000</code> or change{' '}
            <code>NEXT_PUBLIC_TERMINAL_WS_URL</code>.
          </div>
        </section>

        <section className={styles.terminalPanel}>
          <header className={styles.terminalHeader}>
            <div>
              <h2>Remote Terminal</h2>
              <div className={styles.statusBadge}>
                <span
                  className={`${styles.statusIndicator} ${
                    status === 'connected'
                      ? styles.statusIndicatorOnline
                      : status === 'error'
                        ? styles.statusIndicatorError
                        : ''
                  }`}
                />
                {status.toUpperCase()}
              </div>
            </div>
          </header>

          <div className={styles.terminalBody}>
            <div ref={terminalContainerRef} className={styles.terminalContainer} />
          </div>
        </section>
      </main>
    </div>
  );
}
