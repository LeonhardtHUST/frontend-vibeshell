import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Spinner } from "@hustradio/unitary-ui";
import { Crosshair, ExternalLink, Globe2, RefreshCw, Settings } from "lucide-react";
import type { DomDescriptor, FrameInfo } from "@hustradio/dev-shell-contract";
import { api } from "../../api/client";
import { useWorkbench } from "../../api/workbench-store";
import { useFrameBridge, type SelectedElement } from "../bridge/use-frame-bridge";

interface Props {onSelected: (selection: SelectedElement) => void; onOpenSettings: () => void; selection: DomDescriptor | null; immersive: boolean; controlsHost: HTMLElement | null}

export function FramePanel({onSelected, onOpenSettings, selection, immersive, controlsHost}: Props) {
  const {snapshot} = useWorkbench();
  const [frame, setFrame] = useState<FrameInfo | null>(null);
  const [address, setAddress] = useState(snapshot.settings.defaultTarget);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const {iframe, bridgeReady, armed, title, viewport, togglePicker} = useFrameBridge(frame, onSelected);

  useEffect(() => {
    let disposed = false;
    let created: FrameInfo | null = null;
    setLoading(true); setError(""); setFrame(null);
    void api.createFrame(address).then(next => {
      created = next;
      if (disposed) {void api.deleteFrame(next.frameId).catch(() => undefined); return;}
      setFrame(next);
    }).catch(cause => {if (!disposed) {setError(cause instanceof Error ? cause.message : "无法创建预览"); setLoading(false);}});
    return () => {disposed = true; if (created) void api.deleteFrame(created.frameId).catch(() => undefined);};
    // Only navigation/reload commits the typed address.
  }, [version]);
  const navigate = (event: FormEvent) => {event.preventDefault(); setVersion((value) => value + 1);};
  const controls = <>
    <header className="preview__header">
      <div className="preview__identity"><Globe2 size={16} /><div><strong>{title || frame?.title || "页面预览"}</strong><span>{frame?.currentUrl ?? snapshot.settings.defaultTarget}</span></div></div>
      <div className="preview__status"><span className={`status-dot ${loading ? "is-loading" : bridgeReady ? "is-ready" : "is-degraded"}`} />{loading ? "加载中" : bridgeReady ? "桥接就绪" : "选择器降级"}{viewport && <span>{viewport.width} × {viewport.height}</span>}</div>
      <div className="preview__actions">
        <Button svgOnly size="small" type={armed ? "default" : "tertiary"} typeName="button" aria-label={armed ? "退出元素选择" : "选择页面元素"} aria-pressed={armed} disabled={!frame} onClick={togglePicker}><Crosshair /></Button>
        <Button svgOnly size="small" type="tertiary" typeName="button" aria-label="重新加载" onClick={() => setVersion((value) => value + 1)}><RefreshCw /></Button>
        <Button svgOnly size="small" type="tertiary" typeName="button" aria-label="打开原始页面" disabled={!frame} onClick={() => {if (frame) window.open(frame.targetUrl, "_blank", "noopener,noreferrer");}}><ExternalLink /></Button>
        <Button svgOnly size="small" type="tertiary" typeName="button" aria-label="打开设置" onClick={onOpenSettings}><Settings /></Button>
      </div>
    </header>
    <form className={`address-bar ${editing ? "is-editing" : ""}`} onSubmit={navigate}><Input aria-label="预览地址" value={address} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => setAddress(event.target.value)} /><Button size="small" typeName="submit" disabled={!address.trim()}>前往</Button></form>
  </>;
  return <main className="preview" aria-label="页面预览">
    {immersive ? controlsHost && createPortal(controls, controlsHost) : controls}
    {error ? <div className="preview-error"><Globe2 size={32} /><h2>无法打开预览</h2><p>{error}</p><Button typeName="button" onClick={() => setVersion(value => value + 1)}>重试</Button><a href={/^https?:\/\//.test(address) ? address : undefined} target="_blank" rel="noreferrer">打开原始页面</a></div> : frame ? <div className="iframe-wrap">
      {loading && <div className="frame-loading"><Spinner /><span>正在连接目标页面</span></div>}
      <iframe key={frame.bootstrapUrl} ref={iframe} src={frame.bootstrapUrl} title="开发目标页面" sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-downloads" onLoad={() => setLoading(false)} onError={() => {setLoading(false); setError("页面加载失败，请尝试打开原始页面。");}} />
    </div> : <div className="frame-loading"><Spinner /><span>正在初始化预览</span></div>}
    {selection && <div className="selected-context" aria-live="polite"><Crosshair size={14} /><span>已选择 {selection.tagName.toLowerCase()} · {selection.cssPath}</span></div>}
  </main>;
}
