import type { AgentBackend } from "@hustradio/dev-shell-contract";
import type { AgentOutputEvent } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Normalize only documented event envelopes; keep sanitized raw data intact. */
export function normalizeAgentEvent(raw: unknown, backend: AgentBackend): AgentOutputEvent {
  const envelope = object(raw);
  if (!envelope) return { stream: "stdout", raw, kind: "stdout" };
  const type = typeof envelope.type === "string" ? envelope.type : "";
  if (backend === "codex") {
    const item = object(envelope.item);
    let kind: AgentOutputEvent["kind"] = "stdout";
    if (["thread.started", "turn.started"].includes(type)) kind = "system";
    else if (["turn.completed", "turn.failed"].includes(type)) kind = "result";
    else if (type === "error") kind = "error";
    else if (["item.started", "item.updated", "item.completed"].includes(type)) {
      kind = item?.type === "agent_message" ? "assistant" : item?.type === "reasoning" || item?.type === "todo_list" ? "system"
        : item?.type === "error" ? "error" : item && ["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search"].includes(String(item.type)) ? "tool" : "stdout";
    }
    return { stream: "stdout", raw, kind, normalized: {
      type, backend,
      ...(typeof envelope.thread_id === "string" ? { nativeSessionId: envelope.thread_id } : {}),
      ...(item ? { item, ...(typeof item.text === "string" ? { text: item.text } : {}) } : {}),
      ...(type === "turn.failed" ? { isError: true, error: envelope.error } : {}),
      ...(type === "turn.completed" ? { isError: false, usage: envelope.usage } : {}),
    } };
  }
  if (backend === "opencode-v2") {
    const part = object(envelope.part);
    const time = object(part?.time);
    const reason = typeof part?.reason === "string" ? part.reason : undefined;
    // step_finish is emitted for every model step. A tool-calls step is not
    // completion of the user's task, so it must not satisfy the result gate.
    const kind: AgentOutputEvent["kind"] = type === "text" ? "assistant" : type === "tool_use" ? "tool"
      : type === "error" || (type === "step_finish" && reason === "stop") ? "result"
        : ["step_start", "step_finish", "reasoning"].includes(type) ? "system" : "stdout";
    return { stream: "stdout", raw, kind, normalized: {
      type, backend,
      ...(typeof envelope.sessionID === "string" ? { nativeSessionId: envelope.sessionID } : {}),
      ...(part ? { part, ...(typeof part.text === "string" ? { text: part.text } : {}) } : {}),
      ...(type === "text" && part?.type === "text" && typeof part.text === "string" && part.text.length > 0 && typeof envelope.sessionID === "string" && envelope.sessionID.startsWith("ses") && typeof time?.end === "number" && Number.isFinite(time.end) ? {completedText: true} : {}),
      ...(reason ? { reason } : {}),
      ...(type === "error" ? { isError: true, error: envelope.error } : {}),
      ...(type === "step_finish" && reason === "stop" ? { isError: false } : {}),
    } };
  }
  const message = object(envelope.message);
  const role = typeof message?.role === "string" ? message.role : undefined;
  const kind = type === "system" || type === "assistant" || type === "result" ? type
    : type === "tool" || type === "tool_use" || type === "tool_result" || role === "tool" ? "tool"
      : role === "assistant" ? "assistant" : undefined;
  if (!kind) return { stream: "stdout", raw, kind: "stdout" };
  return { stream: "stdout", raw, kind, normalized: {
    type: kind, backend,
    ...(typeof envelope.subtype === "string" ? { subtype: envelope.subtype } : {}),
    ...(typeof envelope.session_id === "string" ? { sessionId: envelope.session_id, nativeSessionId: envelope.session_id } : {}),
    ...("message" in envelope ? { message: envelope.message } : {}),
    ...("result" in envelope ? { result: envelope.result } : {}),
    ...("is_error" in envelope ? { isError: envelope.is_error } : {}),
  } };
}
