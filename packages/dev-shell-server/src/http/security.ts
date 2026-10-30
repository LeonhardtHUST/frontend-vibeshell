import type { Request, RequestHandler, Response } from "express";
import { DomainError } from "../domain/errors.js";
import type { WorkbenchService } from "../domain/workbench.js";
import type { ServerConfig } from "../config.js";

export function validateHostOrigin(config: ServerConfig, headers: { host?: string; origin?: string }): void {
  const allowedOrigins = new Set(config.shellAllowedOrigins.map(origin => new URL(origin).origin));
  const host = headers.host;
  if (!host) throw new DomainError(403, "HOST_NOT_ALLOWED", "Host header is required");
  const parsedHost = new URL(`http://${host}`);
  const local = ["127.0.0.1", "localhost", "[::1]", config.host].includes(parsedHost.hostname);
  if (!local || (config.port !== 0 && Number(parsedHost.port || 80) !== config.port && !allowedOrigins.has(parsedHost.origin))) throw new DomainError(403, "HOST_NOT_ALLOWED", "Host is not allowed");
  const origin = headers.origin;
  if (origin) {
    const originUrl = new URL(origin);
    const dynamicLocal = config.port === 0 && ["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname);
    if (!allowedOrigins.has(originUrl.origin) && !dynamicLocal) throw new DomainError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed");
  }
}

export function hostOriginGuard(config: ServerConfig): RequestHandler {
  return (req, _res, next) => {
    try { validateHostOrigin(config, { host: req.headers.host, origin: req.headers.origin }); next(); }
    catch (error) { next(error); }
  };
}

export function bearerAuth(service: WorkbenchService): RequestHandler {
  return (req, res, next) => {
    try {
      const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      if (!match) throw new DomainError(401, "UNAUTHORIZED", "Bearer token is required");
      const auth = service.authenticate(match[1]);
      res.locals.visitor = auth.visitor;
      next();
    } catch (error) { next(error); }
  };
}

export function actorId(_req: Request, res: Response): string {
  return (res.locals.visitor as { id: string }).id;
}
