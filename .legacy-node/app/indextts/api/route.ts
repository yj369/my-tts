import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { IndexTTS } from "../indexTTS";
import { storeIndexTTSAudio } from "../sandboxAudio";
import { updateHistoryRecord, upsertHistoryRecord } from "../historyStore";
import { getIndexTTSQueueSnapshot, withIndexTTSQueue } from "../queue";

const ACTION_TO_ENDPOINT: Record<string, string> = {
  on_example_click: "/on_example_click",
  on_method_change: "/on_method_change",
  on_experimental_change: "/on_experimental_change",
  on_glossary_checkbox_change: "/on_glossary_checkbox_change",
  on_input_text_change: "/on_input_text_change",
  on_input_text_change_1: "/on_input_text_change_1",
  update_prompt_audio: "/update_prompt_audio",
  on_add_glossary_term: "/on_add_glossary_term",
  on_demo_load: "/on_demo_load",
  gen_single: "/gen_single",
};

const ALLOWED_ENDPOINTS = new Set(Object.values(ACTION_TO_ENDPOINT));

type ApiRequest = {
  action?: string;
  endpoint?: string;
  payload?: Record<string, unknown>;
  baseUrl?: string;
  source?: string;
};

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
      return null;
    }
    return parsed.toString();
  } catch (err) {
    return null;
  }
};

const resolveEndpoint = (action?: string, endpoint?: string) => {
  if (endpoint && ALLOWED_ENDPOINTS.has(endpoint)) {
    return endpoint;
  }
  if (!action) {
    return null;
  }
  return ACTION_TO_ENDPOINT[action] ?? null;
};

const normalizeApiSource = (value?: string | null) => {
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

const fetchBlob = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`无法读取文件：${url}`);
  }
  return await response.blob();
};

const withFileUrls = async (payload: Record<string, unknown>) => {
  const updated = { ...payload };
  const promptUrl = typeof updated.prompt_url === "string" ? updated.prompt_url : "";
  const emoRefUrl =
    typeof updated.emo_ref_url === "string" ? updated.emo_ref_url : "";

  if (promptUrl && !updated.prompt) {
    updated.prompt = await fetchBlob(promptUrl);
  }
  if (emoRefUrl && !updated.emo_ref_path) {
    updated.emo_ref_path = await fetchBlob(emoRefUrl);
  }

  delete updated.prompt_url;
  delete updated.emo_ref_url;
  return updated;
};

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let action: string | undefined;
    let endpoint: string | undefined;
    let payload: Record<string, unknown> = {};
    let baseUrl: string | undefined;
    let source: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      action = form.get("action")?.toString();
      endpoint = form.get("endpoint")?.toString();
      baseUrl = form.get("baseUrl")?.toString();
      source = form.get("source")?.toString();
      const payloadText = form.get("payload")?.toString();
      if (payloadText) {
        payload = JSON.parse(payloadText) as Record<string, unknown>;
      }
      const promptFile = form.get("prompt");
      if (promptFile instanceof File) {
        payload.prompt = promptFile;
      }
      const emoRefFile = form.get("emo_ref_path");
      if (emoRefFile instanceof File) {
        payload.emo_ref_path = emoRefFile;
      }
    } else {
      const body = (await request.json()) as ApiRequest;
      action = body.action;
      endpoint = body.endpoint;
      baseUrl = body.baseUrl;
      payload = body.payload ?? {};
      source = body.source;
    }

    const sourceLabel = resolveApiSource(request.headers, source);
    const resolvedEndpoint = resolveEndpoint(action, endpoint);
    if (!resolvedEndpoint) {
      return NextResponse.json(
        { error: "不支持的 action 或 endpoint。" },
        { status: 400 }
      );
    }

    const resolvedBaseUrl = resolveBaseUrl(baseUrl);
    if (baseUrl && !resolvedBaseUrl) {
      return NextResponse.json(
        { error: "服务地址仅允许 localhost 或 127.0.0.1。" },
        { status: 400 }
      );
    }

    const client = resolvedBaseUrl
      ? IndexTTS.withBaseUrl(resolvedBaseUrl)
      : IndexTTS;

    const resolvedPayload = await withFileUrls(payload);
    if (resolvedEndpoint === "/gen_single") {
      const textValue =
        typeof resolvedPayload.text === "string" ? resolvedPayload.text : "";
      const recordId = randomUUID();
      const queued =
        getIndexTTSQueueSnapshot().size > 0 ? "queued" : "processing";
      await upsertHistoryRecord({
        id: recordId,
        createdAt: new Date().toISOString(),
        text: textValue,
        status: queued,
        source: sourceLabel,
      });

      return await withIndexTTSQueue(
        async () => {
          try {
            const data = await client.predict(resolvedEndpoint, resolvedPayload);
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
    }
    const data = await client.predict(resolvedEndpoint, resolvedPayload);
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "IndexTTS 调用失败。" },
      { status: 500 }
    );
  }
}
