import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Captions,
  ChevronRight,
  Clock3,
  Download,
  FileAudio,
  History,
  Loader2,
  Mic2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Video,
  Volume2,
  X,
  Trash2,
  RefreshCw
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// --- 后端数据类型 ---
type HistoryStatus = "queued" | "processing" | "paused" | "cancelled" | "success" | "failed";
type Segment = { index: number; text: string; filename: string; path: string; url: string; size: number; };
type HistoryRecord = {
  id: string; createdAt: string; completedAt?: string; text: string;
  sentenceCount: number; processedCount: number; status: HistoryStatus;
  error?: string; mergedUrl?: string; mergedPath?: string; mergedFilename?: string;
  emoWeight?: number; segments: Segment[];
};

type SentenceStatus = "done" | "pending" | "selected" | "generating";

type Sentence = {
  id: number;
  text: string;
  status: SentenceStatus;
};

type WorkflowItem = {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  glow: string;
};

const WORKFLOWS: WorkflowItem[] = [
  {
    title: "视频转音频",
    subtitle: "抽离人声、素材音轨、参考音色",
    icon: Video,
    glow: "from-cyan-500/15 to-blue-500/5",
  },
  {
    title: "音频转视频",
    subtitle: "后期可接口播图像、字幕、镜头脚本",
    icon: Mic2,
    glow: "from-fuchsia-500/15 to-violet-500/5",
  },
  {
    title: "字幕提取",
    subtitle: "拆句、打轴、句子清洗",
    icon: Captions,
    glow: "from-emerald-500/15 to-teal-500/5",
  },
  {
    title: "音频裁切",
    subtitle: "片段提取、静音移除、头尾修整",
    icon: Scissors,
    glow: "from-amber-500/15 to-orange-500/5",
  },
];

const AUDIO_BAR_HEIGHTS = [20, 34, 24, 30, 42, 28, 46, 22, 32, 38, 26, 40, 24, 36, 30, 27, 44, 24, 31, 39];

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function getBadgeLabel(status: HistoryStatus | SentenceStatus) {
  const labelMap: Record<string, string> = {
    done: "已完成",
    success: "已完成",
    pending: "待生成",
    queued: "待生成",
    selected: "编辑中",
    generating: "生成中",
    processing: "生成中",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停"
  };
  return labelMap[status] || status;
}

export function countParagraphs(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\n+/).filter(Boolean).length;
}

export function estimateSentences(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed
    .split(/[.!?。！？]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function Badge({ status }: { status: HistoryStatus | SentenceStatus }) {
  const styles: Record<string, string> = {
    done: "border-emerald-200 bg-emerald-50 text-emerald-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    pending: "border-slate-200 bg-slate-50 text-slate-600",
    queued: "border-slate-200 bg-slate-50 text-slate-600",
    selected: "border-violet-200 bg-violet-50 text-violet-700",
    generating: "border-amber-200 bg-amber-50 text-amber-700",
    processing: "border-amber-200 bg-amber-50 text-amber-700",
    failed: "border-rose-200 bg-rose-50 text-rose-700",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        styles[status] || styles.pending
      )}
    >
      {(status === "generating" || status === "processing") ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
      {getBadgeLabel(status)}
    </span>
  );
}

function SectionTitle({
  icon,
  title,
  extra,
}: {
  icon: React.ReactNode;
  title: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
          {icon}
        </div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      {extra}
    </div>
  );
}

function WorkflowModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="w-full max-w-4xl overflow-hidden rounded-[32px] border border-white/70 bg-white shadow-[0_30px_120px_rgba(15,23,42,0.18)]"
          >
            <div className="border-b border-slate-100 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                    Workflow Hub
                  </div>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                    工作流工具箱
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    次级能力、扩展工具、未来新增功能都放这里，不挤占主工作区。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
                  aria-label="关闭工作流工具箱"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="max-h-[70vh] overflow-auto px-6 py-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {WORKFLOWS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.title}
                      type="button"
                      className="group relative overflow-hidden rounded-[28px] border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:shadow-lg"
                    >
                      <div
                        className={cn(
                          "absolute inset-0 bg-gradient-to-br opacity-70 transition group-hover:opacity-90",
                          item.glow
                        )}
                      />
                      <div className="relative flex items-start gap-4">
                        <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-slate-950 text-white shadow-lg shadow-slate-300">
                          <Icon className="h-6 w-6" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-lg font-semibold text-slate-900">{item.title}</div>
                            <ChevronRight className="h-5 w-5 text-slate-400 transition group-hover:translate-x-0.5" />
                          </div>
                          <div className="mt-2 text-sm leading-6 text-slate-600">{item.subtitle}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  className="flex min-h-[196px] items-center justify-center rounded-[28px] border border-dashed border-slate-300 bg-slate-50 p-5 text-center transition hover:border-violet-300 hover:bg-violet-50"
                >
                  <div>
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-white shadow-sm">
                      <Plus className="h-6 w-6 text-slate-500" />
                    </div>
                    <div className="mt-4 text-lg font-semibold text-slate-900">新增工具入口</div>
                    <div className="mt-2 text-sm leading-6 text-slate-500">
                      后续能力继续往这里长，不污染主页面布局。
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function WaveBars() {
  return (
    <div className="mb-2 flex h-16 items-end gap-1 overflow-hidden rounded-xl px-1">
      {AUDIO_BAR_HEIGHTS.map((height, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0.55 }}
          animate={{ opacity: [0.45, 0.9, 0.55], y: [0, -1, 0] }}
          transition={{
            duration: 2.4 + (i % 4) * 0.25,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.04,
          }}
          style={{ height: `${height}px` }}
          className={cn(
            "w-2 shrink-0 rounded-full",
            i % 4 === 0 ? "bg-violet-300" : i % 3 === 0 ? "bg-cyan-300" : "bg-slate-300"
          )}
        />
      ))}
    </div>
  );
}

const resolveAssetUrl = (url?: string, path?: string) => url || (path ? `http://localhost:5173/sandbox/${path}` : null);
const formatTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};
const displayFilename = (path: string | null, placeholder: string) => path ? path.split(/[\\/]/).pop() : placeholder;

export default function App() {
  // --- 状态管理 ---
  const [scriptText, setScriptText] = useState("");
  const [promptPath, setPromptPath] = useState<string | null>(null);
  const [emotionPath, setEmotionPath] = useState<string | null>(null);
  const [emoWeight, setEmoWeight] = useState(100);
  
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [isWorkflowModalOpen, setIsWorkflowModalOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);

  // 编辑逻辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftText, setDraftText] = useState<string>("");

  const currentRecord = useMemo(() => focusTaskId ? history.find(h => h.id === focusTaskId) || null : history[0] || null, [focusTaskId, history]);

  const sentences: Sentence[] = useMemo(() => {
    if (!currentRecord) return [];
    return currentRecord.segments.map(seg => ({
      id: seg.index,
      text: seg.text,
      status: currentRecord.status === "processing" && seg.index > currentRecord.processedCount ? "pending" : 
              currentRecord.status === "processing" && seg.index === currentRecord.processedCount + 1 ? "generating" : "done"
    }));
  }, [currentRecord]);

  const fetchHistory = useCallback(async (silent = false) => {
    if (!silent) setHistoryLoading(true);
    try {
      const records: HistoryRecord[] = await invoke("get_history");
      setHistory(records);
    } catch (err) { console.error(err); }
    finally { if (!silent) setHistoryLoading(false); }
  }, []);

  useEffect(() => {
    fetchHistory();
    const timer = setInterval(() => fetchHistory(true), 2000);
    return () => clearInterval(timer);
  }, [fetchHistory]);

  const scriptCharCount = scriptText.trim().length;
  const scriptParagraphCount = countParagraphs(scriptText);
  const scriptSentenceEstimate = estimateSentences(scriptText);
  const doneCount = currentRecord?.processedCount ?? 0;
  const progressPercent = currentRecord ? Math.round((currentRecord.processedCount / currentRecord.sentenceCount) * 100) : 0;

  const editingSentence = useMemo(
    () => sentences.find((item) => item.id === editingId) ?? null,
    [sentences, editingId]
  );
  const isDraftDirty = editingSentence ? draftText !== editingSentence.text : false;

  // --- 交互逻辑 ---
  const handleSelectSentence = (sentence: Sentence) => {
    if (sentence.status !== "generating") {
      setEditingId(sentence.id);
      setDraftText(sentence.text);
    }
  };

  const handleSaveSentence = () => {
    setEditingId(null);
    // 这里仅做 UI 模拟保存，真实后端逻辑暂不支持单句实时修改保存
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  const handleGenerate = async () => {
    if (!scriptText.trim() || !promptPath || !emotionPath) return;
    setSubmitting(true);
    try {
      const id: string = await invoke("generate_tts", { text: scriptText, promptPath, emotionPath, emoWeight: emoWeight / 100 });
      setFocusTaskId(id);
      await fetchHistory(true);
    } catch (err) { alert(String(err)); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_history", { id });
      setHistory((prev) => prev.filter((h) => h.id !== id));
      if (focusTaskId === id) setFocusTaskId(null);
    } catch (e) { console.error(e); }
  };

  const pickFile = async (setter: (p: string | null) => void) => {
    const selected = await open({ multiple: false, filters: [{ name: "音频文件", extensions: ["wav", "mp3"] }] });
    if (selected && typeof selected === "string") setter(selected);
  };

  return (
    <div className="min-h-screen overflow-x-hidden overflow-y-auto bg-[radial-gradient(circle_at_0%_0%,rgba(99,102,241,0.12),transparent_28%),radial-gradient(circle_at_100%_0%,rgba(244,114,182,0.12),transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eef2ff_55%,#f8fafc_100%)] text-slate-900">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div animate={{ x: [0, 35, -12, 0], y: [0, 18, -8, 0] }} transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }} className="absolute left-[-80px] top-[-50px] h-72 w-72 rounded-full bg-violet-300/20 blur-3xl" />
        <motion.div animate={{ x: [0, -30, 20, 0], y: [0, -10, 24, 0] }} transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }} className="absolute right-[-60px] top-[120px] h-72 w-72 rounded-full bg-cyan-300/20 blur-3xl" />
      </div>

      <div className="relative min-h-screen w-full">
        <div className="overflow-hidden bg-white/75 backdrop-blur-xl min-h-screen w-full flex flex-col">
          <div className="border-b border-slate-100 bg-white px-6 py-4 flex-shrink-0">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-500 text-white shadow-[0_10px_24px_rgba(99,102,241,0.18)]">
                  <AudioLines className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-[22px] font-semibold tracking-[-0.04em] text-slate-950">
                    TTS 工作台
                  </h1>
                </div>
              </div>

              <div className="flex shrink-0 items-stretch gap-3">
                <div className="flex h-14 items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 shadow-sm">
                  <div className="min-w-[132px]">
                    <div className="text-[11px] font-medium leading-none text-slate-500">当前进度</div>
                    <div className="mt-2 flex items-center gap-2 text-sm leading-none">
                      <span className="font-semibold text-slate-950">{doneCount}</span>
                      <span className="text-slate-300">/</span>
                      <span className="text-slate-600">{currentRecord?.sentenceCount || 0} 句</span>
                      <span className="text-slate-300">·</span>
                      <span className="font-medium text-emerald-600">{progressPercent}%</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleGenerate}
                  disabled={submitting || !scriptText || !promptPath || !emotionPath}
                  type="button"
                  className={cn("inline-flex h-14 items-center gap-2 rounded-2xl px-6 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(15,23,42,0.16)] transition", (submitting || !scriptText || !promptPath || !emotionPath) ? "bg-slate-300" : "bg-slate-950 hover:bg-slate-900")}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  开始生成
                </button>
                <button
                  onClick={() => setIsWorkflowModalOpen(true)}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 transition"
                >
                   <Plus className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col lg:grid lg:grid-cols-12 items-start gap-0 overflow-hidden">
            <aside className="w-full lg:col-span-3 lg:border-r border-slate-100 bg-white/55 p-5 overflow-y-auto">
              <SectionTitle icon={<SlidersHorizontal className="h-4 w-4" />} title="任务设置" />

              <div className="space-y-4">
                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <label className="block text-sm font-medium text-slate-700">文案输入</label>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1">{scriptCharCount} 字符</span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1">约 {scriptSentenceEstimate} 句</span>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <textarea
                      value={scriptText}
                      onChange={(e) => setScriptText(e.target.value)}
                      placeholder={`把要合成的整段文案直接粘贴到这里。\n\n支持多段文本，后续会自动拆句并进入中间队列。`}
                      className="min-h-[220px] w-full resize-none rounded-xl border border-transparent bg-white px-4 py-3 text-[15px] leading-7 text-slate-900 outline-none transition focus:border-violet-200 focus:ring-4 focus:ring-violet-100"
                    />

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={handleGenerate}
                          type="button"
                          className="rounded-xl bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90"
                        >
                          自动拆句
                        </button>
                        <button
                          onClick={() => setScriptText("")}
                          type="button"
                          className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                        >
                          清空
                        </button>
                      </div>

                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{scriptParagraphCount} 段</span>
                        <span className="text-slate-300">•</span>
                        <span>粘贴后即可继续处理</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3">
                  <button onClick={() => pickFile(setPromptPath)} type="button" className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-violet-200 hover:bg-violet-50/40">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700"><FileAudio className="h-5 w-5" /></div>
                      <div>
                        <div className="text-sm font-semibold text-slate-900">音色参考</div>
                        <div className="text-xs text-slate-500 truncate max-w-[120px]">{displayFilename(promptPath, "拖入音频文件或选择素材")}</div>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                  <button onClick={() => pickFile(setEmotionPath)} type="button" className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-violet-200 hover:bg-violet-50/40">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700"><AudioLines className="h-5 w-5" /></div>
                      <div>
                        <div className="text-sm font-semibold text-slate-900">情绪参考</div>
                        <div className="text-xs text-slate-500 truncate max-w-[120px]">{displayFilename(emotionPath, "用样本控制语气、节奏、起伏")}</div>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">情绪强度</label>
                    <span className="text-sm font-semibold text-slate-900">{(emoWeight/100).toFixed(1)}</span>
                  </div>
                  <input type="range" min="0" max="100" value={emoWeight} onChange={e => setEmoWeight(Number(e.target.value))} className="w-full accent-violet-600" />
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-400"><span>平稳</span><span>浓烈</span></div>
                </div>
              </div>
            </aside>

            <main className="w-full lg:col-span-6 bg-white/38 p-5 lg:border-r border-slate-100 flex flex-col overflow-hidden">
              <SectionTitle
                icon={<Search className="h-4 w-4" />}
                title="句子队列"
                extra={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                      已完成 {doneCount}
                    </span>
                    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                      生成中 {currentRecord?.status === "processing" ? 1 : 0}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      待处理 {currentRecord ? currentRecord.sentenceCount - currentRecord.processedCount : 0}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 shadow-sm">
                      当前进度 {doneCount} / {currentRecord?.sentenceCount || 0}
                    </span>
                  </div>
                }
              />

              <div className="flex-1 overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-sm flex flex-col">
                <div className="border-b border-slate-100 bg-slate-50/90 px-4 py-3 backdrop-blur-sm">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                      <Search className="h-4 w-4 text-slate-400" />
                      <span className="text-sm text-slate-400">搜索句子、状态或关键词</span>
                    </div>
                    <button type="button" className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50">全部状态</button>
                    <button type="button" className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50">批量操作</button>
                    <RefreshCw onClick={() => fetchHistory()} className={cn("h-4 w-4 text-slate-400 cursor-pointer", historyLoading && "animate-spin")} />
                  </div>
                </div>

                <div className="flex-1 overflow-auto">
                  {sentences.map((item) => {
                    const isEditing = item.id === editingId;
                    const isCurrent = currentRecord?.status === "processing" && item.id === currentRecord.processedCount + 1;
                    const visualStatus: HistoryStatus | SentenceStatus = item.status;

                    return (
                      <div key={item.id} className={cn("border-b border-slate-100 transition", isEditing ? "bg-violet-50/45" : isCurrent ? "bg-slate-50/70" : "bg-white hover:bg-slate-50")}>
                        <div className={cn("grid items-start gap-3 px-4 transition-all duration-200", isEditing ? "grid-cols-[74px_minmax(0,1fr)_180px_36px] py-3" : "grid-cols-[74px_1fr_120px_36px] py-4")}>
                          <button type="button" onClick={() => handleSelectSentence(item)} className={cn("pt-1 text-left text-sm font-semibold", isEditing ? "text-violet-500" : isCurrent ? "text-slate-700" : "text-slate-400")}>#{item.id}</button>
                          <div className="min-w-0 pr-2">
                            {item.status === "generating" ? (
                              <div className="space-y-2 py-2"><div className="h-3.5 w-4/5 animate-pulse rounded-full bg-slate-200" /><div className="h-3.5 w-2/3 animate-pulse rounded-full bg-slate-200" /></div>
                            ) : isEditing ? (
                              <div className="rounded-2xl border border-violet-200 bg-white px-4 py-3 shadow-sm">
                                <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={2} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSaveSentence(); } if (e.key === "Escape") { e.preventDefault(); handleCancelEdit(); } }} className="w-full resize-none bg-transparent text-[15px] leading-7 text-slate-900 outline-none" />
                                <div className="mt-2 text-[11px] text-slate-400">⌘/Ctrl + Enter 保存，Esc 取消</div>
                              </div>
                            ) : (
                              <button type="button" onClick={() => handleSelectSentence(item)} className="w-full text-left text-[15px] leading-7 text-slate-800">{item.text}</button>
                            )}
                          </div>
                          <div className="flex min-w-0 justify-end pt-0.5">
                            {isEditing ? (
                              <div className="flex w-full flex-col items-end gap-2">
                                <Badge status="selected" />
                                <div className="flex flex-wrap justify-end gap-2">
                                  <button type="button" onClick={handleSaveSentence} disabled={!isDraftDirty} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition", isDraftDirty ? "bg-violet-600 text-white shadow-md shadow-violet-200 hover:-translate-y-0.5" : "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400")}>保存</button>
                                  <button type="button" onClick={handleCancelEdit} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50">取消编辑</button>
                                </div>
                              </div>
                            ) : <Badge status={visualStatus} />}
                          </div>
                          <div className="flex justify-end pt-1 text-slate-400">
                            <button type="button" className="rounded-lg p-1 transition hover:bg-slate-100 hover:text-slate-700"><MoreHorizontal className="h-4 w-4" /></button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {sentences.length === 0 && <div className="py-20 text-center text-slate-300 font-bold">请选择历史任务</div>}
                </div>
              </div>
            </main>

            <aside className="w-full lg:col-span-3 border-l border-slate-100 bg-white/55 p-5 overflow-y-auto">
              <div className="space-y-4">
                <div className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
                  <SectionTitle
                    icon={<Volume2 className="h-4 w-4" />}
                    title="播放预览"
                    extra={
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-slate-50 border border-slate-100 px-2 py-1 text-[10px] font-bold text-slate-400">
                          {currentRecord?.status === "success" ? "已就绪" : "准备中"}
                        </span>
                        {currentRecord?.mergedUrl && (
                          <button
                            onClick={() => window.open(resolveAssetUrl(currentRecord.mergedUrl, currentRecord.mergedPath) || "#")}
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-950 text-white shadow-sm hover:bg-slate-800 transition"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    }
                  />

                  <div className="rounded-[24px] border border-slate-200 bg-white p-5">
                    <div className="flex items-center justify-center gap-3 mb-6">
                      <button
                        type="button"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50"
                      >
                        <SkipBack className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-[0_12px_24px_rgba(15,23,42,0.18)]"
                      >
                        <Play className="h-5 w-5 fill-white" />
                      </button>
                      <button
                        type="button"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50"
                      >
                        <Pause className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50"
                      >
                        <SkipForward className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="space-y-5">
                      <div>
                        <div className="mb-2 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                          <span>00:00</span>
                          <span>进度</span>
                          <span>00:00</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          defaultValue="0"
                          className="w-full accent-slate-900"
                        />
                      </div>

                      <div className="pt-4 border-t border-slate-100 flex items-center gap-3">
                        <Volume2 className="h-4 w-4 text-slate-400" />
                        <div className="flex-1">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            defaultValue="100"
                            className="w-full accent-slate-900 h-1"
                          />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400">100%</span>
                      </div>
                    </div>
                    
                    {currentRecord?.mergedUrl && (
                      <div className="mt-4 pt-4 border-t border-slate-100 opacity-30 grayscale">
                        <audio controls src={resolveAssetUrl(currentRecord.mergedUrl, currentRecord.mergedPath) || ""} className="w-full h-6" />
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
                  <SectionTitle icon={<History className="h-4 w-4" />} title="历史记录" extra={<RotateCcw onClick={() => fetchHistory()} className="h-4 w-4 text-slate-400 cursor-pointer" />} />
                  <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
                    {history.map((item) => (
                      <div key={item.id} onClick={() => setFocusTaskId(item.id)} className={cn("group relative rounded-2xl border p-4 transition-all cursor-pointer", focusTaskId === item.id ? "bg-violet-50/40 border-violet-200" : "bg-slate-50 border-slate-200 hover:bg-violet-50/40 hover:border-violet-200")}>
                        <div className="mb-2 flex items-start justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-900 truncate pr-4">{item.text}</div>
                          <span className="rounded-full bg-white px-2 py-1 text-xs text-slate-500">{item.processedCount}/{item.sentenceCount}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1 font-bold"><Clock3 className="h-3.5 w-3.5" />{formatTime(item.createdAt)}</span>
                          <button onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }} className="p-1 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={14}/></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
      <WorkflowModal open={isWorkflowModalOpen} onClose={() => setIsWorkflowModalOpen(false)} />
    </div>
  );
}
