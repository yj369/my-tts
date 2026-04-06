"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import {
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Waves,
} from "lucide-react";
import { splitTextToSentences } from "./sentence";

type Segment = {
  index: number;
  text: string;
  filename: string;
  path: string;
  url: string;
  size: number;
};

type HistoryStatus =
  | "queued"
  | "processing"
  | "paused"
  | "cancelled"
  | "success"
  | "failed";

type HistoryRecord = {
  id: string;
  createdAt: string;
  completedAt?: string;
  text: string;
  sentenceCount: number;
  processedCount: number;
  status: HistoryStatus;
  error?: string;
  mergedUrl?: string;
  mergedPath?: string;
  mergedFilename?: string;
  emoWeight?: number;
  segments: Segment[];
};

const ACCEPT_AUDIO_INPUT =
  ".wav,.mp3,.m4a,.ogg,.webm,.flac,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/webm,audio/flac";

const STATUS_LABEL: Record<HistoryStatus, string> = {
  queued: "排队中",
  processing: "生成中",
  paused: "已暂停",
  cancelled: "已取消",
  success: "已完成",
  failed: "失败",
};

const statusClassName: Record<HistoryStatus, string> = {
  queued: "text-amber-700 bg-amber-100",
  processing: "text-sky-700 bg-sky-100",
  paused: "text-violet-700 bg-violet-100",
  cancelled: "text-zinc-700 bg-zinc-100",
  success: "text-emerald-700 bg-emerald-100",
  failed: "text-rose-700 bg-rose-100",
};

const formatBytes = (value: number) => {
  if (!value) {
    return "0B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)}${units[index]}`;
};

const formatTime = (value?: string) => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const resolveMergedUrl = (record: HistoryRecord) => {
  if (record.mergedUrl) {
    return record.mergedUrl;
  }
  if (record.mergedPath) {
    return `/sandbox/file?path=${encodeURIComponent(record.mergedPath)}`;
  }
  return null;
};

const resolveSegmentUrl = (segment: Segment) => {
  if (segment.url) {
    return segment.url;
  }
  if (segment.path) {
    return `/sandbox/file?path=${encodeURIComponent(segment.path)}`;
  }
  return null;
};

const isRunningStatus = (status: HistoryStatus) =>
  status === "queued" || status === "processing";

export default function TTSWorkflowPage() {
  const [text, setText] = useState("");
  const [promptFile, setPromptFile] = useState<File | null>(null);
  const [emotionFile, setEmotionFile] = useState<File | null>(null);
  const [emoWeight, setEmoWeight] = useState(1);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);

  const sentencePreview = useMemo(() => splitTextToSentences(text), [text]);

  const fetchHistory = useCallback(async (silent = false) => {
    if (!silent) {
      setHistoryLoading(true);
      setHistoryError(null);
    }

    try {
      const res = await fetch("/history", { cache: "no-store" });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: HistoryRecord[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "读取历史失败。");
      }
      setHistory(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "读取历史失败。");
    } finally {
      if (!silent) {
        setHistoryLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const hasRunningTask = useMemo(
    () => history.some((record) => isRunningStatus(record.status)),
    [history]
  );

  useEffect(() => {
    if (!hasRunningTask) {
      return;
    }
    const timer = setInterval(() => {
      fetchHistory(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [fetchHistory, hasRunningTask]);

  useEffect(() => {
    if (!focusTaskId) {
      return;
    }
    const exists = history.some((item) => item.id === focusTaskId);
    if (!exists) {
      setFocusTaskId(null);
    }
  }, [focusTaskId, history]);

  const currentRecord = useMemo(() => {
    if (focusTaskId) {
      const target = history.find((item) => item.id === focusTaskId);
      if (target) {
        return target;
      }
    }
    return history[0] ?? null;
  }, [focusTaskId, history]);

  const currentMergedUrl = currentRecord ? resolveMergedUrl(currentRecord) : null;
  const currentProgress = currentRecord
    ? currentRecord.sentenceCount > 0
      ? Math.min(
          100,
          Math.round((currentRecord.processedCount / currentRecord.sentenceCount) * 100)
        )
      : 0
    : 0;

  const onFileChange =
    (setter: (file: File | null) => void) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      setter(file);
    };

  const handleGenerate = async () => {
    setError(null);

    if (!text.trim()) {
      setError("请输入文案。");
      return;
    }
    if (!promptFile) {
      setError("请上传语音参考音频。");
      return;
    }
    if (!emotionFile) {
      setError("请上传情感参考音频。");
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("text", text.trim());
      form.append("prompt", promptFile);
      form.append("emotion", emotionFile);
      form.append("emoWeight", emoWeight.toString());
      form.append("source", "ui");

      const res = await fetch("/generate", {
        method: "POST",
        body: form,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: { id?: string };
        error?: string;
      };

      if (!res.ok || !json.ok || !json.data?.id) {
        throw new Error(json.error ?? "提交失败。");
      }

      setFocusTaskId(json.data.id);
      await fetchHistory(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败。");
    } finally {
      setSubmitting(false);
    }
  };

  const handleControl = async (
    id: string,
    action: "pause" | "resume" | "cancel"
  ) => {
    setHistoryError(null);
    setActionPendingId(id);
    try {
      const res = await fetch("/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "任务操作失败。");
      }
      setFocusTaskId(id);
      await fetchHistory(true);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "任务操作失败。");
    } finally {
      setActionPendingId(null);
    }
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      const res = await fetch("/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: HistoryRecord[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "删除失败。");
      }
      setHistory(Array.isArray(json.data) ? json.data : []);
      if (focusTaskId === id) {
        setFocusTaskId(null);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "删除失败。");
    }
  };

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-6 md:py-8 lg:px-8">
      <header className="mb-6 rounded-3xl border border-[var(--wf-line)] bg-[var(--wf-card)] p-5 shadow-sm md:p-6">
        <div className="flex items-center gap-3 text-[var(--wf-primary)]">
          <Waves className="h-5 w-5" />
          <h1 className="text-xl font-black text-[var(--wf-text)] md:text-2xl">语音工作流</h1>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <article className="rounded-3xl border border-[var(--wf-line)] bg-[var(--wf-card)] p-5 shadow-sm md:p-6">
            <h2 className="text-lg font-bold">1. 输入文案与参考音频</h2>

            <label className="mt-4 block text-sm font-semibold text-[var(--wf-sub)]">文案</label>
            <textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="把要生成的文案粘贴到这里..."
              className="mt-2 min-h-40 w-full resize-y rounded-2xl border border-[var(--wf-line)] bg-[#fcfcfb] px-4 py-3 text-sm outline-none ring-[var(--wf-primary)] transition focus:ring-2"
            />

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="rounded-2xl border border-dashed border-[var(--wf-line)] bg-[#fafaf8] p-4 text-sm">
                <div className="font-semibold">语音参考音频</div>
                <div className="mt-1 text-xs text-[var(--wf-sub)]">用于 timbre 参考</div>
                <input
                  type="file"
                  accept={ACCEPT_AUDIO_INPUT}
                  onChange={onFileChange(setPromptFile)}
                  className="mt-3 block w-full text-xs"
                />
                {promptFile && (
                  <p className="mt-2 text-xs text-[var(--wf-sub)]">
                    {promptFile.name} · {formatBytes(promptFile.size)}
                  </p>
                )}
              </label>

              <label className="rounded-2xl border border-dashed border-[var(--wf-line)] bg-[#fafaf8] p-4 text-sm">
                <div className="font-semibold">情感参考音频</div>
                <div className="mt-1 text-xs text-[var(--wf-sub)]">用于 emotion 参考</div>
                <input
                  type="file"
                  accept={ACCEPT_AUDIO_INPUT}
                  onChange={onFileChange(setEmotionFile)}
                  className="mt-3 block w-full text-xs"
                />
                {emotionFile && (
                  <p className="mt-2 text-xs text-[var(--wf-sub)]">
                    {emotionFile.name} · {formatBytes(emotionFile.size)}
                  </p>
                )}
              </label>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--wf-line)] bg-[#fcfcfb] p-4">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-semibold text-[var(--wf-sub)]">
                  情绪控制权重
                </label>
                <span className="text-sm font-semibold text-[var(--wf-text)]">
                  {emoWeight.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={emoWeight}
                onChange={(event) => setEmoWeight(Number(event.target.value))}
                className="mt-2 w-full accent-[var(--wf-primary)]"
              />
              <p className="mt-1 text-xs text-[var(--wf-sub)]">
                0 表示弱情绪，1 表示强情绪。默认 1.00。
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--wf-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--wf-primary-hover)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {submitting ? "提交中..." : "开始生成"}
              </button>
              <span className="text-xs text-[var(--wf-sub)]">句子数: {sentencePreview.length || 0}</span>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {error}
              </div>
            )}
          </article>

          <article className="rounded-3xl border border-[var(--wf-line)] bg-[var(--wf-card)] p-5 shadow-sm md:p-6">
            <div className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-[var(--wf-primary)]" />
              <h2 className="text-lg font-bold">2. 断句预览</h2>
            </div>

            {sentencePreview.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--wf-sub)]">输入文案后自动显示断句结果。</p>
            ) : (
              <ol className="mt-3 space-y-2">
                {sentencePreview.map((sentence, index) => (
                  <li
                    key={`${index + 1}-${sentence.slice(0, 10)}`}
                    className="rounded-xl border border-[var(--wf-line)] bg-[#fcfcfb] px-3 py-2 text-sm"
                  >
                    <span className="mr-2 text-xs text-[var(--wf-sub)]">#{index + 1}</span>
                    {sentence}
                  </li>
                ))}
              </ol>
            )}
          </article>

          {currentRecord && (
            <article className="rounded-3xl border border-[var(--wf-line)] bg-[var(--wf-card)] p-5 shadow-sm md:p-6">
              <h2 className="text-lg font-bold">3. 当前任务</h2>
              <p className="mt-1 text-xs text-[var(--wf-sub)]">任务 ID: {currentRecord.id}</p>

              <div className="mt-4 rounded-2xl border border-[var(--wf-line)] bg-[#fcfcfb] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClassName[currentRecord.status]}`}
                  >
                    {STATUS_LABEL[currentRecord.status]}
                  </span>
                  <span className="text-xs text-[var(--wf-sub)]">
                    {currentRecord.processedCount}/{currentRecord.sentenceCount}
                  </span>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#e8e8e3]">
                  <div
                    className="h-full rounded-full bg-[var(--wf-primary)] transition-all"
                    style={{ width: `${currentProgress}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-[var(--wf-sub)]">进度 {currentProgress}%</p>
                <p className="mt-1 text-xs text-[var(--wf-sub)]">
                  情绪权重: {(currentRecord.emoWeight ?? 1).toFixed(2)}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {isRunningStatus(currentRecord.status) && (
                    <button
                      type="button"
                      disabled={actionPendingId === currentRecord.id}
                      onClick={() => handleControl(currentRecord.id, "pause")}
                      className="inline-flex items-center gap-1 rounded-lg border border-violet-200 px-2.5 py-1.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-60"
                    >
                      <Pause className="h-3.5 w-3.5" /> 暂停
                    </button>
                  )}
                  {(currentRecord.status === "paused" ||
                    currentRecord.status === "failed" ||
                    currentRecord.status === "cancelled") && (
                    <button
                      type="button"
                      disabled={actionPendingId === currentRecord.id}
                      onClick={() => handleControl(currentRecord.id, "resume")}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                    >
                      <Play className="h-3.5 w-3.5" /> 断点续跑
                    </button>
                  )}
                  {(isRunningStatus(currentRecord.status) || currentRecord.status === "paused") && (
                    <button
                      type="button"
                      disabled={actionPendingId === currentRecord.id}
                      onClick={() => handleControl(currentRecord.id, "cancel")}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                    >
                      <Square className="h-3.5 w-3.5" /> 取消
                    </button>
                  )}
                </div>
              </div>

              {currentMergedUrl && (
                <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-semibold text-emerald-800">整段合并音频</p>
                  <audio className="mt-2 w-full" controls src={currentMergedUrl} preload="none" />
                </div>
              )}

              {currentRecord.error && (
                <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {currentRecord.error}
                </p>
              )}

              {currentRecord.segments.length > 0 && (
                <div className="mt-4 space-y-3">
                  {currentRecord.segments.map((segment) => {
                    const segmentUrl = resolveSegmentUrl(segment);
                    return (
                      <div
                        key={`${currentRecord.id}-${segment.index}`}
                        className="rounded-2xl border border-[var(--wf-line)] bg-[#fcfcfb] p-3"
                      >
                        <p className="text-sm font-semibold">
                          句子 #{segment.index}: {segment.text}
                        </p>
                        {segmentUrl ? (
                          <audio className="mt-2 w-full" controls src={segmentUrl} preload="none" />
                        ) : (
                          <p className="mt-2 text-xs text-[var(--wf-sub)]">句子音频不可用</p>
                        )}
                        <p className="mt-1 text-xs text-[var(--wf-sub)]">
                          {segment.filename} · {formatBytes(segment.size)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          )}
        </div>

        <aside className="rounded-3xl border border-[var(--wf-line)] bg-[var(--wf-card)] p-5 shadow-sm md:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold">历史记录</h2>
            <button
              type="button"
              onClick={() => fetchHistory()}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--wf-line)] px-3 py-1.5 text-xs hover:bg-[#f7f7f4]"
            >
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </button>
          </div>

          {historyLoading && <p className="mt-3 text-sm text-[var(--wf-sub)]">加载中...</p>}
          {historyError && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{historyError}</p>
          )}

          {!historyLoading && history.length === 0 && (
            <p className="mt-3 text-sm text-[var(--wf-sub)]">暂无历史记录</p>
          )}

          <div className="mt-4 space-y-4">
            {history.map((record) => {
              const mergedUrl = resolveMergedUrl(record);
              const isCurrent = currentRecord?.id === record.id;
              const pending = actionPendingId === record.id;
              return (
                <article
                  key={record.id}
                  className={`rounded-2xl border bg-[#fcfcfb] p-4 ${
                    isCurrent
                      ? "border-[var(--wf-primary)] ring-2 ring-[var(--wf-primary)]/20"
                      : "border-[var(--wf-line)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-[var(--wf-sub)]">{formatTime(record.createdAt)}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClassName[record.status]}`}
                        >
                          {STATUS_LABEL[record.status]}
                        </span>
                        <span className="text-xs text-[var(--wf-sub)]">
                          {record.processedCount}/{record.sentenceCount}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteHistory(record.id)}
                      className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-[var(--wf-text)]">{record.text}</p>
                  <p className="mt-1 text-xs text-[var(--wf-sub)]">
                    情绪权重: {(record.emoWeight ?? 1).toFixed(2)}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setFocusTaskId(record.id)}
                      className="rounded-lg border border-[var(--wf-line)] px-2.5 py-1.5 text-xs hover:bg-white"
                    >
                      查看
                    </button>

                    {isRunningStatus(record.status) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => handleControl(record.id, "pause")}
                        className="inline-flex items-center gap-1 rounded-lg border border-violet-200 px-2.5 py-1.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-60"
                      >
                        <Pause className="h-3.5 w-3.5" /> 暂停
                      </button>
                    )}

                    {(record.status === "paused" ||
                      record.status === "failed" ||
                      record.status === "cancelled") && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => handleControl(record.id, "resume")}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                      >
                        <Play className="h-3.5 w-3.5" /> 断点续跑
                      </button>
                    )}

                    {(isRunningStatus(record.status) || record.status === "paused") && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => handleControl(record.id, "cancel")}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                      >
                        <Square className="h-3.5 w-3.5" /> 取消
                      </button>
                    )}
                  </div>

                  {record.error && (
                    <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-700">{record.error}</p>
                  )}

                  {mergedUrl && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold text-[var(--wf-sub)]">合并音频</p>
                      <audio className="mt-1 w-full" controls src={mergedUrl} preload="none" />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </aside>
      </section>
    </main>
  );
}
