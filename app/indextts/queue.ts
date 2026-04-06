let chain: Promise<void> = Promise.resolve();
let pendingCount = 0;
let activeCount = 0;

export const getIndexTTSQueueSnapshot = () => ({
  pending: pendingCount,
  active: activeCount,
  size: pendingCount + activeCount,
});

export const withIndexTTSQueue = async <T>(
  task: () => Promise<T>,
  onStart?: () => Promise<void> | void
) => {
  pendingCount += 1;
  const run = async () => {
    pendingCount -= 1;
    activeCount += 1;
    if (onStart) {
      await onStart();
    }
    try {
      return await task();
    } finally {
      activeCount -= 1;
    }
  };

  const resultPromise = chain.then(run, run);
  chain = resultPromise.then(
    () => undefined,
    () => undefined
  );
  return await resultPromise;
};
