import { deletePath, readFileContent, writeFileContent } from "@/lib/sandboxFs";

export type IndexTTSHistoryStatus =
  | "queued"
  | "processing"
  | "success"
  | "failed";
export type IndexTTSHistorySource = "api" | "ui";

export type IndexTTSHistoryRecord = {
  id: string;
  createdAt: string;
  filename?: string;
  path?: string;
  text: string;
  status: IndexTTSHistoryStatus;
  error?: string;
  source?: IndexTTSHistorySource;
};

const DATA_PATH = "indextts/data.json";

const normalizeStatus = (value: unknown): IndexTTSHistoryStatus => {
  if (
    value === "queued" ||
    value === "processing" ||
    value === "success" ||
    value === "failed"
  ) {
    return value;
  }
  return "success";
};

const normalizeSource = (
  value: unknown
): IndexTTSHistorySource | undefined => {
  if (value === "api" || value === "ui") {
    return value;
  }
  return undefined;
};

const parseRecords = (raw: string): IndexTTSHistoryRecord[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          id: typeof record.id === "string" ? record.id : "",
          createdAt:
            typeof record.createdAt === "string"
              ? record.createdAt
              : new Date().toISOString(),
          filename:
            typeof record.filename === "string" ? record.filename : undefined,
          path: typeof record.path === "string" ? record.path : undefined,
          text: typeof record.text === "string" ? record.text : "",
          status: normalizeStatus(record.status),
          error: typeof record.error === "string" ? record.error : undefined,
          source: normalizeSource(record.source),
        } as IndexTTSHistoryRecord;
      })
      .filter((item) => item.id);
  } catch (err) {
    return [];
  }
};

export const loadHistoryRecords = async () => {
  try {
    const file = await readFileContent(DATA_PATH, "utf8");
    return parseRecords(file.content);
  } catch (err) {
    return [];
  }
};

export const saveHistoryRecords = async (records: IndexTTSHistoryRecord[]) => {
  await writeFileContent(DATA_PATH, JSON.stringify(records, null, 2), "utf8", true, true);
  return records;
};

export const upsertHistoryRecord = async (record: IndexTTSHistoryRecord) => {
  const records = await loadHistoryRecords();
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    records[index] = {
      ...records[index],
      ...record,
    };
  } else {
    records.unshift(record);
  }
  await saveHistoryRecords(records);
  return record;
};

export const updateHistoryRecord = async (
  id: string,
  patch: Partial<IndexTTSHistoryRecord>
) => {
  const records = await loadHistoryRecords();
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error("记录不存在。");
  }
  records[index] = {
    ...records[index],
    ...patch,
    id: records[index].id,
  };
  await saveHistoryRecords(records);
  return records[index];
};

export const removeHistoryRecord = async (id: string) => {
  const records = await loadHistoryRecords();
  const target = records.find((item) => item.id === id);
  if (!target) {
    throw new Error("记录不存在。");
  }
  const next = records.filter((item) => item.id !== id);
  await saveHistoryRecords(next);
  if (target.path) {
    try {
      await deletePath(target.path, false);
    } catch (err) {
      // Ignore missing files; history is source of truth.
    }
  }
  return target;
};
