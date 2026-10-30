import express, { type Express } from "express";
import type { ServerConfig } from "../config.js";
import type { WorkbenchService } from "../domain/workbench.js";
import { createApiRouter } from "../api/routes.js";
import { hostOriginGuard } from "./security.js";
import { mountFixture } from "./fixture.js";
import type { RouteOptions } from "../api/routes.js";

export interface HttpAppOptions extends RouteOptions {
  config: ServerConfig;
  service: WorkbenchService;
  beforeApi?: (app: Express) => void;
}

export function createHttpApp(options: HttpAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use("/api", hostOriginGuard(options.config));
  mountFixture(app);
  if (options.beforeApi) options.beforeApi(app);
  app.use("/api", express.json({ limit: "1mb", strict: true }));
  app.use("/api", createApiRouter(options.service, options));
  app.use(express.static(options.config.webDistDir, { index: "index.html", fallthrough: true }));
  app.get("/", (_req, res) => res.status(404).type("text").send("Dev Shell web build not found. Run the web build or use the API."));
  return app;
}
