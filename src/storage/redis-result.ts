/**
 * ioredis resolves a pipeline/multi `exec()` with one `[err, result]` tuple
 * per queued command even when Redis is unreachable — it does not reject
 * the whole call. Silently treating a missing/errored entry as "no data"
 * would read as "signed out" or "nothing to delete" (or, for usage stats,
 * as zeros), so every such result is unwrapped here and a failure is
 * re-thrown instead of swallowed.
 */
export function unwrapResult<T>(
  entry: [Error | null, unknown] | undefined | null,
): T {
  if (!entry) throw new Error("Redis command produced no result");
  const [err, value] = entry;
  if (err) throw err;
  return value as T;
}
