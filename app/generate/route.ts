import path from "path";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getIndexTTSQueueSnapshot } from "@/app/indextts/queue";
import { makeDirectory } from "@/lib/sandboxFs";
import { splitTextToSentences } from "../sentence";
import { upsertWorkflowHistoryRecord } from "../historyStore";
import { storeUploadedReferenceFile } from "../storage";
import { startWorkflowTask } from "../runner";
import { resetTaskFlags } from "../taskControl";

export const runtime = "nodejs";

const DEFAULT_BASE_URL = "http://localhost:7860/";

const ALLOWED_AUDIO_EXTS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".webm",
  ".flac",
]);
const ALLOWED_AUDIO_MIME = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
]);

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1";

const getFileExt = (filename: string) => path.extname(filename || "").toLowerCase();

const isAllowedAudioFile = (file: File) => {
  const ext = getFileExt(file.name ?? "");
  const mime = (file.type ?? "").toLowerCase();
  return ALLOWED_AUDIO_EXTS.has(ext) || ALLOWED_AUDIO_MIME.has(mime);
};

const resolveBaseUrl = (baseUrl?: string | null) => {
  const resolved = (baseUrl ?? process.env.INDEX_TTS_BASE_URL ?? DEFAULT_BASE_URL).trim();
  try {
    const parsed = new URL(resolved);
    if (!isLocalHost(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeSource = (headers: Headers, value?: string | null) => {
  const raw =
    value ??
    headers.get("x-indextts-source") ??
    headers.get("x-api-source") ??
    headers.get("x-source") ??
    "ui";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "api" || normalized === "api_call") {
    return "api" as const;
  }
  return "ui" as const;
};

const normalizeJobDirName = (id: string) => {
  const compact = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = id.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "");
  return `${compact}_${suffix || "job"}`;
};

const parseEmoWeight = (value?: string | null) => {
  if (!value) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
};

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { ok: false, error: "请求体必须是 multipart/form-data。" },
        { status: 400 }
      );
    }

    const form = await request.formData();
    const text = form.get("text")?.toString().trim() ?? "";
    const baseUrlValue = form.get("baseUrl")?.toString();
    const emoWeightValue = form.get("emoWeight")?.toString();
    const promptValue = form.get("prompt");
    const emotionValue = form.get("emotion");

    if (!text) {
      return NextResponse.json({ ok: false, error: "请输入文案。" }, { status: 400 });
    }

    if (!(promptValue instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "请上传语音参考音频。" },
        { status: 400 }
      );
    }

    if (!(emotionValue instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "请上传情感参考音频。" },
        { status: 400 }
      );
    }

    if (!isAllowedAudioFile(promptValue) || !isAllowedAudioFile(emotionValue)) {
      return NextResponse.json(
        { ok: false, error: "仅支持 wav/mp3/m4a/ogg/webm/flac 音频文件。" },
        { status: 400 }
      );
    }

    const resolvedBaseUrl = resolveBaseUrl(baseUrlValue);
    if (baseUrlValue && !resolvedBaseUrl) {
      return NextResponse.json(
        { ok: false, error: "服务地址仅允许 localhost 或 127.0.0.1。" },
        { status: 400 }
      );
    }

    const sentences = splitTextToSentences(text);
    if (sentences.length === 0) {
      return NextResponse.json(
        { ok: false, error: "未识别到可生成的句子，请检查文案。" },
        { status: 400 }
      );
    }

    const recordId = randomUUID();
    const source = normalizeSource(request.headers, form.get("source")?.toString());
    const emoWeight = parseEmoWeight(emoWeightValue);
    const jobDir = path.posix.join("tts-workflow", "jobs", normalizeJobDirName(recordId));
    const refsDir = path.posix.join(jobDir, "refs");
    const segmentDir = path.posix.join(jobDir, "segments");

    await makeDirectory(refsDir, true);
    await makeDirectory(segmentDir, true);

    const promptRef = await storeUploadedReferenceFile(promptValue, refsDir, "prompt_ref");
    const emotionRef = await storeUploadedReferenceFile(emotionValue, refsDir, "emotion_ref");

    const queueSnapshot = getIndexTTSQueueSnapshot();
    const initStatus = queueSnapshot.size > 0 ? "queued" : "processing";

    await upsertWorkflowHistoryRecord({
      id: recordId,
      createdAt: new Date().toISOString(),
      source,
      text,
      sentenceCount: sentences.length,
      processedCount: 0,
      status: initStatus,
      error: undefined,
      jobDir,
      promptPath: promptRef.path,
      promptFilename: promptRef.filename,
      emotionPath: emotionRef.path,
      emotionFilename: emotionRef.filename,
      emoWeight,
      baseUrl: resolvedBaseUrl ?? undefined,
      segments: [],
    });

    resetTaskFlags(recordId);
    await startWorkflowTask(recordId);

    return NextResponse.json({
      ok: true,
      data: {
        id: recordId,
        status: initStatus,
        sentenceCount: sentences.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TTS 工作流提交失败。";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
