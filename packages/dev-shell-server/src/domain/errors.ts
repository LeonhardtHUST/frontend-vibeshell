export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (entity: string) => new DomainError(404, "NOT_FOUND", `${entity} not found`);
export const forbidden = (message = "Operation is not permitted") => new DomainError(403, "FORBIDDEN", message);
export const conflict = (code: string, message: string, details?: unknown) => new DomainError(409, code, message, details);
