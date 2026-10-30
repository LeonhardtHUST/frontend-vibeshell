import type { DomDescriptor } from "./frames.js";
import type { QueueItem } from "./workbench.js";

export function formatSelection(selection: DomDescriptor): string {
  return [
    `### 选中元素 \`<${selection.tagName.toLowerCase()}>\``,
    `- 页面：${selection.pageTitle || selection.pageUrl}`,
    `- URL：${selection.pageUrl}`,
    `- 选择器：\`${selection.cssPath}\``,
    selection.componentName ? `- 组件：${selection.componentName}` : null,
    selection.text ? `- 文本：${selection.text}` : null,
    selection.outerHTML ? `\n\`\`\`html\n${selection.outerHTML}\n\`\`\`` : null,
  ].filter(Boolean).join("\n");
}

export function formatPrompt(body: string, selection: DomDescriptor | null): string {
  return selection ? `${body}\n\n## 页面上下文\n${formatSelection(selection)}` : body;
}

export function formatQueueBundle(queue: QueueItem[]): string {
  return [...queue].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((item, index) => `## 任务 ${index + 1}\n\n${item.body}${item.selection ? `\n\n${formatSelection(item.selection)}` : ""}`).join("\n\n---\n\n");
}
