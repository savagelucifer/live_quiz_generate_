import { io } from "socket.io-client";

export type RealtimeHandler = (data: any) => void;
export interface RealtimeClient {
  on(event: string, handler: RealtimeHandler): void;
  off(event: string, handler: RealtimeHandler): void;
  emit(event: string, data?: any): void;
  disconnect(): void;
}

class BrowserWebSocketClient implements RealtimeClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<RealtimeHandler>>();
  private queue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor() { this.connect(); }

  private connect() {
    if (this.closed) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${protocol}://${window.location.host}/api/ws`);
    this.ws.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      for (const item of this.queue) this.ws?.send(item);
      this.queue = [];
      this.dispatch("connect", null);
    });
    this.ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        this.dispatch(message.event, message.data);
      } catch {}
    });
    this.ws.addEventListener("close", () => {
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });
  }

  private dispatch(event: string, data: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
  on(event: string, handler: RealtimeHandler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }
  off(event: string, handler: RealtimeHandler) { this.handlers.get(event)?.delete(handler); }
  emit(event: string, data?: any) {
    const payload = JSON.stringify({ type: event, ...(data ?? {}) });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    else if (!this.closed) this.queue.push(payload);
  }
  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.queue = [];
    this.ws?.close();
  }
}

export function createRealtimeClient(): RealtimeClient {
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return io() as unknown as RealtimeClient;
  }
  return new BrowserWebSocketClient();
}
