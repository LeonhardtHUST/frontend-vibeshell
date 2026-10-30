import { StringDecoder } from "node:string_decoder";
import { sanitizeValue } from "./sanitize.js";
import type { AgentOutputEvent } from "./types.js";
import type { AgentBackend } from "@hustradio/dev-shell-contract";
import { normalizeAgentEvent } from "./normalize.js";

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class NdjsonParser {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private pendingBytes = 0;
  private dropping = false;
  private ended = false;

  constructor(
    private readonly emit: (event: AgentOutputEvent) => void,
    private readonly maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    private readonly maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    private readonly secrets: readonly string[] = [],
    private readonly backend: AgentBackend = "codebuddy",
  ) {}

  write(chunk: Buffer): void {
    if (this.ended) return;
    let text = this.decoder.write(chunk);
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        this.append(text);
        return;
      }
      this.append(text.slice(0, newline));
      this.finishLine();
      text = text.slice(newline + 1);
    }
  }

  end(): void {
    if (this.ended) return;
    const rest = this.decoder.end();
    if (rest) this.append(rest);
    if (!this.dropping && this.pending.length > 0) {
      this.parseLine(this.pending.replace(/\r$/, ""));
    }
    this.pending = "";
    this.pendingBytes = 0;
    this.ended = true;
  }

  private append(text: string): void {
    if (!text) return;
    if (this.dropping) return;
    const bytes = Buffer.byteLength(text);
    if (this.pendingBytes + bytes > this.maxLineBytes || this.pendingBytes + bytes > this.maxBufferBytes) {
      this.pending = "";
      this.pendingBytes = 0;
      this.dropping = true;
      this.emit({ stream: "system", raw: "NDJSON line exceeded size limit; output dropped", kind: "warning", truncated: true });
      return;
    }
    this.pending += text;
    this.pendingBytes += bytes;
  }

  private finishLine(): void {
    if (this.dropping) {
      this.dropping = false;
      return;
    }
    this.parseLine(this.pending.replace(/\r$/, ""));
    this.pending = "";
    this.pendingBytes = 0;
  }

  private parseLine(line: string): void {
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({ stream: "stdout", raw: sanitizeValue(line, 0, this.secrets), kind: "stdout" });
      return;
    }
    const raw = sanitizeValue(parsed, 0, this.secrets);
    this.emit(normalizeAgentEvent(raw, this.backend));
  }
}
