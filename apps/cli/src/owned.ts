export async function owned<T extends { close(): Promise<void> }, R>(
  resource: T,
  work: (resource: T) => Promise<R>,
): Promise<R> {
  let failed = false;
  let failure: unknown;
  try {
    return await work(resource);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    await resource.close().catch((error: unknown) => {
      if (failed)
        throw new AggregateError(
          [failure, error],
          'Command and cleanup failed.',
        );
      throw error;
    });
  }
}
