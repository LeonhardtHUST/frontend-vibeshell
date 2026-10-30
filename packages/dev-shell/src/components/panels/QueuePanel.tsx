import { useState } from "react";
import { Badge, Button, EmptyState, useToasts } from "@hustradio/unitary-ui";
import { Check, Copy, Play, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";
import { formatQueueBundle } from "../composer/format";
import { newClientMessageId } from "../composer/shortcuts";

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea"); field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.append(field); field.select(); document.execCommand("copy"); field.remove();
}

export function QueuePanel() {
  const {snapshot, refresh} = useWorkbench();
  const toasts = useToasts();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const selectedItems = snapshot.queue.filter((item) => selected.has(item.id));
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await operation(); await refresh(); toasts.success(success); }
    catch (error) { toasts.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-label="共享任务队列">
    <div className="panel__heading"><div><h2>共享队列</h2><p>所有访问者同步读取，不会出队。</p></div><Badge>{snapshot.queue.length}</Badge></div>
    <div className="toolbar">
      <Button size="small" typeName="button" prefix={<Play />} disabled={!selected.size || busy} onClick={() => void run(() => api.dispatch(selectedItems.map((item) => item.id), newClientMessageId()), "已合并为一个新会话")}>批量新建会话</Button>
      <Button size="small" type="secondary" typeName="button" prefix={<Copy />} disabled={!selected.size} onClick={() => void copyText(formatQueueBundle(selectedItems)).then(() => toasts.success("已复制 Markdown，可自行 steer"))}>复制自行 steer</Button>
    </div>
    <div className="list">
      {!snapshot.queue.length && <EmptyState title="队列是空的" description="在编辑器中按 Ctrl + Enter 添加任务。" />}
      {snapshot.queue.map((item) => <article className="list-card" key={item.id}>
        <div className="list-card__top">
          <label className="check-label"><input type="checkbox" checked={selected.has(item.id)} disabled={item.status !== "queued"} onChange={() => setSelected((current) => {const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;})} /><span>选择</span></label>
          <Badge>{item.status}</Badge>
        </div>
        <p className="preserve-lines">{item.body}</p>
        {item.selection && <code className="selection-path">{item.selection.cssPath}</code>}
        <div className="item-actions">
          <Button size="tiny" type="tertiary" typeName="button" prefix={<Check />} onClick={() => void run(() => api.readQueue(item.id), "已标记为已读")}>标为已读</Button>
          <Button size="tiny" type="tertiary" typeName="button" prefix={<Trash2 />} onClick={() => void run(() => api.deleteQueue(item.id), "队列项已删除")}>删除</Button>
          {["failed", "cancelled"].includes(item.status) && <Button size="tiny" type="secondary" typeName="button" onClick={() => void run(() => api.retryQueue(item.id), "已重新入队")}>重新入队</Button>}
        </div>
      </article>)}
    </div>
  </section>;
}
