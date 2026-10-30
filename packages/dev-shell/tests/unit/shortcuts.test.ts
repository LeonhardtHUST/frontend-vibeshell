import { describe, expect, it } from "vitest";
import { resolveComposerShortcut } from "../../src/components/composer/shortcuts";

function event(key = "Enter", modifiers = {}, native = {}) {
  return {key, shiftKey: false, ctrlKey: false, metaKey: false, nativeEvent: native, ...modifiers} as Parameters<typeof resolveComposerShortcut>[0];
}

describe("composer shortcuts", () => {
  it("uses Enter for a new session and Ctrl/Meta Enter for queue", () => {
    expect(resolveComposerShortcut(event())).toBe("send");
    expect(resolveComposerShortcut(event("Enter", {ctrlKey: true}))).toBe("queue");
    expect(resolveComposerShortcut(event("Enter", {metaKey: true}))).toBe("queue");
  });
  it("keeps Shift Enter as a newline", () => {
    expect(resolveComposerShortcut(event("Enter", {shiftKey: true}))).toBe("newline");
    expect(resolveComposerShortcut(event("Enter", {shiftKey: true, ctrlKey: true}))).toBe("newline");
  });
  it("never submits while composing Chinese text", () => {
    expect(resolveComposerShortcut(event("Enter", {}, {isComposing: true}))).toBeNull();
    expect(resolveComposerShortcut(event("Enter", {}, {keyCode: 229}))).toBeNull();
  });
  it("ignores other keys", () => expect(resolveComposerShortcut(event("a"))).toBeNull());
});
