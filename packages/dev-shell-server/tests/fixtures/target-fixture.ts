import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";

export interface TargetFixture {
  origin: string;
  lastWebSocketHeaders?: http.IncomingHttpHeaders;
  close(): Promise<void>;
}

function html(body = "<main id='app'><h1>Target</h1></main>"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>Fixture</title><link rel="stylesheet" href="/assets/root.css"><script type="module" src="/assets/root.js"></script></head><body>${body}</body></html>`;
}

export async function startTargetFixture(crossOrigin?: () => string): Promise<TargetFixture> {
  const sockets = new Set<Socket>();
  const fixture: TargetFixture = {
    origin: "",
    async close() {
      if (!server.listening) return;
      for (const client of wss.clients) client.terminate();
      wss.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/echo" || url.pathname === "/private/echo") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.stringify({
          method: request.method,
          body: Buffer.concat(chunks).toString("utf8"),
          authorization: request.headers.authorization ?? null,
          proxyAuthorization: request.headers["proxy-authorization"] ?? null,
          host: request.headers.host,
          origin: request.headers.origin ?? null,
          cookie: request.headers.cookie ?? null,
          referer: request.headers.referer ?? null,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      return;
    }
    if (url.pathname === "/cookie") {
      const value = url.searchParams.get("value") === "beta" ? "beta" : "alpha";
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          `upstream=${value}; Path=/; HttpOnly`,
          "scoped=private; Path=/private",
          "expired=gone; Max-Age=0; Path=/",
          "invalid=foreign; Domain=example.com; Path=/",
          "secure=secret; Secure; Path=/",
          "__dev_shell_injected=blocked; Path=/",
        ],
      });
      response.end("{}");
      return;
    }
    if (url.pathname === "/cookie-clear") {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=; Max-Age=0; Path=/" });
      response.end("{}");
      return;
    }
    if (url.pathname === "/assets/root.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("main { color: rgb(1, 2, 3); }");
      return;
    }
    if (url.pathname === "/assets/root.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("export const rootFixture = true;");
      return;
    }
    if (url.pathname === "/stream") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([0, 1, 2]));
      response.end(Buffer.from([3, 4, 5]));
      return;
    }
    if (url.pathname === "/redirect-same") {
      response.writeHead(302, { location: "/final?from=redirect" });
      response.end();
      return;
    }
    if (url.pathname === "/nested/redirect-relative") {
      response.writeHead(302, { location: "final" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-cross") {
      response.writeHead(302, { location: `${crossOrigin?.() ?? "http://127.0.0.1:1"}/` });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-file") {
      response.writeHead(302, { location: "file:///tmp/not-allowed" });
      response.end();
      return;
    }
    if (url.pathname === "/large") {
      const body = `<!doctype html><html><head></head><body>${"x".repeat(8 * 1024 * 1024)}</body></html>`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
      return;
    }

    let body = html();
    if (url.pathname === "/final") body = html("<p>redirected</p>");
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'none'",
      "content-security-policy-report-only": "default-src 'none'",
      "x-frame-options": "DENY",
      "cache-control": "public, max-age=3600",
      etag: '"fixture-etag"',
      "set-cookie": ["target=ok; Domain=.example.com; Path=/private; HttpOnly"],
    };
    if (url.pathname === "/gzip") {
      const compressed = gzipSync(body);
      response.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": compressed.length });
      response.end(compressed);
      return;
    }
    if (url.pathname === "/deflate") {
      const compressed = deflateSync(body);
      response.writeHead(200, { ...headers, "content-encoding": "deflate", "content-length": compressed.length });
      response.end(compressed);
      return;
    }
    if (url.pathname === "/br") {
      const compressed = brotliCompressSync(body);
      response.writeHead(200, { ...headers, "content-encoding": "br", "content-length": compressed.length });
      response.end(compressed);
      return;
    }
    response.writeHead(200, headers);
    response.end(body);
  });

  const wss = new WebSocketServer({ server });
  wss.on("headers", headers => headers.push("Set-Cookie: handshake=ok; Path=/; HttpOnly"));
  wss.on("connection", (socket, request) => {
    fixture.lastWebSocketHeaders = request.headers;
    socket.on("message", (data) => socket.send(data));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fixture;
}
