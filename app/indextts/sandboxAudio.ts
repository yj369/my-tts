import path from "path";
import os from "os";
import fs from "fs/promises";
import { writeFileContent } from "@/lib/sandboxFs";

const GRADIO_MARKER = "/gradio_api/file=";

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1";

const sanitizeFilename = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

const resolveFilename = (
  original?: string,
  sourcePath?: string,
  fallbackExt = ".wav"
) => {
  const rawName =
    original && original.trim()
      ? original.trim()
      : sourcePath
        ? path.basename(sourcePath)
        : "";
  const safeName = sanitizeFilename(rawName || "");
  const ext = path.extname(safeName) || fallbackExt;
  const stem = safeName ? safeName.replace(ext, "") : "indextts";
  const stamp = Date.now();
  const nonce = Math.random().toString(36).slice(2, 6);
  return `${stem || "indextts"}_${stamp}_${nonce}${ext}`;
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
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

const rewriteData = (
  data: unknown,
  url: string,
  relativePath: string,
  filename: string,
  mimeType?: string
) => {
  if (!Array.isArray(data)) {
    return data;
  }
  return data.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as Record<string, unknown>;
    if (record.value && typeof record.value === "object") {
      const nested = record.value as Record<string, unknown>;
      if (typeof nested.url === "string" || typeof nested.path === "string") {
        return {
          ...record,
          value: {
            ...nested,
            url,
            path: relativePath,
            orig_name: filename,
            mime_type: mimeType ?? nested.mime_type,
          },
        };
      }
    }
    if (typeof record.url === "string" || typeof record.path === "string") {
      return {
        ...record,
        url,
        path: relativePath,
        orig_name: filename,
        mime_type: mimeType ?? record.mime_type,
      };
    }
    return item;
  });
};

export const storeIndexTTSAudio = async (data: unknown) => {
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

  const filename = resolveFilename(info.origName, sourcePath);
  const relativePath = path.posix.join("indextts", filename);
  await writeFileContent(relativePath, sourceBuffer.toString("base64"), "base64");
  await deleteSourceFile(sourcePath);

  const params = new URLSearchParams();
  params.set("path", relativePath);
  params.set("t", Date.now().toString());
  const url = `/sandbox/file?${params.toString()}`;
  const updated = rewriteData(
    data,
    url,
    relativePath,
    filename,
    info.mimeType
  );

  return { data: updated, url, path: relativePath, filename };
};
