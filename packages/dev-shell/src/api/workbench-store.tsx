import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PROTOCOL_VERSION, serverWsMessageSchema, workbenchSnapshotSchema, type WorkbenchSnapshot } from "@hustradio/dev-shell-contract";
import { api } from "./client";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";
interface StoreValue { snapshot: WorkbenchSnapshot; connection: ConnectionStatus; refresh: () => Promise<void> }
const StoreContext = createContext<StoreValue | null>(null);

export function WorkbenchProvider({initial, children}: {initial: WorkbenchSnapshot; children: ReactNode}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const applied = useRef(initial);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const next = await api.snapshot();
    if (alive.current && next.revision >= applied.current.revision) { applied.current = next; setSnapshot(next); }
  }, []);

  useEffect(() => {
    alive.current = true;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = false;
    let dirty = false;
    let caughtUp = false;
    const flush = async () => {
      if (closed || flushing) return;
      flushing = true;
      try {
        // Apply a snapshot and its scan cursor together. A watermark must never
        // advance past data the UI has successfully loaded.
        do { dirty = false; await refresh(); } while (dirty && !closed);
        if (caughtUp && !closed) setConnection("online");
      } catch { socket?.close(); }
      finally { flushing = false; }
    };
    const scheduleRefresh = () => {
      dirty = true;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void flush(); }, 80);
    };
    const connect = () => {
      if (closed || !api.token) return;
      setConnection(attempts ? "reconnecting" : "connecting");
      const current = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/api/events");
      socket = current;
      caughtUp = false;
      current.onopen = () => current.send(JSON.stringify({type: "hello", protocolVersion: PROTOCOL_VERSION, token: api.token}));
      current.onmessage = ({data}) => {
        let raw: unknown;
        try { raw = JSON.parse(String(data)); } catch { current.close(); return; }
        const parsed = serverWsMessageSchema.safeParse(raw);
        if (!parsed.success) { current.close(); return; }
        const message = parsed.data;
        if (message.type === "hello.ok") {
          attempts = 0;
          current.send(JSON.stringify({type: "history", streamCursor: applied.current.streamCursor}));
        } else if (message.type === "history" || message.type === "event") {
          // Empty history frames also acknowledge filtered private events.
          // Refreshing advances to an authorized snapshot cursor safely.
          scheduleRefresh();
        } else if (message.type === "completed") {
          caughtUp = true;
          scheduleRefresh();
        } else if (message.type === "resync.required") {
          const next = workbenchSnapshotSchema.safeParse(message.snapshot);
          if (!next.success) { current.close(); return; }
          if (next.data.revision >= applied.current.revision) {applied.current = next.data; setSnapshot(next.data);}
        } else if (message.type === "ping") {
          current.send(JSON.stringify({type: "pong", at: message.at}));
        } else if (message.type === "error") {
          current.close(1008);
        }
      };
      current.onclose = event => {
        if (closed) return;
        if (event.code === 1008) { setConnection("offline"); return; }
        setConnection("reconnecting");
        attempts += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts - 1, 5));
        reconnectTimer = setTimeout(connect, delay * (0.75 + Math.random() * 0.5));
      };
      current.onerror = () => current.close();
    };
    connect();
    return () => {
      closed = true; alive.current = false;
      clearTimeout(reconnectTimer); clearTimeout(refreshTimer); socket?.close();
    };
  }, [refresh]);
  const value = useMemo(() => ({snapshot, connection, refresh}), [snapshot, connection, refresh]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useWorkbench() {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useWorkbench 必须在 WorkbenchProvider 中使用");
  return value;
}
