import fs from "fs/promises";
import os from "os";
import path from "path";
import { writeFileContent } from "@/lib/sandboxFs";

const GRADIO_MARKER = "/gradio_api/file=";

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1";

const sanitizeFilename = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const guessExtByMime = (mimeType?: string) => {
  const lower = (mimeType ?? "").toLowerCase();
  if (lower.includes("audio/mpeg") || lower.includes("audio/mp3")) {
    return ".mp3";
  }
  if (lower.includes("audio/mp4") || lower.includes("audio/x-m4a")) {
    return ".m4a";
  }
  if (lower.includes("audio/ogg")) {
    return ".ogg";
  }
  if (lower.includes("audio/webm")) {
    return ".webm";
  }
  return ".wav";
};

const resolveFilename = (
  options: {
    original?: string;
    sourcePath?: string;
    fallbackExt?: string;
    prefix?: string;
  } = {}
) => {
  const fallbackExt = options.fallbackExt ?? ".wav";
  const rawName =
    options.original && options.original.trim()
      ? options.original.trim()
      : options.sourcePath
        ? path.basename(options.sourcePath)
        : "";

  const safeName = sanitizeFilename(rawName);
  const safePrefix = sanitizeFilename(options.prefix ?? "");
  const ext = path.extname(safeName) || fallbackExt;
  const stem = safeName ? safeName.replace(ext, "") : "workflow";

  if (safePrefix) {
    return `${safePrefix}${ext}`;
  }

  const stamp = Date.now();
  const nonce = Math.random().toString(36).slice(2, 7);
  return `${stem || "workflow"}_${stamp}_${nonce}${ext}`;
};

const extractPathFromUrl = (urlValue?: string) => {
  if (!urlValue) {
    return null;
  }
  try {
    const parsed = new URL(urlValue);
    if (!isLocalHost(parsed.hostname)) {
      return null;
    }
    if (!parsed.pathname.startsWith(GRADIO_MARKER)) {
      return null;
    }
    const raw = parsed.pathname.slice(GRADIO_MARKER.length);
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

const isSafeTempPath = (value: string) => {
  if (!path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.normalize(value);
  if (!normalized.includes(`${path.sep}gradio${path.sep}`)) {
    return false;
  }
  const tmpDir = path.normalize(os.tmpdir());
  const tmpPrivate = path.normalize(path.join("/private", tmpDir));
  return (
    normalized.startsWith(tmpDir) ||
    normalized.startsWith(tmpPrivate) ||
    normalized.startsWith("/tmp") ||
    normalized.startsWith("/private/tmp") ||
    normalized.startsWith("/private/var/folders") ||
    normalized.startsWith("/var/folders")
  );
};

const readSourceBuffer = async (sourcePath?: string) => {
  if (!sourcePath || !isSafeTempPath(sourcePath)) {
    return null;
  }
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new Error("生成文件不是普通文件。");
  }
  const buffer = await fs.readFile(sourcePath);
  return { buffer, sourcePath };
};

const fetchSourceBuffer = async (sourceUrl?: string) => {
  if (!sourceUrl) {
    return null;
  }
  try {
    const parsed = new URL(sourceUrl);
    if (!isLocalHost(parsed.hostname)) {
      return null;
    }
    const response = await fetch(parsed.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error("无法读取生成文件。");
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
};

const deleteSourceFile = async (sourcePath?: string) => {
  if (!sourcePath || !isSafeTempPath(sourcePath)) {
    return;
  }
  try {
    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile()) {
      return;
    }
    await fs.unlink(sourcePath);
  } catch {
    return;
  }
};

type IndexTTSFileInfo = {
  url?: string;
  path?: string;
  origName?: string;
  mimeType?: string;
};

const extractFileInfo = (data: unknown): IndexTTSFileInfo | null => {
  const list = Array.isArray(data) ? data : [data];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const nested =
      record.value && typeof record.value === "object"
        ? (record.value as Record<string, unknown>)
        : record;

    const url = typeof nested.url === "string" ? nested.url : undefined;
    const pathValue = typeof nested.path === "string" ? nested.path : undefined;
    const origName =
      typeof nested.orig_name === "string" ? nested.orig_name : undefined;
    const mimeType =
      typeof nested.mime_type === "string" ? nested.mime_type : undefined;

    if (url || pathValue) {
      return { url, path: pathValue, origName, mimeType };
    }
  }
  return null;
};

export type StoredWorkflowAudio = {
  filename: string;
  path: string;
  url: string;
  mimeType?: string;
  size: number;
};

export const buildSandboxFileUrl = (relativePath: string) => {
  const params = new URLSearchParams();
  params.set("path", relativePath);
  params.set("t", Date.now().toString());
  return `/sandbox/file?${params.toString()}`;
};

export const storeUploadedReferenceFile = async (
  file: File,
  directory: string,
  prefix: string
) => {
  const buffer = Buffer.from(await file.arrayBuffer());
  const fallbackExt = guessExtByMime(file.type);
  const filename = resolveFilename({
    original: file.name,
    fallbackExt,
    prefix,
  });
  const relativePath = path.posix.join(directory, filename);
  await writeFileContent(relativePath, buffer.toString("base64"), "base64", true, true);

  return {
    filename,
    path: relativePath,
    url: buildSandboxFileUrl(relativePath),
    size: buffer.length,
    mimeType: file.type || undefined,
  };
};

export const storeWorkflowAudioFromIndexData = async (
  data: unknown,
  options: {
    directory: string;
    prefix?: string;
    fallbackExt?: string;
  }
): Promise<StoredWorkflowAudio> => {
  const info = extractFileInfo(data);
  if (!info) {
    throw new Error("未找到生成的音频文件。");
  }

  const pathFromUrl = extractPathFromUrl(info.url);
  const sourcePath = info.path || pathFromUrl || undefined;
  const sourceBuffer =
    (await readSourceBuffer(sourcePath))?.buffer ??
    (await fetchSourceBuffer(info.url ?? undefined));

  if (!sourceBuffer) {
    throw new Error("无法读取生成音频。");
  }

  const filename = resolveFilename({
    original: info.origName,
    sourcePath,
    fallbackExt: options.fallbackExt ?? guessExtByMime(info.mimeType),
    prefix: options.prefix,
  });

  const relativePath = path.posix.join(options.directory, filename);
  await writeFileContent(relativePath, sourceBuffer.toString("base64"), "base64", true, true);
  await deleteSourceFile(sourcePath);

  return {
    filename,
    path: relativePath,
    url: buildSandboxFileUrl(relativePath),
    size: sourceBuffer.length,
    mimeType: info.mimeType,
  };
};
