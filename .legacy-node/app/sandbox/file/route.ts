import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import fs from "fs/promises";
import { resolveSandboxFile } from "@/lib/sandboxFs";

const authorize = (request: Request) => {
  const token = process.env.APP_SANDBOX_TOKEN;
  if (!token) {
    return true;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const headerToken = request.headers.get("x-sandbox-token") ?? "";
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") ?? "";
  return bearer === token || headerToken === token || queryToken === token;
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
    case ".flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
};

const parseRange = (rangeHeader: string | null, size: number) => {
  if (!rangeHeader) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return null;
  }
  const startRaw = match[1];
  const endRaw = match[2];
  let start: number | null =
    startRaw === "" ? null : Number.parseInt(startRaw, 10);
  let end: number | null = endRaw === "" ? null : Number.parseInt(endRaw, 10);

  if (start === null && end === null) {
    return null;
  }
  if (start !== null && Number.isNaN(start)) {
    return null;
  }
  if (end !== null && Number.isNaN(end)) {
    return null;
  }

  if (start === null) {
    const length = end ?? 0;
    if (length <= 0) {
      return null;
    }
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    if (end === null || end >= size) {
      end = size - 1;
    }
  }

  if (start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end };
};

export async function GET(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "未授权。" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const pathParam = searchParams.get("path");
  if (!pathParam) {
    return NextResponse.json(
      { ok: false, error: "缺少 path。" },
      { status: 400 }
    );
  }
  try {
    const fileInfo = await resolveSandboxFile(pathParam);
    const stat = await fs.lstat(fileInfo.absolute);
    if (!stat.isFile()) {
      return NextResponse.json(
        { ok: false, error: "目标不是文件。" },
        { status: 400 }
      );
    }
    const filename = path.basename(fileInfo.relative || "file");
    const headers = new Headers();
    headers.set("Content-Type", guessContentType(filename));
    headers.set("Content-Disposition", `inline; filename="${filename}"`);
    headers.set("Cache-Control", "no-store");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Access-Control-Allow-Origin", "*");

    const range = parseRange(request.headers.get("range"), stat.size);
    if (range) {
      const { start, end } = range;
      headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      headers.set("Content-Length", `${end - start + 1}`);
      const stream = createReadStream(fileInfo.absolute, { start, end });
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers,
      });
    }

    headers.set("Content-Length", stat.size.toString());
    const stream = createReadStream(fileInfo.absolute);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "读取失败。" },
      { status: 500 }
    );
  }
}
