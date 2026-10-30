import { useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, Textarea, useToasts } from "@hustradio/unitary-ui";
import { Send } from "lucide-react";
import { api, EVENT_HISTORY_LIMIT, mergeEventWindow, type ActivityItem } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";

export function MessagesActivityPanel() {
  const {snapshot, refresh, connection} = useWorkbench();
  const toasts = useToasts();
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"broadcast" | "direct">("broadcast");
  const [recipient, setRecipient] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [topic, setTopic] = useState("");
  const [activityError, setActivityError] = useState("");
  const [loadingActivity, setLoadingActivity] = useState(false);
  const refreshActivity = useRef<() => void>(() => {});
  const visibleActivity = activity.filter(item => !topic || item.topic === topic);
  const actorName = (id: string | null) => id ? snapshot.visitors.find(visitor => visitor.id === id)?.displayName ?? id.slice(0, 8) : "系统";
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0; let reading = false; let pending = false;
    const load = async () => {
      pending = true;
      if (reading) return;
      reading = true; setLoadingActivity(true);
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          try {
            const next = await api.activity(undefined, cursor, controller.signal);
            if (controller.signal.aborted) return;
            cursor = next.reduce((latest, event) => Math.max(latest, event.sequence), cursor);
            setActivity(previous => mergeEventWindow(previous, next)); setActivityError("");
          } catch (error) {
            if (!controller.signal.aborted) setActivityError(error instanceof Error ? error.message : "无法读取活动日志");
            break;
          }
        }
      } finally { reading = false; if (!controller.signal.aborted) setLoadingActivity(false); }
    };
    refreshActivity.current = () => { void load(); };
    void load();
    return () => { controller.abort(); refreshActivity.current = () => {}; };
  }, []);
  useEffect(() => { refreshActivity.current(); }, [snapshot.revision, connection]);
  const send = async () => {
    if (!body.trim() || (kind === "direct" && !recipient)) return;
    try { await api.sendMessage(body.trim(), kind, kind === "direct" ? [recipient] : []); setBody(""); await refresh(); toasts.success("消息已发送"); } catch (error) { toasts.error(error instanceof Error ? error.message : "发送失败"); }
  };
  return <div className="stack">
    <section className="panel"><div className="panel__heading"><div><h2>消息</h2><p>广播给团队，或私信一个访问者。</p></div><Badge>{snapshot.messages.length}</Badge></div>
      <div className="message-controls"><select aria-label="消息类型" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="broadcast">广播</option><option value="direct">私信</option></select>{kind === "direct" && <select aria-label="接收者" value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">选择接收者</option>{snapshot.visitors.filter((item) => !item.revokedAt).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>}</div>
      <form className="message-form" onSubmit={(event) => {event.preventDefault(); void send();}}><Textarea rows={2} aria-label="消息内容" value={body} placeholder="输入协作消息" onChange={(event) => setBody(event.target.value)} /><Button typeName="submit" size="small" prefix={<Send />} disabled={!body.trim() || (kind === "direct" && !recipient)}>发送</Button></form>
      <div className="list compact-list">{snapshot.messages.map((message) => <article className="message-row" key={message.id}><div><Badge>{message.kind}</Badge><small>{new Date(message.createdAt).toLocaleTimeString("zh-CN")}</small></div><p className="preserve-lines">{message.body}</p><Button type="tertiary" size="tiny" typeName="button" onClick={() => void api.readMessage(message.id).then(refresh).catch((error) => toasts.error(error.message))}>标为已读</Button></article>)}</div>
    </section>
    <section className="panel"><div className="panel__heading"><div><h2>活动日志</h2><p>共享工作台的追加式事件记录。</p></div><select aria-label="活动类型" value={topic} onChange={(event) => setTopic(event.target.value)}><option value="">全部</option>{["queue", "messages", "todos", "resources", "sessions", "visitors"].map((value) => <option value={value} key={value}>{value}</option>)}</select></div>
      {activityError && <div role="alert"><p>{activityError}</p><Button typeName="button" size="tiny" onClick={() => refreshActivity.current()}>重试读取活动</Button></div>}
      {activity.length >= EVENT_HISTORY_LIMIT && <p role="status">仅保留最近 {EVENT_HISTORY_LIMIT} 条活动，筛选在这些记录中进行；较早的记录仍保存在本机。</p>}
      <div className="activity-list">{!visibleActivity.length && <EmptyState title={loadingActivity ? "正在读取活动…" : "暂无活动"} description="操作后会在这里留下记录。" />}{visibleActivity.map((item) => <div className="activity-row" key={item.eventId}><span>#{item.sequence}</span><div><strong>{item.type}</strong><small>{actorName(item.actorId)} · {item.topic} · {new Date(item.occurredAt).toLocaleString("zh-CN")}</small></div></div>)}</div>
    </section>
  </div>;
}
