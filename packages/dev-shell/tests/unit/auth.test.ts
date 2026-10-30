import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSnapshot } from "@leonhardthust/frontend-vibeshell-contract";
import { ApiClient, ShellApiError } from "../../src/api/client";
import { LEGACY_TOKEN_KEY, restoreAuthentication, tokenKey } from "../../src/api/auth";

const snapshot = {} as WorkbenchSnapshot;
const values = new Map<string, string>();
const localStorage: Storage = {
  get length() {return values.size;},
  clear: () => values.clear(),
  getItem: key => values.get(key) ?? null,
  key: index => [...values.keys()][index] ?? null,
  removeItem: key => {values.delete(key);},
  setItem: (key, value) => {values.set(key, value);},
};
beforeEach(() => {localStorage.clear();});
function client(id: string, initialized: boolean) {
  const next = new ApiClient();
  vi.spyOn(next, "request").mockResolvedValue({workbenchId: id, ownerBootstrapped: initialized});
  return next;
}
describe("project-scoped browser authentication", () => {
  it("switches A to new B and back without overwriting A credentials", async () => {
    localStorage.setItem(tokenKey("A"), "token-A");
    const a = client("A", true); const loginA = vi.spyOn(a, "login").mockResolvedValue(snapshot);
    expect((await restoreAuthentication(a, localStorage)).state).toBe("ready"); expect(loginA).toHaveBeenCalledWith("token-A");
    const b = client("B", false); const loginB = vi.spyOn(b, "login");
    expect((await restoreAuthentication(b, localStorage)).state).toBe("bootstrap"); expect(loginB).not.toHaveBeenCalled();
    localStorage.setItem(tokenKey("B"), "token-B");
    expect((await restoreAuthentication(a, localStorage)).state).toBe("ready");
    expect(localStorage.getItem(tokenKey("B"))).toBe("token-B");
  });
  it("migrates an accepted legacy token only for its actual workbench", async () => {
    localStorage.setItem(LEGACY_TOKEN_KEY, "old-A");
    const b = client("B", false); vi.spyOn(b, "login").mockRejectedValue(new ShellApiError("UNAUTHORIZED", "Invalid", 401));
    expect((await restoreAuthentication(b, localStorage)).state).toBe("bootstrap");
    expect(localStorage.getItem(LEGACY_TOKEN_KEY)).toBe("old-A");
    const a = client("A", true); vi.spyOn(a, "login").mockResolvedValue(snapshot);
    expect((await restoreAuthentication(a, localStorage)).state).toBe("ready");
    expect(localStorage.getItem(tokenKey("A"))).toBe("old-A"); expect(localStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
  });
  it("shows login for existing owners and initializes fresh databases after invalid credentials", async () => {
    for (const initialized of [true, false]) {
      localStorage.setItem(tokenKey("A"), "revoked");
      const a = client("A", initialized); vi.spyOn(a, "login").mockRejectedValue(new ShellApiError("UNAUTHORIZED", "Invalid", 401));
      expect((await restoreAuthentication(a, localStorage)).state).toBe(initialized ? "login" : "bootstrap");
      expect(localStorage.getItem(tokenKey("A"))).toBeNull();
    }
  });
  it("does not erase valid credentials on network/server failures", async () => {
    localStorage.setItem(tokenKey("A"), "keep");
    const a = client("A", true); vi.spyOn(a, "login").mockRejectedValue(new ShellApiError("NETWORK_ERROR", "Offline", 0));
    await expect(restoreAuthentication(a, localStorage)).rejects.toThrow("Offline");
    expect(localStorage.getItem(tokenKey("A"))).toBe("keep");
  });
});
