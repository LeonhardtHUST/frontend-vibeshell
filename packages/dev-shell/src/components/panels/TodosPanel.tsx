import { useState } from "react";
import { Badge, Button, EmptyState, Input, useToasts } from "@hustradio/unitary-ui";
import { Plus, Trash2 } from "lucide-react";
import type { TodoItem } from "@hustradio/dev-shell-contract";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";

export function TodosPanel() {
  const {snapshot, refresh} = useWorkbench();
  const toasts = useToasts();
  const [listTitle, setListTitle] = useState("");
  const [activeList, setActiveList] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const listId = activeList && snapshot.todoLists.some((item) => item.id === activeList) ? activeList : snapshot.todoLists[0]?.id ?? null;
  const run = async (operation: () => Promise<unknown>, success: string) => {
    try { await operation(); await refresh(); toasts.success(success); } catch (error) { toasts.error(error instanceof Error ? error.message : "操作失败"); }
  };
  const update = (item: TodoItem, status: TodoItem["status"]) => run(() => api.updateTodoItem(item.id, {status}, item.revision), "任务状态已更新");
  return <section className="panel">
    <div className="panel__heading"><div><h2>协作待办</h2><p>使用多个列表组织共同工作。</p></div><Badge>{snapshot.todoItems.filter((item) => item.status !== "done").length} 未完成</Badge></div>
    <form className="inline-form" onSubmit={(event) => {event.preventDefault(); if (listTitle.trim()) void run(() => api.createTodoList(listTitle.trim()), "列表已创建").then(() => setListTitle(""));}}><Input aria-label="新列表名称" placeholder="新列表名称" value={listTitle} onChange={(event) => setListTitle(event.target.value)} /><Button svgOnly typeName="submit" aria-label="创建列表" disabled={!listTitle.trim()}><Plus /></Button></form>
    {snapshot.todoLists.length > 0 && <div className="chip-tabs" role="tablist" aria-label="待办列表">{snapshot.todoLists.map((list) => <button type="button" role="tab" aria-selected={listId === list.id} key={list.id} onClick={() => setActiveList(list.id)}>{list.title}</button>)}</div>}
    {listId ? <>
      <form className="inline-form" onSubmit={(event) => {event.preventDefault(); if (body.trim()) void run(() => api.createTodoItem(listId, body.trim()), "待办已创建").then(() => setBody(""));}}><Input aria-label="新待办内容" placeholder="添加一个待办" value={body} onChange={(event) => setBody(event.target.value)} /><Button svgOnly typeName="submit" aria-label="添加待办" disabled={!body.trim()}><Plus /></Button></form>
      <div className="list">{snapshot.todoItems.filter((item) => item.listId === listId).sort((a, b) => a.position - b.position).map((item) => <article className="todo-row" key={item.id}>
        <input type="checkbox" aria-label={`完成 ${item.body}`} checked={item.status === "done"} onChange={() => void update(item, item.status === "done" ? "pending" : "done")} />
        <div><p className={item.status === "done" ? "is-done" : ""}>{item.body}</p><select aria-label="任务状态" value={item.status} onChange={(event) => void update(item, event.target.value as TodoItem["status"])}><option value="pending">待处理</option><option value="in_progress">进行中</option><option value="done">已完成</option></select></div>
      </article>)}</div>
      <Button size="tiny" type="tertiary" typeName="button" prefix={<Trash2 />} onClick={() => void run(() => api.deleteTodoList(listId), "列表已删除")}>删除当前列表</Button>
    </> : <EmptyState title="还没有待办列表" description="先创建一个列表，再添加任务。" />}
  </section>;
}
