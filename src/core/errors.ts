/**
 * Diagnostic error type shared by every TITW module.
 *
 * A `code` is part of the CLI contract (scripts branch on it); `details` render
 * as a bullet list so a schema failure reports every offending field at once
 * instead of the first one only.
 */
export class TitwError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(details.length > 0 ? `${message}\n${details.map((d) => `  - ${d}`).join('\n')}` : message);
    this.name = 'TitwError';
    this.code = code;
    this.details = details;
  }
}

/** Type guard for {@link TitwError}, usable across module boundaries. */
export function isTitwError(value: unknown): value is TitwError {
  return value instanceof TitwError;
}
