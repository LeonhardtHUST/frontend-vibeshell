import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Button, Textarea } from "@hustradio/unitary-ui";
import { ListPlus, Send } from "lucide-react";
import type { DomDescriptor } from "@hustradio/dev-shell-contract";
import { resolveComposerShortcut } from "./shortcuts";
import { SelectionChip } from "./SelectionChip";

export interface PromptComposerHandle { focus: () => void }
interface Props {
  selection: DomDescriptor | null;
  onRemoveSelection: () => void;
  onSend: (body: string) => Promise<void>;
  onQueue: (body: string) => Promise<void>;
}

export const PromptComposer = forwardRef<PromptComposerHandle, Props>(function PromptComposer({selection, onRemoveSelection, onSend, onQueue}, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState<"send" | "queue" | null>(null);
  const [error, setError] = useState("");
  useImperativeHandle(ref, () => ({focus: () => textarea.current?.focus()}));
  const disabled = !body.trim() || submitting !== null;
  const submit = async (kind: "send" | "queue") => {
    if (disabled) return;
    setSubmitting(kind); setError("");
    try { await (kind === "send" ? onSend : onQueue)(body.trim()); setBody(""); onRemoveSelection(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setSubmitting(null); textarea.current?.focus(); }
  };
  return <section className="composer" aria-label="任务编辑器">
    {selection && <SelectionChip selection={selection} onRemove={onRemoveSelection} />}
    <Textarea
      ref={textarea}
      value={body}
      rows={4}
      placeholder="描述要实现的内容，Enter 新建会话，Ctrl + Enter 加入队列"
      aria-label="任务内容"
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        const action = resolveComposerShortcut(event);
        if (action === "send" || action === "queue") { event.preventDefault(); void submit(action); }
      }}
    />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="composer__footer">
      <span className="hint">Shift + Enter 换行</span>
      <div className="button-row">
        <Button type="secondary" size="small" typeName="button" prefix={<ListPlus />} disabled={disabled} loading={submitting === "queue"} onClick={() => void submit("queue")}>加入队列</Button>
        <Button size="small" typeName="button" prefix={<Send />} disabled={disabled} loading={submitting === "send"} onClick={() => void submit("send")}>新建会话</Button>
      </div>
    </div>
  </section>;
});
