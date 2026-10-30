import { useState } from "react";
import { Badge, Button, EmptyState, Input, useToasts } from "@hustradio/unitary-ui";
import { Clock3, KeyRound, Unlock, X } from "lucide-react";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";

export function ResourcesPanel() {
  const {snapshot, refresh} = useWorkbench();
  const toasts = useToasts();
  const [resource, setResource] = useState("");
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<"shared" | "exclusive">("exclusive");
  const [wait, setWait] = useState(false);
  const visitorName = (id: string) => snapshot.visitors.find(visitor => visitor.id === id)?.displayName ?? id.slice(0, 8);
  const run = async (operation: () => Promise<unknown>, success: string) => {
    try { await operation(); await refresh(); toasts.success(success); } catch (error) { toasts.error(error instanceof Error ? error.message : "操作失败"); }
  };
  return <section className="panel"><div className="panel__heading"><div><h2>资源租约</h2><p>协作提示锁，不强制锁定文件。</p></div><KeyRound size={18} /></div>
    <form className="resource-form" onSubmit={(event) => {event.preventDefault(); if (resource.trim() && purpose.trim()) void run(() => api.acquireLease(resource.trim(), mode, purpose.trim(), wait), wait ? "已登记等待" : "租约已获取");}}>
      <Input aria-label="资源路径" placeholder="资源，例如 src/App.tsx" value={resource} onChange={(event) => setResource(event.target.value)} />
      <Input aria-label="用途" placeholder="用途" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      <div className="message-controls"><select aria-label="租约模式" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="exclusive">独占</option><option value="shared">共享</option></select><label className="check-label"><input type="checkbox" checked={wait} onChange={(event) => setWait(event.target.checked)} />冲突时等待</label></div>
      <Button typeName="submit" size="small" disabled={!resource.trim() || !purpose.trim()}>获取租约</Button>
    </form>
    <h3>当前持有 <Badge>{snapshot.leases.length}</Badge></h3>
    <div className="list">{!snapshot.leases.length && <EmptyState title="没有活动租约" description="获取租约来声明你的工作范围。" />}{snapshot.leases.map((lease) => <article className="list-card" key={lease.id}><div className="list-card__top"><code>{lease.resource}</code><Badge>{lease.mode}</Badge></div><p>{lease.purpose}</p><small>持有者：{visitorName(lease.ownerId)} · 到期：{new Date(lease.expiresAt).toLocaleString("zh-CN")}</small><div className="item-actions"><Button size="tiny" type="secondary" typeName="button" prefix={<Clock3 />} onClick={() => void run(() => api.renewLease(lease.id), "租约已续期")}>续期</Button><Button size="tiny" type="tertiary" typeName="button" prefix={<Unlock />} onClick={() => void run(() => api.releaseLease(lease.id), "租约已释放")}>释放</Button></div></article>)}</div>
    {snapshot.waiters.length > 0 && <><h3>等待中 <Badge>{snapshot.waiters.length}</Badge></h3><div className="list">{snapshot.waiters.map((waiter) => <article className="list-card" key={waiter.id}><code>{waiter.resource}</code><p>{waiter.purpose}</p><small>等待者：{visitorName(waiter.ownerId)} · {waiter.mode}</small><Button size="tiny" type="tertiary" typeName="button" prefix={<X />} onClick={() => void run(() => api.cancelWaiter(waiter.id), "已取消等待")}>取消等待</Button></article>)}</div></>}
  </section>;
}
