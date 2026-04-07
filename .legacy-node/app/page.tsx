"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Loader2, Pause, Play, RefreshCw, Square, Trash2, FolderOpen, Music } from "lucide-react";
import { splitTextToSentences } from "./sentence";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Segment = {
  index: number; text: string; filename: string; path: string; url: string; size: number;
};

type HistoryStatus = "queued" | "processing" | "paused" | "cancelled" | "success" | "failed";

type HistoryRecord = {
  id: string; createdAt: string; completedAt?: string; text: string;
  sentenceCount: number; processedCount: number; status: HistoryStatus;
  error?: string; mergedUrl?: string; mergedPath?: string; mergedFilename?: string;
  emoWeight?: number; segments: Segment[];
};

const ACCEPT_AUDIO_INPUT = ".wav,.mp3,.m4a,.ogg,.webm,.flac,audio/*";

const STATUS_LABEL: Record<HistoryStatus, string> = {
  queued: "排队中", processing: "生成中", paused: "已暂停",
  cancelled: "已取消", success: "已完成", failed: "出错失败",
};

const formatTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const resolveMergedUrl = (record: HistoryRecord) => {
  if (record.mergedUrl) return record.mergedUrl;
  if (record.mergedPath) return `/sandbox/file?path=${encodeURIComponent(record.mergedPath)}`;
  return null;
};

const resolveSegmentUrl = (segment: Segment) => {
  if (segment.url) return segment.url;
  if (segment.path) return `/sandbox/file?path=${encodeURIComponent(segment.path)}`;
  return null;
};

export default function App() {
  const [text, setText] = useState("");
  const [promptFile, setPromptFile] = useState<File | null>(null);
  const [emotionFile, setEmotionFile] = useState<File | null>(null);
  const [emoWeight, setEmoWeight] = useState(1);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);

  // Video to Audio Feature
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoExtracting, setVideoExtracting] = useState(false);
  const [extractedVideoAudio, setExtractedVideoAudio] = useState<{ url: string, filename: string } | null>(null);

  const sentencePreview = useMemo(() => splitTextToSentences(text), [text]);

  const fetchHistory = useCallback(async (silent = false) => {
    if (!silent) setHistoryLoading(true);
    try {
      const res = await fetch("/history", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "获取历史记录失败");
      setHistory(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    const timer = setInterval(() => fetchHistory(true), 2000);
    return () => clearInterval(timer);
  }, [fetchHistory]);

  const currentRecord = useMemo(() => {
    return focusTaskId ? history.find((h) => h.id === focusTaskId) || null : history[0] || null;
  }, [focusTaskId, history]);

  const handleGenerate = async () => {
    setError(null);
    if (!text.trim()) { setError("请输入要合成的文本。"); return; }
    if (!promptFile) { setError("请上传音色参考文件（Timbre）。"); return; }
    if (!emotionFile) { setError("请上传情感参考文件（Emotion）。"); return; }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("text", text.trim());
      form.append("prompt", promptFile);
      form.append("emotion", emotionFile);
      form.append("emoWeight", emoWeight.toString());
      form.append("source", "ui");

      const res = await fetch("/generate", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "任务提交失败");
      setFocusTaskId(json.data.id);
      await fetchHistory(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "任务提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleControl = async (id: string, action: "pause" | "resume" | "cancel") => {
    setActionPendingId(id);
    try {
      const res = await fetch("/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) await fetchHistory(true);
    } finally {
      setActionPendingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch("/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setHistory(prev => prev.filter(h => h.id !== id));
        if (focusTaskId === id) setFocusTaskId(null);
      }
    } catch (e) { console.error(e); }
  };

  const onFileSelected = (setter: (f: File | null) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    setter(e.target.files?.[0] || null);
  };

  const handleExtractVideo = async () => {
    if (!videoFile) return;
    setVideoExtracting(true);
    try {
      const form = new FormData();
      form.append("video", videoFile);
      const res = await fetch("/api/video-to-audio", { method: "POST", body: form });
      const json = await res.json();
      if (res.ok && json.ok) {
        setExtractedVideoAudio(json.data);
        setVideoFile(null);
      } else {
        alert(json.error || "提取失败");
      }
    } catch (e) {
      alert("提取发生网络错误");
    } finally {
      setVideoExtracting(false);
    }
  };

  const handleApplyExtractedTo = async (target: "prompt" | "emotion") => {
    if (!extractedVideoAudio) return;
    try {
      const res = await fetch(extractedVideoAudio.url);
      const blob = await res.blob();
      const file = new File([blob], extractedVideoAudio.filename, { type: "audio/wav" });
      if (target === "prompt") setPromptFile(file);
      else setEmotionFile(file);
    } catch (e) {
      alert("应用失败");
    }
  };

  const currentMergedUrl = currentRecord ? resolveMergedUrl(currentRecord) : null;

  return (
    <div className="flex h-screen w-full bg-[#f5f5f5] dark:bg-[#1a1a1a] text-[#111] dark:text-[#eee] overflow-hidden font-sans">
      
      {/* Sidebar: MacOS Column Style */}
      <aside className="w-[300px] border-r border-[#e0e0e0] dark:border-[#333] flex flex-col bg-[#fff] dark:bg-[#242424] shrink-0">
        <div className="p-3 border-b border-[#e0e0e0] dark:border-[#333] flex justify-between items-center bg-[#fdfdfd] dark:bg-[#242424]">
          <span className="font-semibold text-xs tracking-wide">历史调度记录</span>
          <button onClick={() => fetchHistory()} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded border border-transparent hover:border-black/10 dark:hover:border-white/10 transition-colors">
            <RefreshCw className={cn("w-3 h-3 text-gray-500", historyLoading && "animate-spin")} />
          </button>
        </div>
        <div className="p-2 space-y-1 overflow-y-auto flex-1">
          {history.map(record => (
            <div 
              key={record.id}
              onClick={() => setFocusTaskId(record.id)}
              className={cn(
                "p-3 text-xs rounded border transition-colors cursor-pointer select-none",
                currentRecord?.id === record.id 
                  ? "bg-black text-white dark:bg-white dark:text-black border-transparent shadow" 
                  : "bg-white dark:bg-[#333] border-[#e0e0e0] dark:border-[#444] hover:border-black dark:hover:border-white text-[var(--foreground)]"
              )}
            >
              <div className="flex justify-between items-center mb-1.5">
                <span className="font-bold tracking-tight">{STATUS_LABEL[record.status]}</span>
                <span className={cn("px-1.5 py-0.5 rounded uppercase font-mono text-[9px]", 
                  currentRecord?.id === record.id ? "bg-white/20 dark:bg-black/10" : "bg-black/5 dark:bg-white/10"
                )}>
                  {record.processedCount} / {record.sentenceCount} 段
                </span>
              </div>
              <div className="truncate opacity-90 font-medium mb-2">{record.text}</div>
              <div className="flex items-center justify-between opacity-60 font-mono text-[10px]">
                <span>{formatTime(record.createdAt)}</span>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDelete(record.id); }}
                  className="hover:text-red-500 active:scale-90 transition-transform p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {history.length === 0 && !historyLoading && (
            <div className="text-center py-10 text-xs opacity-50">暂无任务记录</div>
          )}
        </div>
      </aside>

      {/* Main Configuration & Details */}
      <main className="flex-1 flex flex-col overflow-y-auto">
        <div className="grid lg:grid-cols-[1fr_380px] h-full">
          
          {/* Editor and Setup Panel */}
          <section className="p-6 md:p-8 flex flex-col overflow-y-auto min-h-0 border-r border-[#e0e0e0] dark:border-[#333] max-w-4xl border-dashed">
            <h1 className="text-2xl font-bold tracking-tight mb-8">TTS 工作台</h1>
            
            <div className="space-y-6">
              {/* Text Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-gray-500 flex justify-between">
                  <span>源文案输入</span>
                  <span>{sentencePreview.length} 个重组分段</span>
                </label>
                <textarea 
                  className="w-full h-36 p-4 text-sm rounded-lg border border-[#ccc] dark:border-[#444] bg-[#fafafa] dark:bg-[#1a1a1a] resize-y focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white transition-all shadow-inner"
                  value={text} 
                  placeholder="在此处输入您需要合成的中文句子..."
                  onChange={e => setText(e.target.value)} 
                />
              </div>

              {/* Files Upload */}
              <div className="grid grid-cols-2 gap-4">
                <label className="relative flex flex-col gap-1 cursor-pointer group">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500">音色参考 (Timbre)</span>
                  <div className="flex items-center gap-3 p-3 border border-[#ccc] dark:border-[#444] group-hover:border-black dark:group-hover:border-white bg-[#fafafa] dark:bg-[#242424] rounded-lg transition-colors overflow-hidden">
                    <div className="bg-black/5 dark:bg-white/10 p-1.5 rounded"><FolderOpen className="w-4 h-4" /></div>
                    <span className="text-sm truncate font-medium flex-1 select-none">
                      {promptFile ? promptFile.name : "点击选择本地音频.wav"}
                    </span>
                  </div>
                  <input type="file" accept={ACCEPT_AUDIO_INPUT} onChange={onFileSelected(setPromptFile)} className="hidden" />
                </label>

                <label className="relative flex flex-col gap-1 cursor-pointer group">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500">情感参考 (Emotion)</span>
                  <div className="flex items-center gap-3 p-3 border border-[#ccc] dark:border-[#444] group-hover:border-black dark:group-hover:border-white bg-[#fafafa] dark:bg-[#242424] rounded-lg transition-colors overflow-hidden">
                    <div className="bg-black/5 dark:bg-white/10 p-1.5 rounded"><FolderOpen className="w-4 h-4" /></div>
                    <span className="text-sm truncate font-medium flex-1 select-none">
                      {emotionFile ? emotionFile.name : "点击选择本地音频.wav"}
                    </span>
                  </div>
                  <input type="file" accept={ACCEPT_AUDIO_INPUT} onChange={onFileSelected(setEmotionFile)} className="hidden" />
                </label>
              </div>

              {/* Slider */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-bold text-gray-500">
                  <span className="uppercase tracking-wider">情感权重 (Emo-Weight)</span>
                  <span className="font-mono bg-black/5 dark:bg-white/10 px-2 py-0.5 rounded">{emoWeight.toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={emoWeight}
                  onChange={(e) => setEmoWeight(Number(e.target.value))}
                  className="w-full h-1.5 bg-[#ddd] dark:bg-[#444] rounded-lg appearance-none cursor-pointer accent-black dark:accent-white outline-none"
                />
              </div>

              {/* Generate */}
              <div className="pt-6 border-t border-[#eee] dark:border-[#333] flex items-center justify-between">
                {error ? <div className="text-[11px] font-semibold text-red-600 bg-red-100 dark:bg-red-950 px-2 py-1 rounded inline-block">{error}</div> : <div />}
                <button 
                  className={cn("bg-black text-white dark:bg-white dark:text-black px-8 py-2.5 rounded-lg font-bold text-sm transition-all flex items-center gap-2", 
                    (submitting || !text || !promptFile || !emotionFile) ? "opacity-50 cursor-not-allowed" : "hover:bg-[#333] dark:hover:bg-[#ddd] shadow-lg active:scale-[0.98]"
                  )}
                  onClick={handleGenerate}
                  disabled={submitting || !text || !promptFile || !emotionFile}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {submitting ? "提交配置中..." : "渲染语音"}
                </button>
              </div>

            </div>
            
            {/* Sentence Preview Expansion */}
            {sentencePreview.length > 0 && (
              <div className="mt-10 py-6 border-t border-[#eee] dark:border-[#333]">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">将切分为以下片段处理：</h3>
                <div className="space-y-2 font-mono text-[11px] text-gray-600 dark:text-gray-400">
                  {sentencePreview.slice(0, 10).map((s, i) => (
                    <div key={i} className="flex gap-2">
                       <span className="opacity-50 shrink-0 border border-current px-1 h-fit rounded-[2px]">#{String(i+1).padStart(2,'0')}</span>
                       <span className="leading-snug">{s}</span>
                    </div>
                  ))}
                  {sentencePreview.length > 10 && <div className="opacity-50 indent-8">...及其它 {sentencePreview.length - 10} 句</div>}
                </div>
              </div>
            )}
            {/* Video to Audio Extraction Utility */}
            <div className="mt-10 py-6 border-t border-[#eee] dark:border-[#333]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-4">实用辅助：视频转无损音频</h3>
              <div className="bg-[#fcfcfc] dark:bg-[#222] border border-[#ddd] dark:border-[#444] rounded-lg p-5">
                <div className="flex items-center gap-4">
                  <label className="relative flex-1 cursor-pointer group">
                    <div className="flex items-center gap-3 p-3 border border-[#ccc] dark:border-[#555] group-hover:border-black dark:group-hover:border-white bg-white dark:bg-[#1a1a1a] rounded transition-colors overflow-hidden">
                      <div className="bg-black/5 dark:bg-white/10 p-1.5 rounded"><FolderOpen className="w-4 h-4" /></div>
                      <span className="text-sm truncate font-medium flex-1 select-none text-gray-700 dark:text-gray-300">
                        {videoFile ? videoFile.name : "点击选择包含人声的视频文件 (.mp4, .mov)"}
                      </span>
                    </div>
                    <input type="file" accept="video/*" onChange={onFileSelected(setVideoFile)} className="hidden" />
                  </label>
                  
                  <button 
                    onClick={handleExtractVideo}
                    disabled={!videoFile || videoExtracting}
                    className="shrink-0 bg-black text-white dark:bg-white dark:text-black px-6 py-3 rounded font-bold text-sm transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-800 dark:hover:bg-gray-200"
                  >
                    {videoExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    {videoExtracting ? "底层提取中..." : "提取音频"}
                  </button>
                </div>

                {extractedVideoAudio && (
                  <div className="mt-5 p-4 bg-[#f0f0f0] dark:bg-[#111] border border-[#ccc] dark:border-[#333] rounded">
                    <div className="flex justify-between items-center mb-3">
                      <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">提取成功 / Extracted</span>
                      <div className="flex gap-2">
                        <button onClick={() => handleApplyExtractedTo("prompt")} className="bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-xs px-3 py-1 rounded font-semibold transition-colors">👉 设为音色参考</button>
                        <button onClick={() => handleApplyExtractedTo("emotion")} className="bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-xs px-3 py-1 rounded font-semibold transition-colors">👉 设为情感参考</button>
                      </div>
                    </div>
                    <audio controls className="w-full h-8 outline-none" src={extractedVideoAudio.url} />
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Right Panel: Detail & Playback */}
          <section className="bg-[#f0f0f0] dark:bg-[#1f1f1f] flex flex-col p-6 min-h-0 overflow-y-auto">
            {currentRecord ? (
              <div className="flex flex-col gap-6">
                <div className="bg-white dark:bg-[#2a2a2a] border border-[#ccc] dark:border-[#444] rounded-xl p-5 shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h2 className="font-bold text-lg leading-tight uppercase tracking-tight">{STATUS_LABEL[currentRecord.status]}</h2>
                      <p className="font-mono text-[10px] text-gray-500 mt-0.5">JOB-ID: {currentRecord.id}</p>
                    </div>
                    <div className="font-mono text-sm font-semibold tracking-tighter">
                      {currentRecord.processedCount} / {currentRecord.sentenceCount}
                    </div>
                  </div>

                  {/* Actions / Player */}
                  {currentMergedUrl ? (
                    <div className="mt-4 p-3 bg-[#f9f9f9] dark:bg-[#111] rounded-lg border border-[#e0e0e0] dark:border-[#333]">
                      <div className="text-[10px] uppercase font-bold text-gray-400 text-center mb-2">Master Render.wav</div>
                      <audio controls className="w-full h-8 opacity-80" src={currentMergedUrl} />
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {["queued", "processing"].includes(currentRecord.status) && (
                        <>
                           <button onClick={() => handleControl(currentRecord.id, "pause")} disabled={actionPendingId === currentRecord.id}
                            className="flex-1 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-xs py-2 rounded-md font-bold transition-colors">暂停 (Pause)</button>
                           <button onClick={() => handleControl(currentRecord.id, "cancel")} disabled={actionPendingId === currentRecord.id}
                            className="flex-1 border border-black/20 dark:border-white/20 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 text-xs py-2 rounded-md font-bold transition-colors">终止 (Halt)</button>
                        </>
                      )}
                      {["paused", "failed", "cancelled"].includes(currentRecord.status) && (
                        <button onClick={() => handleControl(currentRecord.id, "resume")} disabled={actionPendingId === currentRecord.id}
                         className="flex-1 bg-black text-white dark:bg-white dark:text-black hover:opacity-80 text-xs py-2 rounded-md font-bold transition-colors">断点继续 (Resume)</button>
                      )}
                    </div>
                  )}

                  {currentRecord.error && (
                    <div className="mt-3 p-2 bg-red-100 dark:bg-red-900 border border-red-200 dark:border-red-950 text-red-800 dark:text-red-200 text-xs font-semibold rounded">{currentRecord.error}</div>
                  )}
                </div>

                {currentRecord.segments.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-3 ml-1">Rendered Segments</h3>
                    <div className="space-y-2">
                      {currentRecord.segments.map((seg) => {
                         const url = resolveSegmentUrl(seg);
                         return (
                           <div key={seg.index} className="bg-white dark:bg-[#2a2a2a] border border-[#ccc] dark:border-[#444] rounded-lg p-3">
                             <div className="flex items-center justify-between mb-1">
                               <div className="font-mono text-[10px] text-gray-400">INDEX #{String(seg.index).padStart(2,'0')}</div>
                               {url ? <Music className="w-3.5 h-3.5 text-black dark:text-white" /> : <div className="text-[9px] uppercase px-1 border rounded text-gray-400">Processing</div>}
                             </div>
                             <p className="text-xs font-medium leading-relaxed my-2 line-clamp-3">{seg.text}</p>
                             {url && <audio controls className="w-full h-6 opacity-60" src={url} />}
                           </div>
                         );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-gray-400 text-xs border border-dashed border-gray-400 p-4 rounded-lg transform -translate-y-4">右侧面板 - 选中任务详情</div>
              </div>
            )}
          </section>

        </div>
      </main>
    </div>
  );
}
