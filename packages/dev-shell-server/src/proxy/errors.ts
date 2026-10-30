import type { ServerResponse } from "node:http";

export class ProxyError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProxyError";
  }
}

export function asProxyError(error: unknown): ProxyError {
  if (error instanceof ProxyError) return error;
  return new ProxyError(502, "UPSTREAM_ERROR", "The target could not be reached.", {
    cause: error,
  });
}

export function sendProxyError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(asProxyError(error));
    return;
  }
  const normalized = asProxyError(error);
  const body = JSON.stringify({
    error: { code: normalized.code, message: normalized.message },
  });
  response.writeHead(normalized.statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
