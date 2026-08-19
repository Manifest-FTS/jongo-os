type StatusResult = { status?: number };
type RateLimitError = { rateLimited?: boolean; retryAfterMs?: number };

export async function retryOnceAfterRateLimit<T extends StatusResult>(
  operation: () => Promise<T>,
  delayMs = 60_000
): Promise<T> {
  const first = await operation();
  if (first.status !== 429) {
    return first;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return await operation();
}

export async function retryOnceAfterRateLimitError<T>(
  operation: () => Promise<T>,
  fallbackDelayMs = 60_000
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const rateLimitError = error as RateLimitError;
    if (!rateLimitError?.rateLimited) {
      throw error;
    }

    const retryAfterMs = Number(rateLimitError.retryAfterMs);
    const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : fallbackDelayMs;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await operation();
  }
}
