import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { ProxyError } from "./errors.js";

export type AllowOrigin = (origin: string) => boolean | Promise<boolean>;

export async function validateTargetUrl(
  value: string | URL,
  allowOrigin: AllowOrigin,
): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new ProxyError(400, "INVALID_TARGET_URL", "The target URL is invalid.", {
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyError(403, "TARGET_PROTOCOL_FORBIDDEN", "Only HTTP(S) targets are allowed.");
  }
  if (url.username || url.password) {
    throw new ProxyError(403, "TARGET_USERINFO_FORBIDDEN", "Target credentials are not allowed.");
  }
  if (!(await allowOrigin(url.origin))) {
    throw new ProxyError(403, "TARGET_ORIGIN_FORBIDDEN", "The target origin is not registered.");
  }
  const ipAddress = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(ipAddress) && !isAllowedTargetIp(ipAddress)) {
    throw new ProxyError(403, "TARGET_IP_FORBIDDEN", "The target address is forbidden.");
  }
  return url;
}

export async function validateTargetResolution(url: URL): Promise<void> {
  await resolveTargetAddresses(url);
}

export async function resolveTargetAddresses(url: URL): Promise<dns.LookupAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!isAllowedTargetIp(hostname)) {
      throw new ProxyError(403, "TARGET_IP_FORBIDDEN", "The target address is forbidden.");
    }
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ProxyError(502, "TARGET_DNS_FAILED", "The target hostname could not be resolved.", {
      cause: error,
    });
  }
  const allowed = addresses.filter(({ address }) => isAllowedTargetIp(address));
  if (!allowed.length) {
    throw new ProxyError(403, "TARGET_IP_FORBIDDEN", "The target resolved to a forbidden address.");
  }
  return allowed;
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function inIpv4Range(value: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

function forbiddenIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return [
    ["0.0.0.0", 8],
    ["100.64.0.0", 10],
    ["169.254.0.0", 16],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, bits]) => inIpv4Range(value, base as string, bits as number));
}

/**
 * Loopback and private addresses are reachable only through an explicitly allowed
 * exact origin. Non-unicast and special-purpose addresses are always rejected.
 */
export function isAllowedTargetIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  const family = net.isIP(normalized);
  if (family === 4) return !forbiddenIpv4(normalized);
  if (family !== 6) return false;

  const mapped = normalized.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] && net.isIP(mapped[1]) === 4) return isAllowedTargetIp(mapped[1]);
  const mappedHex = normalized.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isAllowedTargetIp(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }

  if (normalized === "::1") return true;
  if (normalized === "::" || normalized.startsWith("ff") || /^fe[89ab]/.test(normalized)) {
    return false;
  }
  if (
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2002:") ||
    normalized.startsWith("64:ff9b:") ||
    normalized === "64:ff9b::"
  ) {
    return false;
  }
  return true;
}

export function createTargetLookup(pinnedAddresses?: readonly string[]): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const allowed = addresses.filter(({ address }) => isAllowedTargetIp(address) && (!pinnedAddresses || pinnedAddresses.includes(address)));
      if (allowed.length === 0) {
        callback(
          new ProxyError(403, "TARGET_IP_FORBIDDEN", "The target resolved to a forbidden address."),
          "",
          0,
        );
        return;
      }
      if (options.all) {
        callback(null, allowed);
        return;
      }
      const selected = allowed.find(({ family }) => !options.family || family === options.family);
      if (!selected) {
        callback(new Error("No allowed target address matches the requested family."), "", 0);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  };
}

export function createTargetAgent(protocol: "http:" | "https:", pinnedAddresses?: readonly string[]): http.Agent {
  const options = { keepAlive: false, lookup: createTargetLookup(pinnedAddresses) };
  return protocol === "https:" ? new https.Agent(options) : new http.Agent(options);
}
