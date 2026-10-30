import { forwardRef } from "react";
import { Badge, Button, Tabs } from "@hustradio/unitary-ui";
import { Activity, CheckSquare2, KeyRound, ListTodo, Settings, UsersRound } from "lucide-react";
import type { DomDescriptor } from "@hustradio/dev-shell-contract";
import { useWorkbench } from "../../api/workbench-store";
import { PromptComposer, type PromptComposerHandle } from "../composer/PromptComposer";
import { QueuePanel } from "../panels/QueuePanel";
import { VisitorsSessionsPanel } from "../panels/VisitorsSessionsPanel";
import { TodosPanel } from "../panels/TodosPanel";
import { MessagesActivityPanel } from "../panels/MessagesActivityPanel";
import { ResourcesPanel } from "../panels/ResourcesPanel";

interface Props {
  tab: string; setTab: (tab: string) => void; selection: DomDescriptor | null;
  onRemoveSelection: () => void; onSend: (body: string) => Promise<void>; onQueue: (body: string) => Promise<void>;
  onOpenSettings: () => void; composerRef: React.RefObject<PromptComposerHandle | null>;
}

export const ControlRail = forwardRef<HTMLElement, Props>(function ControlRail({tab, setTab, selection, onRemoveSelection, onSend, onQueue, onOpenSettings, composerRef}, ref) {
  const {connection, snapshot} = useWorkbench();
  return <aside className="control-rail" ref={ref} aria-label="开发协作控制栏">
    <header className="brand"><div className="brand__mark">U</div><div><h1>Unitary <span>DevShell</span></h1><p>协作开发控制台</p></div><Button svgOnly type="tertiary" size="small" typeName="button" aria-label="设置" onClick={onOpenSettings}><Settings /></Button></header>
    <div className={`connection connection--${connection}`} role="status"><span className="connection__dot" aria-hidden="true" />{connection === "online" ? "实时同步" : connection === "connecting" ? "正在连接" : connection === "reconnecting" ? "连接中断，正在重试" : "离线"}<Badge className="connection__backend">{snapshot.settings.backend ?? "codebuddy"}</Badge></div>
    <PromptComposer ref={composerRef} selection={selection} onRemoveSelection={onRemoveSelection} onSend={onSend} onQueue={onQueue} />
    <Tabs ariaLabel="协作功能" compact selected={tab} setSelected={setTab} tabs={[
      {value: "queue", title: "队列", icon: <ListTodo size={14} />},
      {value: "sessions", title: "会话", icon: <UsersRound size={14} />},
      {value: "todos", title: "待办", icon: <CheckSquare2 size={14} />},
      {value: "messages", title: "消息", icon: <Activity size={14} />},
      {value: "resources", title: "资源", icon: <KeyRound size={14} />},
    ]} />
    <div className="control-rail__content">
      {tab === "queue" && <QueuePanel />}{tab === "sessions" && <VisitorsSessionsPanel />}{tab === "todos" && <TodosPanel />}{tab === "messages" && <MessagesActivityPanel />}{tab === "resources" && <ResourcesPanel />}
    </div>
  </aside>;
});
