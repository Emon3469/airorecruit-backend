/**
 * Typed application errors. The HTTP error middleware maps them to status codes,
 * and the agent relays `message` to the recruiter in plain language.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, 'NOT_FOUND', `${what} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

export class IllegalTransitionError extends ConflictError {
  constructor(
    public readonly from: string,
    public readonly to: string,
    candidateName?: string,
  ) {
    super(
      'ILLEGAL_TRANSITION',
      `Cannot move ${candidateName ?? 'candidate'} from ${from} to ${to}.`,
      { from, to },
    );
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
