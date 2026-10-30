import { describe, expect, it } from "vitest";
import { NdjsonParser, sanitizeValue } from "../../src/agent/index.js";
import { StreamRedactor } from "../../src/agent/sanitize.js";
import type { AgentOutputEvent } from "../../src/agent/index.js";

describe("NdjsonParser", () => {
  it("bounds oversized lines and recovers at the next newline", () => {
    const events: AgentOutputEvent[] = [];
    const parser = new NdjsonParser((event) => events.push(event), 32, 64);
    parser.write(Buffer.from(`{"type":"result","result":"${"x".repeat(40)}"}\n`));
    parser.write(Buffer.from('{"type":"result","result":"ok"}\n'));
    parser.end();
    expect(events.some((event) => event.kind === "warning" && event.truncated)).toBe(true);
    expect(events.filter((event) => event.kind === "result")).toHaveLength(1);
  });

  it("does not leak a credential split across stderr chunks or the flush boundary", () => {
    const redactor = new StreamRedactor(["known-secret-value"]);
    const output = [redactor.write("x".repeat(80) + " Authorization: Bear"), redactor.write("er arbitrary-bearer known-sec"), redactor.write("ret-value\n"), redactor.end()].join("");
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).not.toContain("arbitrary-bearer");
    expect(output).not.toContain("known-secret-value");
  });

  it("bounds deeply nested output without returning unredacted children", () => {
    let value: unknown = { token: "nested-secret" };
    for (let index = 0; index < 30; index++) value = { child: value };
    const serialized = JSON.stringify(sanitizeValue(value));
    expect(serialized).toContain("[TRUNCATED]");
    expect(serialized).not.toContain("nested-secret");
  });

  it("sanitizes normalized scalar fields as well as raw envelopes", () => {
    const events: AgentOutputEvent[] = [];
    const parser = new NdjsonParser(event => events.push(event), undefined, undefined, ["session-secret"]);
    parser.write(Buffer.from('{"type":"result","subtype":"session-secret","session_id":"session-secret"}\n'));
    expect(JSON.stringify(events)).not.toContain("session-secret");
  });

  it("bounds a final line without a newline", () => {
    const events: AgentOutputEvent[] = [];
    const parser = new NdjsonParser((event) => events.push(event), 8, 16);
    parser.write(Buffer.from("123456789"));
    parser.end();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "warning", truncated: true });
  });

  it("redacts known credentials used as JSON object keys", () => {
    const events: AgentOutputEvent[] = [];
    const parser = new NdjsonParser(event => events.push(event), undefined, undefined, ["session-secret"]);
    parser.write(Buffer.from(JSON.stringify({type: "result", result: {"session-secret": "echoed-key", "Bearer arbitrary-secret": "header-as-key"}}) + "\n"));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("arbitrary-secret");
    expect(serialized).toContain("[REDACTED]");
  });
});
