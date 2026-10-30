import { useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, Input, useToasts } from "@hustradio/unitary-ui";
import { Bot, Copy, Plus, Square, UserX } from "lucide-react";
import type { EventEnvelope } from "@hustradio/dev-shell-contract";
import { api, EVENT_HISTORY_LIMIT, mergeEventWindow, type VisitorCredentials } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";
import { copyText } from "./QueuePanel";

export function VisitorsSessionsPanel() {
  const {snapshot, refresh} = useWorkbench();
  const activeHumanCount = snapshot.visitors.filter(visitor => visitor.kind === "human" && !visitor.revokedAt).length;
  const toasts = useToasts();
  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState<VisitorCredentials | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [outputError, setOutputError] = useState("");
  const [loadingOutput, setLoadingOutput] = useState(false);
  const refreshEvents = useRef<() => void>(() => {});
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let cursor = 0; let reading = false; let pending = false;
    setEvents([]); setOutputError("");
    const load = async () => {
      pending = true;
      if (reading) return;
      reading = true; setLoadingOutput(true);
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          try {
            const next = await api.sessionEvents(expanded, cursor, controller.signal);
            if (controller.signal.aborted) return;
            cursor = next.reduce((latest, event) => Math.max(latest, event.sequence), cursor);
            setEvents(previous => mergeEventWindow(previous, next)); setOutputError("");
          } catch (error) {
            if (!controller.signal.aborted) setOutputError(error instanceof Error ? error.message : "无法读取会话输出");
            break;
          }
        }
      } finally { reading = false; if (!controller.signal.aborted) setLoadingOutput(false); }
    };
    refreshEvents.current = () => { void load(); };
    void load();
    return () => { controller.abort(); refreshEvents.current = () => {}; };
  }, [expanded]);
  useEffect(() => { refreshEvents.current(); }, [snapshot.revision]);
  const action = async (operation: () => Promise<unknown>, success: string) => {
    try { await operation(); await refresh(); toasts.success(success); } catch (error) { toasts.error(error instanceof Error ? error.message : "操作失败"); }
  };
  const create = async () => {
    if (!name.trim()) return;
    try { const result = await api.createVisitor(name.trim()); setCredentials(result); setName(""); await refresh(); }
    catch (error) { toasts.error(error instanceof Error ? error.message : "创建失败"); }
  };
  const toggleEvents = (id: string) => { setEvents([]); setOutputError(""); setExpanded(expanded === id ? null : id); };
  return <div className="stack">
    <section className="panel">
      <div className="panel__heading"><div><h2>访问者</h2><p>为外部 Agent 创建一次性 MCP 凭据。</p></div><Badge>{snapshot.visitors.filter((item) => item.online).length} 在线</Badge></div>
      <form className="inline-form" onSubmit={(event) => {event.preventDefault(); void create();}}><Input aria-label="访问者名称" placeholder="Agent 显示名称" value={name} onChange={(event) => setName(event.target.value)} /><Button typeName="submit" prefix={<Plus />} disabled={!name.trim()}>创建</Button></form>
      {credentials && <div className="credential" role="status"><strong>凭据只显示这一次，请立即保存。</strong><code>{credentials.mcpUrl}</code><Button size="small" typeName="button" prefix={<Copy />} onClick={() => void copyText(credentials.mcpUrl).then(() => toasts.success("MCP URL 已复制"))}>复制 MCP URL</Button><details><summary>查看 token</summary><code>{credentials.token}</code></details></div>}
      <div className="list compact-list">{snapshot.visitors.map((visitor) => {
        const lastHuman = visitor.kind === "human" && activeHumanCount === 1;
        return <div className="visitor-row" key={visitor.id}><span className={`presence ${visitor.online ? "is-online" : ""}`} /><div><strong>{visitor.displayName}</strong><small>{visitor.kind} · {visitor.revokedAt ? "已吊销" : visitor.online ? "在线" : "离线"}</small></div>{!visitor.revokedAt && <Button svgOnly size="small" type="tertiary" typeName="button" aria-label={`吊销 ${visitor.displayName}`} title={lastHuman ? "至少保留一位人工访问者，保证有人能登录并管理权限。" : undefined} disabled={lastHuman} onClick={() => void action(() => api.revokeVisitor(visitor.id), "访问者已吊销")}><UserX /></Button>}</div>;
      })}</div>
      {activeHumanCount === 1 && <p className="muted">至少保留一位人工访问者，保证有人能登录并管理权限。</p>}
    </section>
    <section className="panel">
      <div className="panel__heading"><div><h2>Agent 会话</h2><p>CodeBuddy、Codex、OpenCode v2；每次发送开启新会话。</p></div><Bot size={18} /></div>
      <div className="list">{!snapshot.sessions.length && <EmptyState title="还没有会话" description="从任务编辑器发起第一个独立会话。" />}{snapshot.sessions.map((session) => <article className="list-card" key={session.id}>
        <div className="list-card__top"><code>{session.id.slice(0, 8)}</code><Badge>{session.backend ?? "codebuddy"} · {session.status}</Badge></div>
        <small>{new Date(session.createdAt).toLocaleString("zh-CN")} · CLI {(session.nativeSessionId ?? session.cliSessionId).slice(0, 16)}</small>
        {session.error && <p className="form-error">{session.error}</p>}
        <div className="item-actions"><Button size="tiny" type="secondary" typeName="button" onClick={() => void toggleEvents(session.id)}>{expanded === session.id ? "收起输出" : "查看输出"}</Button>{["queued", "spawning", "running"].includes(session.status) && <Button size="tiny" type="tertiary" typeName="button" prefix={<Square />} onClick={() => void action(() => api.cancelSession(session.id), "已请求取消会话")}>取消</Button>}</div>
        {expanded === session.id && <div className="event-output">
          {outputError && <div role="alert"><p>{outputError}</p><Button typeName="button" size="tiny" onClick={() => refreshEvents.current()}>重试读取输出</Button></div>}
          {events.length >= EVENT_HISTORY_LIMIT && <p role="status">仅显示最近 {EVENT_HISTORY_LIMIT} 条输出事件，较早的记录仍保存在本机。</p>}
          {events.length ? events.map(event => <details key={event.eventId}><summary>{event.type} · #{event.sequence}</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>) : <p>{loadingOutput ? "正在读取会话输出…" : "暂无输出事件。"}</p>}
        </div>}
      </article>)}</div>
    </section>
  </div>;
}
