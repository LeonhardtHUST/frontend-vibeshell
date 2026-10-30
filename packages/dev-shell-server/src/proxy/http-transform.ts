import { pipeline } from "node:stream";
import {
  createBrotliDecompress,
  createUnzip,
  type BrotliDecompress,
  type Unzip,
} from "node:zlib";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { ProxyError, sendProxyError } from "./errors.js";
import { validateTargetUrl, validateTargetResolution, type AllowOrigin } from "./target-policy.js";

export const HTML_LIMIT = 8 * 1024 * 1024;
export const BRIDGE_PATH = "/__dev_shell_bridge.js";

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type Document = DefaultTreeAdapterMap["document"];
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function responseHeaders(proxyResponse: IncomingMessage, html: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connectionTokens = (proxyResponse.headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  for (const [name, value] of Object.entries(proxyResponse.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      connectionTokens.includes(lower) ||
      lower === "x-frame-options" ||
      lower === "content-security-policy" ||
      lower === "content-security-policy-report-only" ||
      lower === "set-cookie"
    ) {
      continue;
    }
    if (html && ["content-length", "content-encoding", "etag"].includes(lower)) continue;
    headers[name] = value;
  }

  headers["cache-control"] = "no-store";
  headers["referrer-policy"] = "no-referrer";
  return headers;
}

function isHtml(proxyResponse: IncomingMessage): boolean {
  const contentType = proxyResponse.headers["content-type"]?.toLowerCase() ?? "";
  return /(?:text\/html|application\/xhtml\+xml)/.test(contentType);
}

async function readHtml(proxyResponse: IncomingMessage): Promise<string> {
  const encoding = (proxyResponse.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  let decoder: Unzip | BrotliDecompress | undefined;
  if (encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate") {
    decoder = createUnzip();
  } else if (encoding === "br") {
    decoder = createBrotliDecompress();
  } else if (encoding !== "identity" && encoding !== "") {
    throw new ProxyError(502, "UNSUPPORTED_CONTENT_ENCODING", "The HTML encoding is unsupported.");
  }

  const source = decoder ? proxyResponse.pipe(decoder) : proxyResponse;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > HTML_LIMIT) {
      source.destroy();
      proxyResponse.destroy();
      throw new ProxyError(413, "HTML_TOO_LARGE", "The HTML response exceeds the 8 MiB limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function removeCspMeta(node: Node): void {
  if ("childNodes" in node) {
    // The loop removes children, so iterate over a stable copy.
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const child of [...node.childNodes]) {
      if (
        "tagName" in child &&
        child.tagName === "meta" &&
        child.attrs.some(
          ({ name, value }) =>
            name.toLowerCase() === "http-equiv" &&
            value.trim().toLowerCase() === "content-security-policy",
        )
      ) {
        node.childNodes.splice(node.childNodes.indexOf(child), 1);
      } else {
        removeCspMeta(child);
      }
    }
  }
}

function findHead(node: Node): Element | undefined {
  if ("tagName" in node && node.tagName === "head") return node;
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      const head = findHead(child);
      if (head) return head;
    }
  }
  return undefined;
}

export function injectBridge(document: Document): string {
  removeCspMeta(document);
  const head = findHead(document);
  if (!head) throw new ProxyError(502, "HTML_TRANSFORM_FAILED", "The HTML head is missing.");
  const script: Element = {
    nodeName: "script",
    tagName: "script",
    namespaceURI: "http://www.w3.org/1999/xhtml" as Element["namespaceURI"],
    attrs: [{ name: "src", value: BRIDGE_PATH }],
    childNodes: [],
    parentNode: head,
  };
  head.childNodes.unshift(script);
  return serialize(document);
}

async function rewriteRedirect(
  proxyResponse: IncomingMessage,
  target: URL,
  proxyOrigin: string,
  allowOrigin: AllowOrigin,
): Promise<void> {
  const location = proxyResponse.headers.location;
  if (!location) return;
  let destination: URL;
  try {
    destination = new URL(location, target);
  } catch (error) {
    throw new ProxyError(502, "INVALID_REDIRECT", "The target returned an invalid redirect.", {
      cause: error,
    });
  }
  const validated = await validateTargetUrl(destination, allowOrigin);
  if (validated.origin !== target.origin) {
    throw new ProxyError(403, "CROSS_ORIGIN_REDIRECT", "Cross-origin redirects are blocked.");
  }
  await validateTargetResolution(validated);
  proxyResponse.headers.location = `${proxyOrigin}${validated.pathname}${validated.search}${validated.hash}`;
}

export async function handleProxyResponse(
  proxyResponse: IncomingMessage,
  response: ServerResponse,
  target: URL,
  proxyOrigin: string,
  allowOrigin: AllowOrigin,
): Promise<void> {
  try {
    await rewriteRedirect(proxyResponse, target, proxyOrigin, allowOrigin);
    const html = isHtml(proxyResponse) && proxyResponse.statusCode !== 204 && proxyResponse.statusCode !== 304;
    const headers = responseHeaders(proxyResponse, html);

    if (!html) {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage, headers);
      if (response.req?.method === "HEAD" || proxyResponse.statusCode === 204 || proxyResponse.statusCode === 304) {
        proxyResponse.resume();
        response.end();
        return;
      }
      pipeline(proxyResponse, response, (error) => {
        if (error && !response.destroyed) response.destroy(error);
      });
      return;
    }

    const source = await readHtml(proxyResponse);
    const document = parse(source);
    const transformed = injectBridge(document);
    headers["content-type"] = "text/html; charset=utf-8";
    headers["content-length"] = Buffer.byteLength(transformed);
    response.writeHead(proxyResponse.statusCode ?? 200, proxyResponse.statusMessage, headers);
    response.end(response.req?.method === "HEAD" ? undefined : transformed);
  } catch (error) {
    proxyResponse.destroy();
    sendProxyError(response, error);
  }
}
