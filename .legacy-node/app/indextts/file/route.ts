import { NextResponse } from "next/server";

const DEFAULT_BASE_URL = "http://localhost:7860/";

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1";

const resolveBaseUrl = (baseUrl?: string) => {
  const resolved =
    baseUrl ?? process.env.INDEX_TTS_BASE_URL ?? DEFAULT_BASE_URL;
  try {
    const parsed = new URL(resolved);
    if (!isLocalHost(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch (err) {
    return null;
  }
};

const extractPathFromUrl = (urlValue: string) => {
  const marker = "/gradio_api/file=";
  try {
    if (urlValue.startsWith("http")) {
      const parsed = new URL(urlValue);
      if (!isLocalHost(parsed.hostname)) {
        return null;
      }
      if (!parsed.pathname.startsWith(marker)) {
        return null;
      }
      return parsed.pathname.slice(marker.length);
    }
  } catch (err) {
    return null;
  }
  if (urlValue.startsWith(marker)) {
    return urlValue.slice(marker.length);
  }
  return null;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const urlParam = searchParams.get("url");
  const pathParam = searchParams.get("path");
  const filenameParam = searchParams.get("filename");
  const baseUrlParam = searchParams.get("baseUrl") ?? undefined;

  if (!urlParam && !pathParam) {
    return NextResponse.json(
      { error: "缺少文件路径。" },
      { status: 400 }
    );
  }

  const resolvedBaseUrl = resolveBaseUrl(baseUrlParam);
  if (!resolvedBaseUrl) {
    return NextResponse.json(
      { error: "服务地址仅允许 localhost 或 127.0.0.1。" },
      { status: 400 }
    );
  }

  let targetUrl: string | null = null;
  let resolvedPath: string | null = null;
  if (urlParam) {
    const extracted = extractPathFromUrl(urlParam);
    if (!extracted) {
      return NextResponse.json(
        { error: "不支持的文件 URL。" },
        { status: 400 }
      );
    }
    const base = new URL(resolvedBaseUrl);
    base.pathname = `/gradio_api/file=${extracted}`;
    base.search = "";
    targetUrl = base.toString();
    resolvedPath = extracted;
  } else if (pathParam) {
    const normalizedPath = pathParam.startsWith("/gradio_api/file=")
      ? pathParam.slice("/gradio_api/file=".length)
      : pathParam;
    const base = new URL(resolvedBaseUrl);
    base.pathname = `/gradio_api/file=${normalizedPath}`;
    base.search = "";
    targetUrl = base.toString();
    resolvedPath = normalizedPath;
  }

  if (!targetUrl) {
    return NextResponse.json(
      { error: "无效的文件请求。" },
      { status: 400 }
    );
  }

  const response = await fetch(targetUrl, { cache: "no-store" });
  if (!response.ok) {
    return NextResponse.json(
      { error: "读取文件失败。" },
      { status: response.status }
    );
  }

  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }
  const resolvedFilename =
    filenameParam ||
    (resolvedPath ? resolvedPath.split("/").filter(Boolean).pop() : null);
  if (resolvedFilename) {
    headers.set("Content-Disposition", `inline; filename="${resolvedFilename}"`);
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");

  return new NextResponse(response.body, {
    status: response.status,
    headers,
  });
}
