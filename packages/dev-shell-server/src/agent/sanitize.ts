const SECRET_KEY = /(?:authorization|token|secret|password|api[-_]?key)/i;
const BEARER = /Bearer\s+[^\s,;"']+/gi;

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(BEARER, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function sanitizeValue(value: unknown, depth = 0, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth > 20) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1, secrets));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets),
    SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1, secrets),
  ]));
}

export class StreamRedactor {
  private pending = "";
  private dropping = false;
  constructor(private readonly secrets: readonly string[]) {}

  write(value: string): string {
    let output = "";
    for (const part of value.split(/(\n)/)) {
      if (part === "\n") {
        output += this.dropping ? "[OUTPUT TRUNCATED]\n" : `${redactText(this.pending, this.secrets)}\n`;
        this.pending = "";
        this.dropping = false;
      } else if (!this.dropping) {
        this.pending += part;
        if (this.pending.length > 64 * 1024) { this.pending = ""; this.dropping = true; }
      }
    }
    return output;
  }

  end(): string {
    const rest = this.dropping ? "[OUTPUT TRUNCATED]" : redactText(this.pending, this.secrets);
    this.pending = "";
    this.dropping = false;
    return rest;
  }
}
