import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, useTheme } from "@hustradio/unitary-ui";
import { KeyRound, Sparkles } from "lucide-react";
import type { WorkbenchSnapshot } from "@leonhardthust/frontend-vibeshell-contract";
import { api, ShellApiError } from "./api/client";
import { WorkbenchProvider } from "./api/workbench-store";
import { WorkspaceShell } from "./components/shell/WorkspaceShell";
import { restoreAuthentication } from "./api/auth";
type AuthState = "loading" | "bootstrap" | "login" | "ready";

export default function App() {
  const [state, setState] = useState<AuthState>("loading");
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const {setPreference} = useTheme();

  useEffect(() => {
    let active = true;
    restoreAuthentication(api, localStorage).then(result => {
      if (!active) return;
      setStorageKey(result.key); setSnapshot(result.snapshot); setState(result.state);
      if (result.snapshot) setPreference(result.snapshot.settings.theme);
    }).catch(cause => {if (active) setError(cause instanceof Error ? cause.message : "连接失败");});
    return () => {active = false;};
  }, [setPreference]);
  const bootstrap = async (event: FormEvent) => {
    event.preventDefault(); if (!name.trim()) return; setBusy(true); setError("");
    try {const result = await api.bootstrap(name.trim()); if (storageKey) localStorage.setItem(storageKey, result.token); setSnapshot(result.snapshot); setPreference(result.snapshot.settings.theme); setState("ready");}
    catch (cause) {if (cause instanceof ShellApiError && cause.code === "OWNER_EXISTS") setState("login"); else setError(cause instanceof Error ? cause.message : "初始化失败");}
    finally {setBusy(false);}
  };
  const login = async (event: FormEvent) => {
    event.preventDefault(); if (!token.trim()) return; setBusy(true); setError("");
    try {const next = await api.login(token.trim()); if (storageKey) localStorage.setItem(storageKey, token.trim()); setSnapshot(next); setPreference(next.settings.theme); setState("ready");}
    catch (cause) {setError(cause instanceof Error ? cause.message : "登录失败");}
    finally {setBusy(false);}
  };
  if (state === "ready" && snapshot) return <WorkbenchProvider initial={snapshot}><WorkspaceShell /></WorkbenchProvider>;
  return <main className="auth-page"><section className="auth-card">
    <div className="auth-card__icon">{state === "login" ? <KeyRound /> : <Sparkles />}</div>
    <p className="eyebrow">FRONTEND VIBESHELL</p><h1>{state === "login" ? "欢迎回来" : "你的协作开发空间"}</h1>
    <p className="auth-card__lead">{state === "login" ? "输入此本机工作台的访问 token。它只保存在当前浏览器。" : "在真实页面中选择元素，与 CodeBuddy、Codex、OpenCode v2 共享任务、上下文与进度。"}</p>
    {state === "loading" ? <p role={error ? "alert" : undefined}>{error || "正在连接本机服务…"}</p> : state === "bootstrap" ? <form onSubmit={(event) => void bootstrap(event)}><label>你的显示名称<Input autoFocus value={name} maxLength={80} placeholder="例如：Leon" onChange={(event) => setName(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}<Button typeName="submit" loading={busy} disabled={!name.trim()}>初始化工作台</Button></form> : <form onSubmit={(event) => void login(event)}><label>访问 token<Input autoFocus type="password" value={token} placeholder="粘贴本机访问 token" onChange={(event) => setToken(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}<Button typeName="submit" loading={busy} disabled={!token.trim()}>进入工作台</Button></form>}
    <div className="auth-card__foot"><span>127.0.0.1</span><span>多访问者实时协作</span><span>暗色优先</span></div>
  </section></main>;
}
