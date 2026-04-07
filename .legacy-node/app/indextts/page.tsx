"use client";

import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertCircle,
  Clock,
  Code,
  Download,
  Feather,
  FileAudio,
  History,
  Hourglass,
  Loader2,
  Mic,
  Music,
  Pause,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";

type HistoryRecord = {
  id: string;
  createdAt: string;
  filename?: string;
  path?: string;
  text: string;
  status: "queued" | "processing" | "success" | "failed";
  error?: string;
  source?: "api" | "ui";
  local?: boolean;
};

type VoiceMode = "builtin" | "upload";

type VoiceLibraryItem = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
};

type VoiceLibraryResponse = {
  items?: VoiceLibraryItem[];
};

const ACCEPT_AUDIO_INPUT =
  ".wav,.mp3,.m4a,.ogg,.webm,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/webm";
const ALLOWED_AUDIO_EXTS = [".wav", ".mp3", ".m4a", ".ogg", ".webm"];
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

const HISTORY_TEXT_CLAMP = 140;
const HISTORY_DELETE_ANIMATION_MS = 520;

const getFileExtension = (filename: string) => {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return filename.slice(dot).toLowerCase();
};

const isAllowedAudioFile = (file: File) => {
  const ext = getFileExtension(file.name);
  const type = file.type?.toLowerCase() ?? "";
  return ALLOWED_AUDIO_EXTS.includes(ext) || ALLOWED_AUDIO_MIME.has(type);
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

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const formatRelativeTime = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  return date.toLocaleDateString();
};

const buildWaveData = (seedKey: string, bars = 40) => {
  let seed = 0;
  for (let i = 0; i < seedKey.length; i += 1) {
    seed = (seed * 31 + seedKey.charCodeAt(i)) >>> 0;
  }
  if (!seed) {
    seed = 0x9e3779b9;
  }
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  return Array.from({ length: bars }, () => Math.max(0.15, next()));
};

const resolveAudioUrl = (value: unknown) => {
  if (!value) {
    return null;
  }
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const nested =
      record.value && typeof record.value === "object"
        ? (record.value as Record<string, unknown>)
        : record;
    if (typeof nested.url === "string") {
      return nested.url;
    }
    if (typeof nested.data === "string") {
      return nested.data;
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string") {
      return record.url;
    }
    if (typeof record.data === "string") {
      return record.data;
    }
  }
  return null;
};

const setActiveAudio = (audio: HTMLAudioElement | null) => {
  if (typeof window === "undefined") {
    return;
  }
  const globalRef = window as Window & {
    __indextts_active_audio__?: HTMLAudioElement | null;
  };
  if (audio && globalRef.__indextts_active_audio__) {
    if (globalRef.__indextts_active_audio__ !== audio) {
      globalRef.__indextts_active_audio__.pause();
    }
  }
  globalRef.__indextts_active_audio__ = audio;
};

const useAudioPlayer = (src?: string | null) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const handleLoaded = () => {
      setDuration(audio.duration || 0);
    };
    const handleTimeUpdate = () => {
      if (!audio.duration) {
        return;
      }
      setProgress(audio.currentTime / audio.duration);
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(1);
    };

    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    return () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [src]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused) {
      setActiveAudio(audio);
      try {
        await audio.play();
      } catch (err) {
        // Ignore playback errors; user gesture may be required.
      }
    } else {
      audio.pause();
    }
  };

  const seekTo = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) {
      return;
    }
    const next = Math.min(1, Math.max(0, ratio));
    audio.currentTime = next * audio.duration;
    setProgress(next);
  };

  return {
    audioRef,
    isPlaying,
    progress,
    duration,
    togglePlay,
    seekTo,
  };
};

const WaveformBars = ({
  seedKey,
  progress,
  onSeek,
  activeClass,
}: {
  seedKey: string;
  progress: number;
  onSeek?: (value: number) => void;
  activeClass: string;
}) => {
  const bars = 40;
  const waveData = useMemo(() => buildWaveData(seedKey, bars), [seedKey]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  const handleSeek = (clientX: number) => {
    if (!containerRef.current || !onSeek) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    onSeek(ratio);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSeek) {
      return;
    }
    event.preventDefault();
    isDraggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    handleSeek(event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) {
      return;
    }
    handleSeek(event.clientX);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) {
      return;
    }
    isDraggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) {
      return;
    }
    isDraggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className="h-full flex items-center gap-[3px] cursor-pointer group select-none py-1 w-full"
      style={{ touchAction: "none" }}
    >
      {waveData.map((height, index) => {
        const barProgress = index / bars;
        const isActive = barProgress < progress;
        return (
          <div
            key={index}
            className={`flex-1 rounded-full transition-all duration-300 ${
              isActive ? activeClass : "bg-[#E5E5E5] group-hover:bg-[#D4D4D4]"
            }`}
            style={{
              height: `${height * 100}%`,
              transform: isActive ? "scaleY(1.1)" : "scaleY(1)",
            }}
          />
        );
      })}
    </div>
  );
};

const VOICE_PALETTE = [
  { badge: "bg-[#F9E4D4]", wave: "bg-[#E69A8D]", icon: Music },
  { badge: "bg-[#E0E7FF]", wave: "bg-[#A2B9BC]", icon: Mic },
  { badge: "bg-[#F3E8FF]", wave: "bg-[#B4A0C4]", icon: Music },
  { badge: "bg-[#F5EBDD]", wave: "bg-[#C5B088]", icon: Music },
] as const;

const VoiceCard = ({
  voice,
  index,
  isActive,
  onSelect,
}: {
  voice: VoiceLibraryItem;
  index: number;
  isActive: boolean;
  onSelect: (voice: VoiceLibraryItem) => void;
}) => {
  const palette = VOICE_PALETTE[index % VOICE_PALETTE.length];
  const previewUrl = `/indextts/voices/file?path=${encodeURIComponent(
    voice.path
  )}`;
  const activePreviewUrl = isActive ? previewUrl : null;
  const { audioRef, isPlaying, progress, togglePlay, seekTo } = useAudioPlayer(
    activePreviewUrl
  );
  const Icon = palette.icon;

  useEffect(() => {
    if (!isActive && isPlaying) {
      audioRef.current?.pause();
    }
  }, [audioRef, isActive, isPlaying]);

  return (
    <div
      onClick={() => onSelect(voice)}
      className={`relative p-4 rounded-2xl cursor-pointer voice-card-active group overflow-hidden ${
        isActive
          ? "bg-[#FDF6F6] shadow-sm ring-1 ring-[#E69A8D]/30"
          : "bg-[#FAF9F6] hover:bg-[#F5F5F5] border border-transparent"
      }`}
    >
      <div className="flex items-center gap-4 relative z-10">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shadow-sm transition-colors duration-300 ${
            isActive ? "bg-white" : palette.badge
          }`}
        >
          <Icon size={18} className="text-[#5D5D5D]" />
        </div>

        <div className="flex-1 min-w-0">
          <div
            className={`font-bold text-sm truncate ${
              isActive ? "text-[#5D5D5D]" : "text-[#7D7D7D]"
            }`}
          >
            {voice.name}
          </div>
          {!isActive && (
            <div className="text-[10px] text-[#9E9E9E] mt-0.5">点击试听</div>
          )}
        </div>

        {isActive && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              togglePlay();
            }}
            className={`w-8 h-8 rounded-full flex items-center justify-center text-xs shadow-md transition-all shrink-0 hover:scale-110 active:scale-95 ${
              isPlaying ? "bg-[#5D5D5D] text-white" : "bg-[#E69A8D] text-white"
            }`}
          >
            {isPlaying ? (
              <Pause size={12} fill="currentColor" />
            ) : (
              <Play size={12} fill="currentColor" className="ml-0.5" />
            )}
          </button>
        )}
      </div>

      {isActive && (
        <div className="mt-3 h-8 w-full bg-white rounded-lg px-2 flex items-center border border-[#E69A8D]/20">
          <WaveformBars
            seedKey={previewUrl}
            progress={progress}
            onSeek={seekTo}
            activeClass={palette.wave}
          />
          <audio ref={audioRef} preload="metadata" src={previewUrl} />
        </div>
      )}
    </div>
  );
};

const AudioWaveformCard = ({
  src,
  accentClass,
  label,
  showDownload,
}: {
  src: string;
  accentClass: string;
  label: string;
  showDownload?: boolean;
}) => {
  const { audioRef, isPlaying, progress, duration, togglePlay, seekTo } =
    useAudioPlayer(src);

  return (
    <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#F0F0F0] flex flex-col gap-4">
      <div className="flex items-center justify-between text-xs text-[#9E9E9E] font-medium">
        <div className="flex items-center gap-1.5">
          <FileAudio size={14} /> {label}
        </div>
        <div className="font-mono bg-white px-2 py-0.5 rounded text-[#9E9E9E] border border-[#F0F0F0]">
          {formatDuration(duration)}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button
          onClick={togglePlay}
          className={`w-12 h-12 ${accentClass} hover:opacity-90 text-white rounded-full flex items-center justify-center shadow-md transition-all active:scale-95 shrink-0`}
        >
          {isPlaying ? (
            <Pause size={20} fill="currentColor" />
          ) : (
            <Play size={20} fill="currentColor" className="ml-1" />
          )}
        </button>
        <div className="flex-1 h-10 bg-white rounded-xl border border-[#F0F0F0] px-3 flex items-center overflow-hidden">
          <WaveformBars
            seedKey={src}
            progress={progress}
            onSeek={seekTo}
            activeClass={accentClass}
          />
        </div>
        {showDownload ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="text-[#9E9E9E] hover:text-[#5D5D5D] transition-colors"
          >
            <Download size={18} />
          </a>
        ) : null}
      </div>
      <audio ref={audioRef} preload="metadata" src={src} />
    </div>
  );
};

const HistoryListItem = ({
  record,
  index,
  onSelect,
  onDelete,
  isDeleting,
}: {
  record: HistoryRecord;
  index: number;
  onSelect: (record: HistoryRecord) => void;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) => {
  const audioPath = record.path
    ? `/sandbox/file?path=${encodeURIComponent(record.path)}`
    : null;
  const hasAudio = record.status === "success" && !!audioPath;
  const {
    audioRef,
    isPlaying,
    progress,
    duration,
    togglePlay,
    seekTo,
  } = useAudioPlayer(hasAudio ? audioPath : null);
  const statusLabel =
    record.status === "success"
      ? "生成成功"
      : record.status === "processing"
        ? "生成中"
        : record.status === "queued"
          ? "排队中"
          : "失败";
  const isApi = record.source === "api";
  const timeLabel =
    record.status === "success" && hasAudio
      ? formatDuration(duration)
      : formatRelativeTime(record.createdAt);

  return (
    <div
      onClick={() => onSelect(record)}
      style={{ animationDelay: `${index * 0.05}s` }}
      className={`relative overflow-hidden history-item ${
        isDeleting
          ? "max-h-0 opacity-0 mb-0 history-item-exit"
          : "max-h-[200px] mb-3 history-item-enter"
      }`}
    >
      <div className="bg-white p-4 rounded-2xl border border-transparent transition-all duration-300 group flex flex-col gap-3 cursor-pointer shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_20px_-6px_rgba(230,154,141,0.2)] hover:border-[#E69A8D]/30 hover:-translate-y-0.5">
        <div className="flex items-center justify-between h-5">
          <div className="flex items-center gap-2">
            <div
              onClick={(event) => {
                event.stopPropagation();
                if (hasAudio) {
                  togglePlay();
                }
              }}
              className={`
                    w-6 h-6 rounded-full flex items-center justify-center text-[10px] shadow-sm transition-all shrink-0
                    ${record.status === "success" ? "bg-[#A4C3B2] text-white hover:bg-[#8FB3A0] active:scale-95" : ""}
                    ${record.status === "processing" ? "bg-[#A2B9BC] text-white" : ""}
                    ${record.status === "queued" ? "bg-[#E5D4B3] text-white" : ""}
                    ${record.status === "failed" ? "bg-[#E69A8D] text-white" : ""}
                  `}
            >
              {record.status === "success" &&
                (isPlaying ? (
                  <Pause size={10} fill="currentColor" />
                ) : (
                  <Play size={10} fill="currentColor" className="ml-0.5" />
                ))}
              {record.status === "processing" && (
                <Loader2 size={10} className="animate-spin" />
              )}
              {record.status === "queued" && <Hourglass size={10} />}
              {record.status === "failed" && <AlertCircle size={10} />}
            </div>

            <span
              className={`text-[10px] font-bold tracking-wide
                  ${record.status === "success" ? "text-[#7A9D96]" : ""}
                  ${record.status === "processing" ? "text-[#889FA3]" : ""}
                  ${record.status === "queued" ? "text-[#C5B088]" : ""}
                  ${record.status === "failed" ? "text-[#D4897D]" : ""}
                `}
            >
              {statusLabel}
            </span>
            {isApi && (
              <span className="text-[9px] px-2 py-0.5 rounded-full border border-[#E69A8D]/40 text-[#E69A8D] font-bold">
                API调用
              </span>
            )}
          </div>

          <div className="text-[10px] text-[#9E9E9E] font-mono">
            {timeLabel}
          </div>
        </div>

        <div className="h-10 w-full flex items-center bg-[#FAF7F2] rounded-xl px-3 border border-[#F0F0F0]">
          {record.status === "success" && audioPath ? (
            <div
              onClick={(event) => event.stopPropagation()}
              className="w-full h-full"
            >
              <WaveformBars
                seedKey={audioPath}
                progress={progress}
                onSeek={seekTo}
                activeClass="bg-[#A4C3B2]"
              />
              <audio ref={audioRef} preload="metadata" src={audioPath} />
            </div>
          ) : record.status === "processing" ? (
            <div className="w-full h-1.5 bg-[#E5E5E5] rounded-full overflow-hidden relative">
              <div className="absolute top-0 left-0 h-full w-1/3 bg-[#A2B9BC] rounded-full animate-[slide_1.2s_infinite_linear]" />
            </div>
          ) : record.status === "queued" ? (
            <div className="w-full flex gap-1 justify-center opacity-50">
              <div className="w-1.5 h-1.5 bg-[#E5D4B3] rounded-full animate-bounce" />
              <div className="w-1.5 h-1.5 bg-[#E5D4B3] rounded-full animate-bounce [animation-delay:0.1s]" />
              <div className="w-1.5 h-1.5 bg-[#E5D4B3] rounded-full animate-bounce [animation-delay:0.2s]" />
            </div>
          ) : (
            <div className="w-full text-center text-[10px] text-[#D4897D] font-medium">
              生成失败，请重试
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-[#9E9E9E] pt-1">
          <span
            className="truncate flex-1 pr-4 text-[#5D5D5D]"
            title={record.text}
          >
            {record.text.length > HISTORY_TEXT_CLAMP
              ? `${record.text.slice(0, HISTORY_TEXT_CLAMP)}...`
              : record.text}
          </span>
          <div className="flex gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            {record.status === "success" && audioPath && (
              <a
                href={audioPath}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="hover:text-[#A4C3B2] transition-colors"
              >
                <Download size={14} />
              </a>
            )}
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDelete(record.id);
              }}
              className="hover:text-[#E69A8D] transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const HistoryDetailModal = ({
  item,
  onClose,
  onDelete,
}: {
  item: HistoryRecord | null;
  onClose: () => void;
  onDelete: (id: string) => void;
}) => {
  if (!item) return null;
  const audioUrl = item.path
    ? `/sandbox/file?path=${encodeURIComponent(item.path)}`
    : null;
  const isApi = item.source === "api";

  const statusLabel =
    item.status === "success"
      ? "生成成功"
      : item.status === "processing"
        ? "生成中"
        : item.status === "queued"
          ? "排队中"
          : "失败";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#5D5D5D]/20 backdrop-blur-sm animate-in fade-in duration-300"
      onClick={onClose}
    >
      <div
        className="bg-[#FAF7F2] rounded-[2rem] shadow-xl w-full max-w-md overflow-hidden transform transition-all scale-100 flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-300 border border-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-6 border-b border-[#E5E5E5] flex justify-between items-center bg-[#FAF7F2] shrink-0">
          <h3 className="text-lg font-bold text-[#5D5D5D]">任务详情</h3>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[#E5E5E5] rounded-full text-[#9E9E9E] transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar bg-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide
                  ${item.status === "success" ? "bg-[#EBF5EE] text-[#7A9D96]" : ""}
                  ${item.status === "processing" ? "bg-[#EBF2F5] text-[#A2B9BC]" : ""}
                  ${item.status === "queued" ? "bg-[#F9F3E5] text-[#C5B088]" : ""}
                  ${item.status === "failed" ? "bg-[#FCEEEE] text-[#E69A8D]" : ""}
               `}
              >
                {item.status === "success" ? (
                  <>
                    <Sparkles size={14} /> {statusLabel}
                  </>
                ) : item.status === "processing" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> {statusLabel}
                  </>
                ) : item.status === "queued" ? (
                  <>
                    <Hourglass size={14} /> {statusLabel}
                  </>
                ) : (
                  <>
                    <AlertCircle size={14} /> {statusLabel}
                  </>
                )}
              </div>
              {isApi && (
                <span className="text-[10px] px-2 py-1 rounded-full border border-[#E69A8D]/40 text-[#E69A8D] font-bold">
                  API调用
                </span>
              )}
            </div>
            <div className="text-xs text-[#9E9E9E] font-mono flex items-center gap-2">
              <Clock size={12} /> {formatRelativeTime(item.createdAt)}
            </div>
          </div>

          {audioUrl && item.status === "success" && (
            <AudioWaveformCard
              src={audioUrl}
              accentClass="bg-[#E69A8D]"
              label="音频预览"
              showDownload
            />
          )}

          <div className="space-y-3 flex-1">
            <label className="text-xs font-bold text-[#9E9E9E] uppercase tracking-wider flex items-center gap-1.5">
              <Feather size={14} /> 文本内容
            </label>
            <div className="p-5 bg-[#FAF7F2] border border-[#F0F0F0] rounded-2xl text-sm text-[#5D5D5D] leading-7 font-medium min-h-[120px]">
              {item.text}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-[#E5E5E5] bg-[#FAF7F2] flex items-center gap-4 shrink-0">
          <button
            onClick={() => {
              onDelete(item.id);
            }}
            className={`
                flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all active:scale-95
                text-[#E69A8D] hover:bg-[#FCEEEE]
                ${item.status !== "success" ? "flex-1 bg-white border border-[#E69A8D]/30" : ""}
             `}
          >
            <Trash2 size={18} />
            {item.status !== "success" && "删除记录"}
          </button>

          {audioUrl && item.status === "success" && (
            <a
              href={audioUrl}
              target="_blank"
              rel="noreferrer"
              className="flex-1 py-3 bg-[#5D5D5D] hover:bg-[#4A4A4A] text-white rounded-xl text-sm font-bold shadow-md transition-all flex items-center justify-center gap-2 active:scale-95"
            >
              <Download size={18} /> 下载音频
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

const DeleteConfirmModal = ({
  record,
  onCancel,
  onConfirm,
}: {
  record: HistoryRecord | null;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  if (!record) return null;
  const preview =
    record.text.length > 80 ? `${record.text.slice(0, 80)}...` : record.text;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[#5D5D5D]/20 backdrop-blur-sm">
      <div className="bg-[#FAF7F2] rounded-[2rem] shadow-xl w-full max-w-md overflow-hidden border border-white">
        <div className="p-6 border-b border-[#E5E5E5] flex justify-between items-center bg-[#FAF7F2]">
          <h3 className="text-lg font-bold text-[#5D5D5D]">确认删除</h3>
          <button
            onClick={onCancel}
            className="p-2 hover:bg-[#E5E5E5] rounded-full text-[#9E9E9E] transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-6 space-y-4 bg-white">
          <div className="text-sm text-[#5D5D5D]">
            确定要删除这条历史记录吗？
          </div>
          <div className="p-4 rounded-2xl border border-[#F0F0F0] bg-[#FAF7F2] text-sm text-[#5D5D5D] leading-6">
            {preview || "（无文本内容）"}
          </div>
          <div className="text-xs text-[#9E9E9E]">
            删除后无法恢复。
          </div>
        </div>
        <div className="p-6 border-t border-[#E5E5E5] bg-[#FAF7F2] flex items-center gap-4">
          <button
            onClick={onCancel}
            className="flex-1 py-3 border border-[#E5E5E5] rounded-xl text-sm font-bold text-[#9E9E9E] hover:bg-white transition-all"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-[#E69A8D] hover:bg-[#D4897D] transition-all"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
};

export default function IndexTTSPage() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<VoiceMode>("builtin");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedSource, setUploadedSource] = useState<VoiceMode | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [response, setResponse] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [localRecords, setLocalRecords] = useState<HistoryRecord[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [queueAhead, setQueueAhead] = useState<number | null>(null);
  const [voiceItems, setVoiceItems] = useState<VoiceLibraryItem[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [selectedVoicePath, setSelectedVoicePath] = useState<string | null>(null);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<HistoryRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HistoryRecord | null>(null);
  const [closeDetailOnDelete, setCloseDetailOnDelete] = useState(false);
  const [historyTab, setHistoryTab] = useState<"web" | "api">("web");
  const [showMobilePanel, setShowMobilePanel] = useState(false);
  const [mobilePanelType, setMobilePanelType] = useState<"voice" | "history">(
    "voice"
  );

  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const audioUrl = useMemo(() => resolveAudioUrl(response), [response]);

  useEffect(() => {
    if (!uploadedFile) {
      setUploadPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(uploadedFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadedFile]);

  const fetchRecords = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setRecordsLoading(true);
    }
    setRecordsError(null);
    try {
      const res = await fetch("/indextts/history", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "读取记录失败。");
      }
      setRecords(Array.isArray(json.data) ? json.data : []);
      return true;
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : "读取记录失败。");
      return false;
    } finally {
      if (!silent) {
        setRecordsLoading(false);
      }
    }
  }, []);

  const fetchVoices = useCallback(async () => {
    setVoicesLoading(true);
    setVoicesError(null);
    try {
      const res = await fetch("/indextts/voices", { cache: "no-store" });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: VoiceLibraryResponse;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "读取音色失败。");
      }
      const data = json.data ?? {};
      setVoiceItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setVoiceItems([]);
      setVoicesError(err instanceof Error ? err.message : "读取音色失败。");
    } finally {
      setVoicesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
    fetchVoices();
  }, [fetchRecords, fetchVoices]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      fetchRecords({ silent: true });
    };
    const handleVisibility = () => {
      const visible =
        typeof document === "undefined" ||
        document.visibilityState === "visible";
      if (visible) {
        poll();
        if (!timer) {
          timer = setInterval(poll, 6000);
        }
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    handleVisibility();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (timer) {
        clearInterval(timer);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRecords]);

  useEffect(() => {
    if (mode !== "builtin") {
      return;
    }
    if (!selectedVoicePath && voiceItems.length > 0) {
      const first = voiceItems[0];
      setSelectedVoicePath(first.path);
      setSelectedVoiceName(first.name);
    }
  }, [mode, selectedVoicePath, voiceItems]);

  const handleFileSelect = (file: File | null, source: VoiceMode) => {
    if (!file) {
      setUploadedFile(null);
      setUploadedSource(null);
      return;
    }
    if (!isAllowedAudioFile(file)) {
      setError("仅支持 wav/mp3/m4a/ogg/webm 音频文件。");
      return;
    }
    setUploadedFile(file);
    setUploadedSource(source);
    setMode(source);
    setError(null);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedVoicePath(null);
    setSelectedVoiceName(null);
    handleFileSelect(event.target.files?.[0] ?? null, "upload");
  };

  const handleVoiceSelect = (voice: VoiceLibraryItem) => {
    setMode("builtin");
    setError(null);
    setUploadedFile(null);
    setUploadedSource(null);
    setSelectedVoicePath(voice.path);
    setSelectedVoiceName(voice.name);
  };

  const handleGenerate = async () => {
    setError(null);
    setResponse(null);
    setQueueing(false);

    if (!text.trim()) {
      setError("请输入文本内容。");
      return;
    }

    let voiceFile: File | null = null;
    const trimmedText = text.trim();
    let requestBody: FormData | null = null;

    const localId = `local-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    if (mode === "upload") {
      if (uploadedFile && uploadedSource === "upload") {
        voiceFile = uploadedFile;
      }
      if (!voiceFile) {
        setError("请上传参考音频。");
        return;
      }
      requestBody = new FormData();
      requestBody.append("text", trimmedText);
      requestBody.append("clientId", localId);
      requestBody.append("voice", voiceFile);
    } else {
      if (!selectedVoiceName) {
        setError("请选择内置音色。");
        return;
      }
      requestBody = new FormData();
      requestBody.append("text", trimmedText);
      requestBody.append("clientId", localId);
      requestBody.append("voiceName", selectedVoiceName);
    }

    const localRecord: HistoryRecord = {
      id: localId,
      createdAt: new Date().toISOString(),
      text: trimmedText,
      status: "processing",
      source: "ui",
      local: true,
    };
    setLocalRecords((prev) => [localRecord, ...prev]);

    setLoading(true);
    try {
      try {
        const queueRes = await fetch("/indextts/queue", { cache: "no-store" });
        const queueJson = await queueRes.json();
        if (queueRes.ok && typeof queueJson?.data?.size === "number") {
          const ahead = Math.max(0, Number(queueJson.data.size));
          setQueueAhead(ahead);
          if (ahead > 0) {
            setQueueing(true);
            setLocalRecords((prev) =>
              prev.map((record) =>
                record.id === localId
                  ? { ...record, status: "queued" }
                  : record
              )
            );
          }
        }
      } catch (err) {
        // Ignore queue check errors.
      }
      const res = await fetch("/indextts/generate", {
        method: "POST",
        body: requestBody ?? undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "生成失败。");
      }
      setResponse(json.data);
      setLocalRecords((prev) => prev.filter((record) => record.id !== localId));
      await fetchRecords({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "请求失败。";
      setError(message);
      const refreshed = await fetchRecords({ silent: true });
      if (refreshed) {
        setLocalRecords((prev) =>
          prev.filter((record) => record.id !== localId)
        );
      } else {
        setLocalRecords((prev) =>
          prev.map((record) =>
            record.id === localId
              ? { ...record, status: "failed", error: message }
              : record
          )
        );
      }
    } finally {
      setLoading(false);
      setQueueing(false);
      setQueueAhead(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch("/indextts/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "删除失败。");
      }
      if (Array.isArray(json.data)) {
        setRecords(json.data);
      } else {
        await fetchRecords({ silent: true });
      }
      return true;
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : "删除失败。");
      return false;
    }
  };

  const requestDelete = (record: HistoryRecord, closeDetail = false) => {
    setPendingDelete(record);
    setCloseDetailOnDelete(closeDetail);
  };

  const previewUrl =
    uploadedFile && uploadedSource === "upload" ? uploadPreviewUrl : null;
  const combinedHistory = useMemo(() => {
    const merged = new Map<string, HistoryRecord>();
    for (const record of localRecords) {
      merged.set(record.id, record);
    }
    for (const record of records) {
      merged.set(record.id, record);
    }
    return Array.from(merged.values());
  }, [localRecords, records]);
  const filteredHistory = combinedHistory.filter((record) => {
    const source = record.source ?? "ui";
    return historyTab === "api" ? source === "api" : source !== "api";
  });

  const latestAudioUrl =
    typeof audioUrl === "string" ? audioUrl : audioUrl ? String(audioUrl) : null;

  return (
    <div className="h-screen bg-[var(--morandi-bg)] text-[var(--morandi-text)] font-sans flex flex-col relative overflow-hidden selection:bg-[var(--morandi-pink)] selection:text-white">
      <div className="flex-1 flex overflow-hidden z-10 p-4 md:p-6 gap-6 max-w-[1600px] mx-auto w-full">
        <aside className="hidden md:flex flex-col w-72 bg-white rounded-[2rem] shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden border border-[#F0F0F0]">
          <div className="px-6 pt-8 pb-4">
            <h2 className="text-xs font-bold text-[#9E9E9E] uppercase tracking-widest flex items-center gap-2">
              <Mic size={14} /> 内置音色列表
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3 space-y-3 custom-scrollbar">
            {voicesLoading && (
              <div className="text-xs text-[#9E9E9E]">加载音色中...</div>
            )}
            {voicesError && (
              <div className="text-xs text-[#E69A8D]">{voicesError}</div>
            )}
            {voiceItems.length === 0 && !voicesLoading && (
              <div className="text-xs text-[#9E9E9E]">暂无内置音色</div>
            )}
            {voiceItems.map((voice, index) => (
              <VoiceCard
                key={voice.path}
                voice={voice}
                index={index}
                isActive={selectedVoicePath === voice.path}
                onSelect={handleVoiceSelect}
              />
            ))}
          </div>

          <div className="p-4 bg-[#FAF9F6] border-t border-[#F0F0F0] space-y-3">
            <input
              ref={uploadInputRef}
              type="file"
              accept={ACCEPT_AUDIO_INPUT}
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              onClick={() => {
                setMode("upload");
                uploadInputRef.current?.click();
              }}
              className="w-full py-3 border border-dashed border-[#C5B088] text-[#C5B088] rounded-xl text-xs font-bold hover:bg-[#C5B088]/10 transition-all flex items-center justify-center gap-2 group active:scale-95"
            >
              <Plus size={14} /> 使用我的音色
            </button>
            {uploadedFile && uploadedSource === "upload" && (
              <div className="text-[10px] text-[#9E9E9E]">
                {uploadedFile.name} · {formatBytes(uploadedFile.size)}
              </div>
            )}
            {previewUrl && (
              <AudioWaveformCard
                src={previewUrl}
                accentClass="bg-[#E69A8D]"
                label="音色预览"
              />
            )}
          </div>
        </aside>

        <main className="flex-1 flex flex-col bg-white rounded-[2rem] shadow-[0_8px_30px_rgba(0,0,0,0.04)] border border-[#F0F0F0] overflow-hidden relative">
          <div className="h-16 border-b border-[#F0F0F0] flex items-center justify-between px-8 bg-white shrink-0">
            <div className="hidden md:flex items-center gap-3 text-sm text-[#5D5D5D]">
              <span className="text-xl bg-[#FAF7F2] w-8 h-8 flex items-center justify-center rounded-full">
                {mode === "builtin" ? <Music size={18} /> : <Mic size={18} />}
              </span>
              <span className="font-bold">
                {mode === "builtin"
                  ? selectedVoiceName ?? "选择内置音色"
                  : uploadedFile && uploadedSource === "upload"
                    ? uploadedFile.name
                    : "使用我的音色"}
              </span>
            </div>

            <div className="md:hidden flex items-center gap-2 text-xs font-bold text-[#5D5D5D]">
              <span className="text-base bg-[#FAF7F2] w-7 h-7 flex items-center justify-center rounded-full">
                {mode === "builtin" ? <Music size={14} /> : <Mic size={14} />}
              </span>
              <span className="truncate max-w-[60vw]">
                {mode === "builtin"
                  ? selectedVoiceName ?? "选择内置音色"
                  : uploadedFile && uploadedSource === "upload"
                    ? uploadedFile.name
                    : "使用我的音色"}
              </span>
            </div>
          </div>

          <div className="flex-1 relative">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="w-full h-full bg-transparent p-8 outline-none resize-none text-lg leading-loose text-[#5D5D5D] placeholder-[#D1D5DB] font-medium custom-scrollbar"
              spellCheck={false}
              placeholder="在这里写下你想说的话..."
            />
            <div className="absolute bottom-8 right-8 opacity-10 pointer-events-none select-none">
              <Feather size={100} className="text-[#E69A8D] rotate-[-15deg]" />
            </div>
          </div>

          {latestAudioUrl && (
            <div className="px-8 pb-4">
              <AudioWaveformCard
                src={latestAudioUrl}
                accentClass="bg-[#A4C3B2]"
                label="最新生成"
                showDownload
              />
            </div>
          )}

          {error && (
            <div className="px-8 pb-4 text-sm text-[#E69A8D]">{error}</div>
          )}

          <div className="h-20 border-t border-[#F0F0F0] bg-[#FAF9F6] flex items-center justify-between px-8 gap-4">
            <div className="text-xs text-[#9E9E9E] font-medium">
              {queueing && (
                <span>
                  排队中{queueAhead ? `，前面还有 ${queueAhead} 个` : "..."}
                </span>
              )}
            </div>
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="hidden md:flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-white shadow-lg transition-all active:scale-95 hover:shadow-xl bg-[#E69A8D] hover:bg-[#D4897D] disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Sparkles size={18} fill="currentColor" />
              )}
              <span>{loading ? "生成中..." : "立即生成"}</span>
            </button>
          </div>
        </main>

        <aside className="hidden md:flex flex-col w-80 bg-[#FAF7F2] rounded-[2rem] overflow-hidden">
          <div className="p-6 pb-2">
            <h2 className="text-lg font-bold text-[#5D5D5D] flex items-center gap-2">
              <History size={20} className="text-[#E69A8D]" /> 历史记录
            </h2>
          </div>

          <div className="px-6 mb-4">
            <div className="flex p-1 bg-white rounded-xl shadow-sm">
              <button
                onClick={() => setHistoryTab("web")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-lg transition-all ${
                  historyTab === "web"
                    ? "bg-[#E69A8D] text-white shadow-md"
                    : "text-[#9E9E9E] hover:text-[#5D5D5D]"
                }`}
              >
                <History size={12} /> 页面
              </button>
              <button
                onClick={() => setHistoryTab("api")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-lg transition-all ${
                  historyTab === "api"
                    ? "bg-[#E69A8D] text-white shadow-md"
                    : "text-[#9E9E9E] hover:text-[#5D5D5D]"
                }`}
              >
                <Code size={12} /> API
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
            <div className="space-y-4">
              {recordsLoading && filteredHistory.length === 0 ? (
                <div className="text-center py-12 text-[#9E9E9E] text-xs">
                  加载中...
                </div>
              ) : recordsError ? (
                <div className="text-center py-12 text-[#E69A8D] text-xs">
                  {recordsError}
                </div>
              ) : filteredHistory.length > 0 ? (
                filteredHistory.map((item, index) => (
                  <HistoryListItem
                    key={item.id}
                    record={item}
                    index={index}
                    onSelect={setSelectedItem}
                    onDelete={(_id) => {
                      requestDelete(item);
                    }}
                    isDeleting={deletingIds.has(item.id)}
                  />
                ))
              ) : (
                <div className="text-center py-12 text-[#9E9E9E] text-xs">
                  暂无记录
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      <div className="md:hidden fixed bottom-0 left-0 w-full z-30 pb-6 pt-4 bg-[#FAF7F2] border-t border-[#F0F0F0]">
        <div className="flex items-center justify-around px-6">
          <button
            onClick={() => {
              setMobilePanelType("voice");
              setShowMobilePanel(true);
            }}
            className="flex flex-col items-center gap-1 text-[#9E9E9E] hover:text-[#E69A8D]"
          >
            <Mic size={24} />
            <span className="text-[10px]">音色</span>
          </button>
          <button
            onClick={handleGenerate}
            className="w-14 h-14 -mt-8 bg-[#E69A8D] rounded-full flex items-center justify-center text-white shadow-lg"
          >
            <Sparkles size={24} fill="currentColor" />
          </button>
          <button
            onClick={() => {
              setMobilePanelType("history");
              setShowMobilePanel(true);
            }}
            className="flex flex-col items-center gap-1 text-[#9E9E9E] hover:text-[#E69A8D]"
          >
            <History size={24} />
            <span className="text-[10px]">历史</span>
          </button>
        </div>
      </div>

      {showMobilePanel && (
        <div className="fixed inset-0 z-40 bg-[#5D5D5D]/20 backdrop-blur-sm flex items-end">
          <div className="bg-white w-full rounded-t-[2rem] p-6 max-h-[80vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-bold text-[#5D5D5D]">
                {mobilePanelType === "voice" ? "音色设置" : "历史记录"}
              </div>
              <button
                onClick={() => setShowMobilePanel(false)}
                className="p-2 rounded-full hover:bg-[#F0F0F0]"
              >
                <X size={18} />
              </button>
            </div>
            {mobilePanelType === "voice" ? (
              <div className="space-y-4">
                {voicesLoading && (
                  <div className="text-xs text-[#9E9E9E]">加载音色中...</div>
                )}
                {voicesError && (
                  <div className="text-xs text-[#E69A8D]">{voicesError}</div>
                )}
                <div className="space-y-3">
                  {voiceItems.map((voice, index) => (
                    <VoiceCard
                      key={voice.path}
                      voice={voice}
                      index={index}
                      isActive={selectedVoicePath === voice.path}
                      onSelect={handleVoiceSelect}
                    />
                  ))}
                </div>
                <button
                  onClick={() => {
                    setMode("upload");
                    uploadInputRef.current?.click();
                  }}
                  className="w-full py-3 border border-dashed border-[#C5B088] text-[#C5B088] rounded-xl text-xs font-bold hover:bg-[#C5B088]/10 transition-all flex items-center justify-center gap-2"
                >
                  <UploadCloud size={14} /> 使用我的音色
                </button>
                {previewUrl && (
                  <AudioWaveformCard
                    src={previewUrl}
                    accentClass="bg-[#E69A8D]"
                    label="音色预览"
                  />
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex p-1 bg-[#FAF7F2] rounded-xl shadow-sm">
                  <button
                    onClick={() => setHistoryTab("web")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-lg transition-all ${
                      historyTab === "web"
                        ? "bg-[#E69A8D] text-white shadow-md"
                        : "text-[#9E9E9E] hover:text-[#5D5D5D]"
                    }`}
                  >
                    页面
                  </button>
                  <button
                    onClick={() => setHistoryTab("api")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-lg transition-all ${
                      historyTab === "api"
                        ? "bg-[#E69A8D] text-white shadow-md"
                        : "text-[#9E9E9E] hover:text-[#5D5D5D]"
                    }`}
                  >
                    API
                  </button>
                </div>
                {filteredHistory.map((item, index) => (
                  <HistoryListItem
                    key={item.id}
                    record={item}
                    index={index}
                    onSelect={setSelectedItem}
                    onDelete={(_id) => {
                      requestDelete(item);
                    }}
                    isDeleting={deletingIds.has(item.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <HistoryDetailModal
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
        onDelete={(_id) => {
          if (selectedItem) {
            requestDelete(selectedItem, true);
          }
        }}
      />
      <DeleteConfirmModal
        record={pendingDelete}
        onCancel={() => {
          setPendingDelete(null);
          setCloseDetailOnDelete(false);
        }}
        onConfirm={async () => {
          if (!pendingDelete) {
            return;
          }
          const target = pendingDelete;
          setPendingDelete(null);
          if (target.local) {
            setDeletingIds((prev) => new Set(prev).add(target.id));
            setTimeout(() => {
              setLocalRecords((prev) =>
                prev.filter((record) => record.id !== target.id)
              );
              setDeletingIds((prev) => {
                const next = new Set(prev);
                next.delete(target.id);
                return next;
              });
            }, HISTORY_DELETE_ANIMATION_MS);
          } else {
            setDeletingIds((prev) => new Set(prev).add(target.id));
            setTimeout(async () => {
              await handleDelete(target.id);
              setDeletingIds((prev) => {
                const next = new Set(prev);
                next.delete(target.id);
                return next;
              });
            }, HISTORY_DELETE_ANIMATION_MS);
          }
          if (closeDetailOnDelete) {
            setSelectedItem(null);
          }
          setCloseDetailOnDelete(false);
        }}
      />
    </div>
  );
}
