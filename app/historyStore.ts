import { deletePath, readFileContent, writeFileContent } from "@/lib/sandboxFs";

export type TTSWorkflowStatus =
  | "queued"
  | "processing"
  | "paused"
  | "cancelled"
  | "success"
  | "failed";
export type TTSWorkflowSource = "api" | "ui";

export type TTSWorkflowSegment = {
  index: number;
  text: string;
  filename: string;
  path: string;
  url: string;
  size: number;
};

export type TTSWorkflowHistoryRecord = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  source?: TTSWorkflowSource;
  text: string;
  sentenceCount: number;
  processedCount: number;
  status: TTSWorkflowStatus;
  error?: string;
  jobDir: string;
  promptPath?: string;
  promptFilename?: string;
  emotionPath?: string;
  emotionFilename?: string;
  emoWeight?: number;
  baseUrl?: string;
  mergedPath?: string;
  mergedFilename?: string;
  mergedUrl?: string;
  segments: TTSWorkflowSegment[];
};

const DATA_PATH = "tts-workflow/data.json";

const normalizeStatus = (value: unknown): TTSWorkflowStatus => {
  if (
    value === "queued" ||
    value === "processing" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "success" ||
    value === "failed"
  ) {
    return value;
  }
  return "processing";
};

const normalizeSource = (value: unknown): TTSWorkflowSource | undefined => {
  if (value === "api" || value === "ui") {
    return value;
  }
  return undefined;
};

const normalizeEmoWeight = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

const normalizeSegments = (value: unknown): TTSWorkflowSegment[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === "object")
    .map((item, idx) => {
      const record = item as Record<string, unknown>;
      const index =
        typeof record.index === "number" && Number.isFinite(record.index)
          ? record.index
          : idx + 1;
      const text = typeof record.text === "string" ? record.text : "";
      const filename = typeof record.filename === "string" ? record.filename : "";
      const path = typeof record.path === "string" ? record.path : "";
      const url = typeof record.url === "string" ? record.url : "";
      const size =
        typeof record.size === "number" && Number.isFinite(record.size)
          ? record.size
          : 0;
      return { index, text, filename, path, url, size };
    })
    .filter((item) => item.index > 0 && item.text && item.path);
};

const parseRecords = (raw: string): TTSWorkflowHistoryRecord[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const text = typeof record.text === "string" ? record.text : "";
        const jobDir = typeof record.jobDir === "string" ? record.jobDir : "";

        const sentenceCount =
          typeof record.sentenceCount === "number" && Number.isFinite(record.sentenceCount)
            ? record.sentenceCount
            : 0;

        const processedCount =
          typeof record.processedCount === "number" && Number.isFinite(record.processedCount)
            ? record.processedCount
            : 0;

        return {
          id,
          createdAt:
            typeof record.createdAt === "string"
              ? record.createdAt
              : new Date().toISOString(),
          updatedAt:
            typeof record.updatedAt === "string" ? record.updatedAt : undefined,
          completedAt:
            typeof record.completedAt === "string" ? record.completedAt : undefined,
          source: normalizeSource(record.source),
          text,
          sentenceCount,
          processedCount,
          status: normalizeStatus(record.status),
          error: typeof record.error === "string" ? record.error : undefined,
          jobDir,
          promptPath:
            typeof record.promptPath === "string" ? record.promptPath : undefined,
          promptFilename:
            typeof record.promptFilename === "string"
              ? record.promptFilename
              : undefined,
          emotionPath:
            typeof record.emotionPath === "string" ? record.emotionPath : undefined,
          emotionFilename:
            typeof record.emotionFilename === "string"
              ? record.emotionFilename
              : undefined,
          emoWeight: normalizeEmoWeight(record.emoWeight),
          baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : undefined,
          mergedPath:
            typeof record.mergedPath === "string" ? record.mergedPath : undefined,
          mergedFilename:
            typeof record.mergedFilename === "string"
              ? record.mergedFilename
              : undefined,
          mergedUrl:
            typeof record.mergedUrl === "string" ? record.mergedUrl : undefined,
          segments: normalizeSegments(record.segments),
        } as TTSWorkflowHistoryRecord;
      })
      .filter((item) => item.id && item.jobDir);
  } catch {
    return [];
  }
};

export const loadWorkflowHistoryRecords = async () => {
  try {
    const file = await readFileContent(DATA_PATH, "utf8");
    return parseRecords(file.content);
  } catch {
    return [];
  }
};

export const saveWorkflowHistoryRecords = async (
  records: TTSWorkflowHistoryRecord[]
) => {
  await writeFileContent(DATA_PATH, JSON.stringify(records, null, 2), "utf8", true, true);
  return records;
};

export const upsertWorkflowHistoryRecord = async (
  record: TTSWorkflowHistoryRecord
) => {
  const records = await loadWorkflowHistoryRecords();
  const index = records.findIndex((item) => item.id === record.id);
  const withUpdateAt = {
    ...record,
    updatedAt: new Date().toISOString(),
  };

  if (index >= 0) {
    records[index] = {
      ...records[index],
      ...withUpdateAt,
      id: records[index].id,
    };
  } else {
    records.unshift(withUpdateAt);
  }

  await saveWorkflowHistoryRecords(records);
  return withUpdateAt;
};

export const updateWorkflowHistoryRecord = async (
  id: string,
  patch: Partial<TTSWorkflowHistoryRecord>
) => {
  const records = await loadWorkflowHistoryRecords();
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error("记录不存在。");
  }

  records[index] = {
    ...records[index],
    ...patch,
    id: records[index].id,
    updatedAt: new Date().toISOString(),
  };

  await saveWorkflowHistoryRecords(records);
  return records[index];
};

export const getWorkflowHistoryRecordById = async (id: string) => {
  const records = await loadWorkflowHistoryRecords();
  return records.find((item) => item.id === id) ?? null;
};

export const removeWorkflowHistoryRecord = async (id: string) => {
  const records = await loadWorkflowHistoryRecords();
  const target = records.find((item) => item.id === id);
  if (!target) {
    throw new Error("记录不存在。");
  }

  const next = records.filter((item) => item.id !== id);
  await saveWorkflowHistoryRecords(next);

  try {
    await deletePath(target.jobDir, true);
  } catch {
    // Ignore cleanup errors and keep history consistent.
  }

  return target;
};
