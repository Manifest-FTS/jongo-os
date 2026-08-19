type StatusResult = { status?: number };

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
