import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { IndexTTS } from "@/app/indextts/indexTTS";
import { getIndexTTSQueueSnapshot, withIndexTTSQueue } from "@/app/indextts/queue";
import { resolveSandboxFile, writeFileContent } from "@/lib/sandboxFs";
import { splitTextToSentences } from "./sentence";
import {
  type TTSWorkflowHistoryRecord,
  type TTSWorkflowSegment,
  getWorkflowHistoryRecordById,
  updateWorkflowHistoryRecord,
} from "./historyStore";
import { buildSandboxFileUrl, storeWorkflowAudioFromIndexData } from "./storage";
import {
  WorkflowCancelledError,
  WorkflowPausedError,
  clearTaskFlags,
  getTaskFlags,
  throwIfTaskStopped,
} from "./taskControl";

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ALLOWED_EMO_METHODS = [
  "Same as the voice reference",
  "Use emotion reference audio",
  "Use emotion vectors",
] as const;

const normalizeEmoMethod = (value?: string | null) => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed === "Use emotion reference audio (manually set at lower-right)"
  ) {
    return "Use emotion reference audio";
  }
  if (ALLOWED_EMO_METHODS.includes(trimmed as (typeof ALLOWED_EMO_METHODS)[number])) {
    return trimmed as (typeof ALLOWED_EMO_METHODS)[number];
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("same as the voice")) {
    return "Same as the voice reference";
  }
  if (lower.includes("emotion vector")) {
    return "Use emotion vectors";
  }
  if (lower.includes("emotion reference")) {
    return "Use emotion reference audio";
  }
  return undefined;
};

const DEFAULT_EMO_METHOD =
  normalizeEmoMethod(process.env.INDEX_TTS_EMO_METHOD) ??
  "Use emotion reference audio";

const activeRuns = new Map<string, Promise<void>>();

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1";

const resolveBaseUrl = (baseUrl?: string) => {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    if (!isLocalHost(parsed.hostname)) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const bufferToArrayBuffer = (buffer: Buffer) =>
  buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;

const guessAudioMimeType = (filename: string) => {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/wav";
  }
};

const readSandboxAudioAsFile = async (
  relativePath: string,
  fallbackName: string
) => {
  const info = await resolveSandboxFile(relativePath);
  const buffer = await fs.readFile(info.absolute);
  const filename = path.basename(info.relative || fallbackName) || fallbackName;
  return new File([bufferToArrayBuffer(buffer)], filename, {
    type: guessAudioMimeType(filename),
  });
};

const ensureSegmentFileExists = async (relativePath: string) => {
  try {
    const info = await resolveSandboxFile(relativePath);
    const stat = await fs.lstat(info.absolute);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
};

const normalizeExistingSegments = async (
  segments: TTSWorkflowSegment[],
  sentences: string[]
) => {
  const sorted = [...segments].sort((a, b) => a.index - b.index);
  const valid: TTSWorkflowSegment[] = [];

  for (const segment of sorted) {
    if (!segment || segment.index < 1 || segment.index > sentences.length) {
      continue;
    }
    const expectedText = sentences[segment.index - 1];
    if (segment.text !== expectedText) {
      continue;
    }
    if (!segment.path) {
      continue;
    }
    const exists = await ensureSegmentFileExists(segment.path);
    if (!exists) {
      continue;
    }
    valid.push({
      ...segment,
      text: expectedText,
      url: buildSandboxFileUrl(segment.path),
    });
  }

  const contiguous: TTSWorkflowSegment[] = [];
  for (let idx = 0; idx < valid.length; idx += 1) {
    const expectedIndex = idx + 1;
    const current = valid[idx];
    if (current.index !== expectedIndex) {
      break;
    }
    contiguous.push(current);
  }

  return contiguous;
};

const runFFmpegConcat = async (concatListPath: string, outputPath: string) => {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-ar",
    "24000",
    "-ac",
    "1",
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || `ffmpeg 退出码 ${code}`;
      reject(new Error(message));
    });
  });
};

const escapeFFmpegConcatPath = (value: string) => value.replace(/'/g, "'\\''");

const buildConcatList = (absolutePaths: string[]) =>
  `${absolutePaths
    .map((item) => `file '${escapeFFmpegConcatPath(item)}'`)
    .join("\n")}\n`;

const createMergedAudio = async (jobDir: string, segmentPaths: string[]) => {
  if (segmentPaths.length === 0) {
    throw new Error("没有可合并的句子音频。");
  }

  const resolvedSegments = await Promise.all(
    segmentPaths.map(async (item) => {
      const info = await resolveSandboxFile(item);
      return info.absolute;
    })
  );

  const concatRelativePath = path.posix.join(jobDir, "concat_list.txt");
  const concatText = buildConcatList(resolvedSegments);
  await writeFileContent(concatRelativePath, concatText, "utf8", true, true);

  const concatInfo = await resolveSandboxFile(concatRelativePath);
  const jobInfo = await resolveSandboxFile(jobDir);
  const mergedFilename = "merged.wav";
  const mergedAbsolutePath = path.join(jobInfo.absolute, mergedFilename);

  await runFFmpegConcat(concatInfo.absolute, mergedAbsolutePath);

  const mergedStat = await fs.lstat(mergedAbsolutePath);
  if (!mergedStat.isFile() || mergedStat.size <= 0) {
    throw new Error("ffmpeg 合并失败，未生成有效文件。");
  }

  const mergedPath = path.posix.join(jobDir, mergedFilename);
  return {
    filename: mergedFilename,
    path: mergedPath,
    url: buildSandboxFileUrl(mergedPath),
    size: mergedStat.size,
  };
};

const uniqueMethods = (values: Array<string | undefined>) => {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    set.add(trimmed);
  }
  return Array.from(set.values());
};

const normalizeEmoWeight = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

const runSingleSentence = async (
  taskId: string,
  record: TTSWorkflowHistoryRecord,
  sentence: string,
  index: number,
  promptRef: File,
  emotionRef: File,
  baseUrl?: string
) => {
  const client = baseUrl ? IndexTTS.withBaseUrl(baseUrl) : IndexTTS;
  const methods = uniqueMethods([
    DEFAULT_EMO_METHOD,
    "Use emotion reference audio",
    "Same as the voice reference",
  ]);

  const cloneFile = (file: File) =>
    new File([file], file.name || "ref.wav", { type: file.type || "audio/wav" });

  const requestBase = {
    prompt: cloneFile(promptRef),
    emo_ref_path: cloneFile(emotionRef),
    text: sentence,
    emo_weight: normalizeEmoWeight(record.emoWeight),
  };

  let lastError: unknown = null;
  let data: unknown = null;

  for (const method of methods) {
    throwIfTaskStopped(taskId);
    try {
      data = await client.genSingle({
        ...requestBase,
        emo_control_method: method,
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!data) {
    try {
      data = await client.genSingle(requestBase);
      lastError = null;
    } catch (err) {
      lastError = err;
    }
  }

  if (!data) {
    const message =
      lastError instanceof Error ? lastError.message : "IndexTTS 逐句生成失败。";
    throw new Error(message);
  }

  const segmentDir = path.posix.join(record.jobDir, "segments");
  const segmentPrefix = `segment_${String(index).padStart(3, "0")}`;
  const stored = await storeWorkflowAudioFromIndexData(data, {
    directory: segmentDir,
    prefix: segmentPrefix,
    fallbackExt: ".wav",
  });

  return {
    index,
    text: sentence,
    filename: stored.filename,
    path: stored.path,
    url: stored.url,
    size: stored.size,
  } as TTSWorkflowSegment;
};

const runTaskCore = async (taskId: string) => {
  const record = await getWorkflowHistoryRecordById(taskId);
  if (!record) {
    throw new Error("任务不存在。");
  }

  const sentences = splitTextToSentences(record.text);
  if (sentences.length === 0) {
    throw new Error("未识别到可生成的句子，请检查文案。");
  }

  let segments = await normalizeExistingSegments(record.segments, sentences);
  await updateWorkflowHistoryRecord(taskId, {
    status: "processing",
    error: undefined,
    sentenceCount: sentences.length,
    processedCount: segments.length,
    segments,
  });

  throwIfTaskStopped(taskId);

  if (!record.promptPath || !record.emotionPath) {
    throw new Error("参考音频缺失，无法续跑。");
  }

  const promptRef = await readSandboxAudioAsFile(
    record.promptPath,
    record.promptFilename || "prompt_ref.wav"
  );
  const emotionRef = await readSandboxAudioAsFile(
    record.emotionPath,
    record.emotionFilename || "emotion_ref.wav"
  );
  const baseUrl = resolveBaseUrl(record.baseUrl);

  for (let idx = segments.length; idx < sentences.length; idx += 1) {
    throwIfTaskStopped(taskId);
    const sentence = sentences[idx];
    const segment = await runSingleSentence(
      taskId,
      record,
      sentence,
      idx + 1,
      promptRef,
      emotionRef,
      baseUrl
    );
    segments = [...segments, segment];
    await updateWorkflowHistoryRecord(taskId, {
      status: "processing",
      error: undefined,
      sentenceCount: sentences.length,
      processedCount: segments.length,
      segments,
    });
  }

  throwIfTaskStopped(taskId);

  const merged = await createMergedAudio(
    record.jobDir,
    segments.map((item) => item.path)
  );

  await updateWorkflowHistoryRecord(taskId, {
    status: "success",
    sentenceCount: sentences.length,
    processedCount: segments.length,
    segments,
    mergedPath: merged.path,
    mergedFilename: merged.filename,
    mergedUrl: merged.url,
    completedAt: new Date().toISOString(),
    error: undefined,
  });

  clearTaskFlags(taskId);
};

const runTaskSafely = async (taskId: string) => {
  try {
    await runTaskCore(taskId);
  } catch (err) {
    if (err instanceof WorkflowPausedError) {
      await updateWorkflowHistoryRecord(taskId, {
        status: "paused",
        error: undefined,
      });
      return;
    }

    if (err instanceof WorkflowCancelledError) {
      await updateWorkflowHistoryRecord(taskId, {
        status: "cancelled",
        error: undefined,
      });
      return;
    }

    const message = err instanceof Error ? err.message : "TTS 工作流执行失败。";
    await updateWorkflowHistoryRecord(taskId, {
      status: "failed",
      error: message,
    });
  }
};

export const isWorkflowTaskRunning = (taskId: string) => activeRuns.has(taskId);

export const startWorkflowTask = async (taskId: string) => {
  if (activeRuns.has(taskId)) {
    return { started: false, running: true };
  }

  const record = await getWorkflowHistoryRecordById(taskId);
  if (!record) {
    throw new Error("任务不存在。");
  }

  const snapshot = getIndexTTSQueueSnapshot();
  await updateWorkflowHistoryRecord(taskId, {
    status: snapshot.size > 0 ? "queued" : "processing",
    error: undefined,
  });

  const runPromise = withIndexTTSQueue(
    async () => {
      await runTaskSafely(taskId);
    },
    async () => {
      const flags = getTaskFlags(taskId);
      if (flags.cancelled) {
        await updateWorkflowHistoryRecord(taskId, {
          status: "cancelled",
          error: undefined,
        });
        return;
      }
      if (flags.paused) {
        await updateWorkflowHistoryRecord(taskId, {
          status: "paused",
          error: undefined,
        });
        return;
      }
      await updateWorkflowHistoryRecord(taskId, {
        status: "processing",
        error: undefined,
      });
    }
  );

  const tracked = runPromise
    .catch(async () => {
      await updateWorkflowHistoryRecord(taskId, {
        status: "failed",
        error: "任务调度失败。",
      });
    })
    .finally(() => {
      activeRuns.delete(taskId);
    });

  activeRuns.set(taskId, tracked);
  return { started: true, running: true };
};
