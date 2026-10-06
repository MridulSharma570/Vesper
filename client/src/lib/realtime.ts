/**
 * WebSocket client.
 *
 * Connection lifecycle
 *   1. `POST /auth/realtime-ticket` — a 60-second ticket, minted while the access
 *      token is valid. The socket never carries the access token, so a ticket
 *      seen in a log is useless a minute later.
 *   2. Open `/realtime?ticket=…`. The URL is derived from `location`, never
 *      hardcoded, so it works behind a proxy hostname where `localhost` is not
 *      reachable from the browser.
 *   3. Send `hello`; wait for `ready`, which carries a `resumeToken`.
 *   4. On drop, reconnect with exponential backoff + jitter and replay the
 *      `resumeToken`, so the server can hand back only what was missed instead of
 *      a full resync.
 *
 * Reconnect backoff is capped at 30s and jittered, because a fleet of clients
 * retrying on an identical schedule after an outage is its own denial of service.
 */
import type { ClientFrame, ServerFrame, FeatureFlags } from '@shared/types';
import { api, deviceId } from './api';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

type Listener = (frame: ServerFrame) => void;
type StatusListener = (status: SocketStatus) => void;

const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 25_000;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private status: SocketStatus = 'idle';
  private resumeToken: string | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private intentionallyClosed = false;
  /** Frames sent while disconnected, flushed on reconnect. */
  private outbox: ClientFrame[] = [];
  /** Conversation subscriptions to restore after a reconnect. */
  private subscriptions = new Set<string>();

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.intentionallyClosed = false;
    void this.open();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.resumeToken = null;
    this.attempts = 0;
    try {
      this.ws?.close(1000, 'client_disconnect');
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.setStatus('closed');
  }

  onFrame(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    // Buffer rather than drop: a message composed on a train going through a
    // tunnel should still send when the connection returns.
    if (this.outbox.length < 100) this.outbox.push(frame);
  }

  subscribe(conversationId: string): void {
    this.subscriptions.add(conversationId);
    this.send({ t: 'conversation.subscribe', conversationId } as ClientFrame);
  }

  unsubscribe(conversationId: string): void {
    this.subscriptions.delete(conversationId);
    this.send({ t: 'conversation.unsubscribe', conversationId } as ClientFrame);
  }

  /* ── internals ───────────────────────────────────────────────── */

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private socketUrl(ticket: string): string {
    // Derived from the page origin so it is correct behind any proxy hostname.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/realtime?ticket=${encodeURIComponent(ticket)}&platform=web`;
  }

  private async open(): Promise<void> {
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let ticket: string;
    try {
      ({ ticket } = await api.realtimeTicket());
    } catch {
      // No ticket means no valid session. Stop rather than retry forever.
      this.setStatus('closed');
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.socketUrl(ticket), ['vesper.v1']);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      ws.send(JSON.stringify({
        t: 'hello',
        deviceId: deviceId(),
        platform: 'web',
        appVersion: '1.0.0',
        ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
      } satisfies ClientFrame));
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.t === 'ready') {
        this.resumeToken = frame.resumeToken;
        // Restore subscriptions: after a reconnect the server has no memory of
        // which conversations this socket cared about.
        for (const id of this.subscriptions) {
          ws.send(JSON.stringify({ t: 'conversation.subscribe', conversationId: id } satisfies ClientFrame));
        }
        // Flush anything composed while offline.
        const pending = this.outbox;
        this.outbox = [];
        for (const f of pending) ws.send(JSON.stringify(f));
      }
      for (const fn of this.listeners) fn(frame);
    };

    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror, so reconnection is handled there.
      try { ws.close(); } catch { /* already closing */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.attempts += 1;
    // Exponential backoff with full jitter.
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts, 6));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ t: 'ping', ts: Date.now() } satisfies ClientFrame);
      }
    }, HEARTBEAT_MS);
  }

  /** Flags from the last `ready` frame, so the UI can gate features. */
  lastFlags: FeatureFlags | null = null;
}

export const realtime = new RealtimeClient();
