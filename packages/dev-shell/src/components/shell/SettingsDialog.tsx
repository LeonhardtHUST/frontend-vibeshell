import { useEffect, useState } from "react";
import { Button, Input, Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle, useTheme, useToasts } from "@hustradio/unitary-ui";
import type { Settings } from "@hustradio/dev-shell-contract";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";

export function SettingsDialog({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
  const {snapshot, refresh} = useWorkbench();
  const {setPreference} = useTheme();
  const toasts = useToasts();
  const [form, setForm] = useState<Settings>(snapshot.settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => {if (open) setForm(snapshot.settings);}, [open, snapshot.settings]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((current) => ({...current, [key]: value}));
  const save = async () => {
    setSaving(true);
    try {const settings = await api.updateSettings(form); setPreference(settings.theme); await refresh(); onOpenChange(false); toasts.success("设置已保存");}
    catch (error) {toasts.error(error instanceof Error ? error.message : "保存失败");}
    finally {setSaving(false);}
  };
  return <Modal open={open} onOpenChange={onOpenChange}><ModalContent className="settings-modal" showCloseButton aria-describedby="settings-description"><ModalHeader><ModalTitle>开发环境设置</ModalTitle><ModalDescription id="settings-description">目标与运行参数保存在本机。代理地址变更后需重新加载预览。</ModalDescription></ModalHeader>
    <div className="settings-grid">
      <label>Agent 后端<select aria-label="Agent 后端" value={form.backend ?? "codebuddy"} onChange={event => setForm(current => ({...current, backend: event.target.value as Settings["backend"], model: null}))}><option value="codebuddy">CodeBuddy</option><option value="codex">Codex</option><option value="opencode-v2">OpenCode v2</option></select></label>
      <label>默认目标 URL<Input type="url" value={form.defaultTarget} onChange={(event) => set("defaultTarget", event.target.value)} /></label>
      <label>允许的精确 Origin（每行一个）<textarea rows={3} value={form.allowedOrigins.join("\n")} onChange={(event) => set("allowedOrigins", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label>
      <label>工作目录<Input value={form.workspace} readOnly aria-describedby="workspace-help" /><small id="workspace-help">切换项目时请用 --workspace 重新启动 Dev Shell。</small></label>
      <label>CodeBuddy executable<Input value={form.codebuddyExecutable} onChange={(event) => set("codebuddyExecutable", event.target.value)} /></label>
      <label>Codex executable<Input value={form.codexExecutable ?? "codex"} onChange={event => set("codexExecutable", event.target.value)} /></label>
      <label>OpenCode v2 executable<Input value={form.opencodeExecutable ?? "opencode"} onChange={event => set("opencodeExecutable", event.target.value)} /></label>
      <label>模型（留空使用默认）<Input value={form.model ?? ""} onChange={(event) => set("model", event.target.value || null)} /></label>
      <label>权限模式<select value={form.permissionMode} onChange={(event) => set("permissionMode", event.target.value as Settings["permissionMode"])}><option value="default">default</option><option value="acceptEdits">acceptEdits</option><option value="plan">plan</option></select></label>
      <label>超时（毫秒）<Input type="number" min={10000} max={7200000} value={form.timeoutMs} onChange={(event) => set("timeoutMs", Number(event.target.value))} /></label>
      <label>全局并发<Input type="number" min={1} max={8} value={form.maxConcurrent} onChange={(event) => set("maxConcurrent", Number(event.target.value))} /></label>
      <label>主题<select value={form.theme} onChange={(event) => {const value = event.target.value as Settings["theme"]; set("theme", value); setPreference(value);}}><option value="dark">暗色</option><option value="light">亮色</option><option value="system">跟随系统</option></select></label>
      <label>移动长按（毫秒）<Input type="number" min={250} max={1200} value={form.longPressMs} onChange={(event) => set("longPressMs", Number(event.target.value))} /></label>
    </div><ModalFooter><Button type="secondary" typeName="button" onClick={() => onOpenChange(false)}>取消</Button><Button typeName="button" loading={saving} onClick={() => void save()}>保存设置</Button></ModalFooter>
  </ModalContent></Modal>;
}
