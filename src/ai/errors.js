/** kind: rate_limit | denied | server | timeout | network | bad_request | empty */
export class AiError extends Error {
  constructor(kind, message, { status = null, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** No provider could answer right now. retryAfterMs tells the queue when it is worth trying again. */
export class AiUnavailable extends Error {
  constructor(reason, retryAfterMs = 0, cause = null) {
    super(`ИИ недоступен: ${reason}${cause ? ` (${cause.message})` : ''}`);
    this.name = 'AiUnavailable';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The answer parsed but is not good enough. `fallback` carries the cleaned partial result, `score` how good it is. */
export class AiValidationError extends Error {
  constructor(message, fallback = null, score = 0) {
    super(message);
    this.name = 'AiValidationError';
    this.fallback = fallback;
    this.score = score;
  }
}
