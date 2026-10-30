import { Badge } from "@hustradio/unitary-ui";
import { MousePointer2, X } from "lucide-react";
import type { DomDescriptor } from "@hustradio/dev-shell-contract";

export function SelectionChip({selection, onRemove}: {selection: DomDescriptor; onRemove?: () => void}) {
  return <span className="selection-chip">
    <Badge><MousePointer2 size={12} /> {selection.tagName.toLowerCase()}{selection.id ? `#${selection.id}` : ""}</Badge>
    <span className="selection-chip__path">{selection.cssPath}</span>
    {onRemove && <button type="button" onClick={onRemove} aria-label="移除选中元素"><X size={14} /></button>}
  </span>;
}
