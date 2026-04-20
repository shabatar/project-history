/** Detect whether an error came from an aborted fetch/stream. */
export function isAbortError(e: unknown): boolean {
  // axios: { name: 'CanceledError', code: 'ERR_CANCELED' }
  // native fetch / streams: DOMException with name === 'AbortError'
  const err = e as { name?: string; code?: string } | null;
  return (
    err?.name === 'CanceledError' ||
    err?.name === 'AbortError' ||
    err?.code === 'ERR_CANCELED'
  );
}
