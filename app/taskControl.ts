export class WorkflowPausedError extends Error {
  constructor(message = "任务已暂停。") {
    super(message);
    this.name = "WorkflowPausedError";
  }
}

export class WorkflowCancelledError extends Error {
  constructor(message = "任务已取消。") {
    super(message);
    this.name = "WorkflowCancelledError";
  }
}

type TaskFlags = {
  paused: boolean;
  cancelled: boolean;
};

const taskFlags = new Map<string, TaskFlags>();

const ensureFlags = (taskId: string) => {
  const existing = taskFlags.get(taskId);
  if (existing) {
    return existing;
  }
  const created: TaskFlags = { paused: false, cancelled: false };
  taskFlags.set(taskId, created);
  return created;
};

export const getTaskFlags = (taskId: string): TaskFlags => {
  const current = taskFlags.get(taskId);
  if (!current) {
    return { paused: false, cancelled: false };
  }
  return { ...current };
};

export const setTaskPaused = (taskId: string, paused: boolean) => {
  const flags = ensureFlags(taskId);
  flags.paused = paused;
  if (paused) {
    flags.cancelled = false;
  }
  return { ...flags };
};

export const setTaskCancelled = (taskId: string, cancelled: boolean) => {
  const flags = ensureFlags(taskId);
  flags.cancelled = cancelled;
  if (cancelled) {
    flags.paused = false;
  }
  return { ...flags };
};

export const resetTaskFlags = (taskId: string) => {
  taskFlags.set(taskId, { paused: false, cancelled: false });
};

export const clearTaskFlags = (taskId: string) => {
  taskFlags.delete(taskId);
};

export const throwIfTaskStopped = (taskId: string) => {
  const flags = taskFlags.get(taskId);
  if (!flags) {
    return;
  }
  if (flags.cancelled) {
    throw new WorkflowCancelledError();
  }
  if (flags.paused) {
    throw new WorkflowPausedError();
  }
};
