/** kind: http | network | timeout | schema | breaker | input */
export class McError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'McError';
    this.kind = kind;
    this.status = status;
  }
}
