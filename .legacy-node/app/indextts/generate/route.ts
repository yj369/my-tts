import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { IndexTTS } from "../indexTTS";
import { storeIndexTTSAudio } from "../sandboxAudio";
import { updateHistoryRecord, upsertHistoryRecord } from "../historyStore";
import { getIndexTTSQueueSnapshot, withIndexTTSQueue } from "../queue";
import { listDirectory, resolveSandboxFile } from "@/lib/sandboxFs";

const ALLOWED_AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".webm"]);
const ALLOWED_AUDIO_MIME = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
]);
const VOICE_DIR = "indextts/voices";

type VoiceItem = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  type: "file" | "dir";
};

type ApiSource = "api";

const isAllowedAudioFile = (file: File) => {
  const ext = path.extname(file.name ?? "").toLowerCase();
  const type = (file.type ?? "").toLowerCase();
  return ALLOWED_AUDIO_EXTS.has(ext) || ALLOWED_AUDIO_MIME.has(type);
};

const isMissingDirectoryError = (err: unknown) => {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes("路径不存在") || err.message.includes("目标不是目录");
};

const isVoicePath = (relativePath: string) =>
  relativePath === VOICE_DIR || relativePath.startsWith(`${VOICE_DIR}/`);

const normalizeVoiceName = (value: string) => value.trim().toLowerCase();

const normalizeClientId = (value?: string | null) => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
};

const stripExtension = (filename: string) => {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
};

const guessContentType = (filename: string) => {
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
    default:
      return "application/octet-stream";
  }
};

const normalizeApiSource = (value?: string | null): ApiSource | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "api" || normalized === "api_call") {
    return "api";
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return "api";
  }
  return undefined;
};

const resolveApiSource = (headers: Headers, value?: string) => {
  const headerValue =
    headers.get("x-indextts-source") ??
    headers.get("x-api-source") ??
    headers.get("x-source") ??
    headers.get("x-api-call");
  return normalizeApiSource(headerValue) ?? normalizeApiSource(value);
};

const getVoiceItems = async () => {
  try {
    const data = await listDirectory(VOICE_DIR);
    return (data.items as VoiceItem[]).filter(
      (item) =>
        item.type === "file" &&
        ALLOWED_AUDIO_EXTS.has(path.extname(item.name).toLowerCase())
    );
  } catch (err) {
    if (isMissingDirectoryError(err)) {
      return [];
    }
    throw err;
  }
};

const readBuiltinVoiceFile = async (voice: VoiceItem) => {
  const fileInfo = await resolveSandboxFile(voice.path);
  const relative = fileInfo.relative.replace(/\\/g, "/");
  if (!isVoicePath(relative)) {
    throw new Error("内置音色路径异常。");
  }
  const buffer = await fs.readFile(fileInfo.absolute);
  const mimeType = guessContentType(voice.name);
  return new File([buffer], voice.name, { type: mimeType });
};

const resolveBuiltinVoice = async (voiceName: string) => {
  const items = await getVoiceItems();
  if (items.length === 0) {
    throw new Error("内置音色列表为空。");
  }

  const normalized = normalizeVoiceName(voiceName);
  const exact = items.find(
    (item) => normalizeVoiceName(item.name) === normalized
  );
  if (exact) {
    return readBuiltinVoiceFile(exact);
  }

  const pathMatch = items.find(
    (item) => normalizeVoiceName(item.path) === normalized
  );
  if (pathMatch) {
    return readBuiltinVoiceFile(pathMatch);
  }

  const stem = normalizeVoiceName(stripExtension(voiceName));
  const stemMatches = items.filter(
    (item) => normalizeVoiceName(stripExtension(item.name)) === stem
  );
  if (stemMatches.length === 1) {
    return readBuiltinVoiceFile(stemMatches[0]);
  }
  if (stemMatches.length > 1) {
    throw new Error("匹配到多个音色，请使用完整文件名。");
  }
  throw new Error(`未找到匹配的内置音色：${voiceName}`);
};

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let voiceFile: File | null = null;
    let voiceName: string | undefined;
    let source: ApiSource | undefined;
    let clientId: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      text = form.get("text")?.toString().trim() ?? "";
      const voice = form.get("voice");
      if (voice instanceof File) {
        voiceFile = voice;
      }
      const voiceNameValue =
        form.get("voiceName")?.toString() ??
        form.get("voice_name")?.toString();
      if (voiceNameValue) {
        voiceName = voiceNameValue.trim();
      }
      const clientIdValue =
        form.get("clientId")?.toString() ?? form.get("client_id")?.toString();
      clientId = normalizeClientId(clientIdValue);
      const sourceValue = form.get("source")?.toString();
      source = resolveApiSource(request.headers, sourceValue);
    } else {
      let body: {
        text?: string;
        voiceName?: string;
        voice_name?: string;
        source?: string;
        clientId?: string;
        client_id?: string;
      } = {};
      try {
        body = (await request.json()) as {
          text?: string;
          voiceName?: string;
          voice_name?: string;
          source?: string;
          clientId?: string;
          client_id?: string;
        };
      } catch (err) {
        return NextResponse.json(
          { error: "请求体需为表单或 JSON。" },
          { status: 400 }
        );
      }
      text = body.text?.trim() ?? "";
      voiceName = body.voiceName ?? body.voice_name;
      if (voiceName) {
        voiceName = voiceName.trim();
      }
      source = resolveApiSource(request.headers, body.source);
      clientId = normalizeClientId(body.clientId ?? body.client_id);
    }

    if (!text) {
      return NextResponse.json({ error: "请输入文本。" }, { status: 400 });
    }

    if (!voiceFile && voiceName) {
      try {
        voiceFile = await resolveBuiltinVoice(voiceName);
      } catch (err) {
        return NextResponse.json(
          {
            error: err instanceof Error ? err.message : "读取内置音色失败。",
          },
          { status: 400 }
        );
      }
    }

    if (!voiceFile) {
      return NextResponse.json(
        { error: "请提供参考音频文件或内置音色名称。" },
        { status: 400 }
      );
    }
    if (!isAllowedAudioFile(voiceFile)) {
      return NextResponse.json(
        { error: "仅支持 wav/mp3/m4a/ogg/webm 音频文件。" },
        { status: 400 }
      );
    }

    const recordId = clientId ?? randomUUID();
    const queued =
      getIndexTTSQueueSnapshot().size > 0 ? "queued" : "processing";
    await upsertHistoryRecord({
      id: recordId,
      createdAt: new Date().toISOString(),
      text,
      status: queued,
      source,
    });

    return await withIndexTTSQueue(
      async () => {
        try {
          const data = await IndexTTS.genSingle({
            emo_control_method: "Same as the voice reference",
            prompt: voiceFile,
            text,
            emo_ref_path: voiceFile,
          });

          const stored = await storeIndexTTSAudio(data);
          await updateHistoryRecord(recordId, {
            status: "success",
            filename: stored.filename,
            path: stored.path,
            error: undefined,
          });
          return NextResponse.json({ ok: true, data: stored.data });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "IndexTTS 调用失败。";
          await updateHistoryRecord(recordId, {
            status: "failed",
            error: message,
          });
          return NextResponse.json({ error: message }, { status: 500 });
        }
      },
      async () => {
        await updateHistoryRecord(recordId, { status: "processing" });
      }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "IndexTTS 调用失败。" },
      { status: 500 }
    );
  }
}
