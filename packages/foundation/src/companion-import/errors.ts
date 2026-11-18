export class ImportPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportPolicyError";
    this.code = code;
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super("The requested resource is not owned by the authenticated Owner.");
    this.name = "AuthorizationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
