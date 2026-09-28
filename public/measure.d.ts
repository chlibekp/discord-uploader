export function readDimensions(
  file: File,
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ width: number; height: number }>;
