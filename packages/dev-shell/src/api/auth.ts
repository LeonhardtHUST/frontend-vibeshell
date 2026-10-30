import { ApiClient, ShellApiError } from "./client";

export const LEGACY_TOKEN_KEY = "dev-shell:owner-token:v1";
export const tokenKey = (workbenchId: string) => `dev-shell:owner-token:v2:${workbenchId}`;
export interface WorkbenchHealth { workbenchId: string; ownerBootstrapped: boolean }

export async function restoreAuthentication(client: ApiClient, storage: Storage) {
  const health = await client.request<WorkbenchHealth>("/api/health");
  if (!health.workbenchId) throw new Error("工作台未返回身份信息，请更新本机服务。");
  const key = tokenKey(health.workbenchId);
  const scoped = storage.getItem(key);
  const legacy = storage.getItem(LEGACY_TOKEN_KEY);
  for (const stored of [...new Set([scoped, legacy].filter((value): value is string => !!value))]) {
    try {
      const snapshot = await client.login(stored);
      storage.setItem(key, stored);
      if (stored === legacy) storage.removeItem(LEGACY_TOKEN_KEY);
      return {key, state: "ready" as const, snapshot};
    } catch (error) {
      client.setToken(null);
      if (!(error instanceof ShellApiError) || error.status !== 401) throw error;
      if (stored === scoped) storage.removeItem(key);
      // A legacy credential may belong to another project; keep it until it authenticates.
    }
  }
  return {key, state: health.ownerBootstrapped ? "login" as const : "bootstrap" as const, snapshot: null};
}
