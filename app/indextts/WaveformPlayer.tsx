"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";

type WaveformPlayerProps = {
  src: string;
  label?: string;
  className?: string;
};

const DEFAULT_HEIGHT = 72;
const WAVE_COLOR = "rgba(15, 23, 42, 0.2)";
const WAVE_ACTIVE = "rgba(221, 107, 32, 0.9)";

const PlayIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={className}
    fill="currentColor"
  >
    <path d="M8 5.5c0-.9 1-1.4 1.7-.9l9 6.1c.6.4.6 1.4 0 1.8l-9 6.1c-.7.5-1.7 0-1.7-.9V5.5z" />
  </svg>
);

const PauseIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={className}
    fill="currentColor"
  >
    <path d="M7 5.5c0-.8.7-1.5 1.5-1.5h1c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5v-13zM13 5.5c0-.8.7-1.5 1.5-1.5h1c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5v-13z" />
  </svg>
);

export default function WaveformPlayer({
  src,
  label,
  className,
}: WaveformPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peaksRef = useRef<number[]>([]);
  const seekingRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState("");
  const [hasWave, setHasWave] = useState(false);

  const drawWave = (ratio = 0) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const peaks = peaksRef.current;
    if (peaks.length === 0) {
      ctx.fillStyle = WAVE_COLOR;
      ctx.fillRect(0, height / 2 - 1, width, 2);
      return;
    }

    const mid = height / 2;
    const step = width / peaks.length;
    ctx.lineWidth = Math.max(1, step * 0.5);

    peaks.forEach((peak, index) => {
      const x = index * step;
      const barHeight = Math.max(2, peak * (height * 0.9));
      const isActive = ratio > 0 && x / width <= ratio;
      ctx.strokeStyle = isActive ? WAVE_ACTIVE : WAVE_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, mid - barHeight / 2);
      ctx.lineTo(x, mid + barHeight / 2);
      ctx.stroke();
    });
  };

  const measureCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const parent = canvas.parentElement;
    if (!parent) {
      return;
    }
    const width = parent.clientWidth;
    canvas.width = Math.max(200, width);
    canvas.height = DEFAULT_HEIGHT;
    drawWave(progress);
  };

  useEffect(() => {
    measureCanvas();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => measureCanvas());
    observer.observe(canvas.parentElement as Element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    drawWave(progress);
  }, [progress]);

  useEffect(() => {
    const load = async () => {
      setError("");
      setHasWave(false);
      peaksRef.current = [];
      setProgress(0);
      setDuration(0);
      drawWave(0);
      setIsPlaying(false);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }

      try {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error("音频请求失败");
        }
        const arrayBuffer = await response.arrayBuffer();
        const AudioCtx =
          window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) {
          setError("当前浏览器不支持波形解析");
          return;
        }
        const audioContext = new AudioCtx();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);

        const samples = Math.min(
          180,
          Math.max(60, Math.floor(channelData.length / 120))
        );
        const blockSize = Math.floor(channelData.length / samples);
        const peaks: number[] = [];
        for (let i = 0; i < samples; i += 1) {
          const start = i * blockSize;
          let peak = 0;
          for (let j = 0; j < blockSize; j += 1) {
            const value = Math.abs(channelData[start + j] ?? 0);
            if (value > peak) {
              peak = value;
            }
          }
          peaks.push(peak);
        }
        peaksRef.current = peaks;
        setHasWave(true);
        setDuration(audioBuffer.duration || 0);
        drawWave(0);
        await audioContext.close();
      } catch (err) {
        setError("波形加载失败");
      }
    };

    if (src) {
      load();
    }
  }, [src]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
        setError("");
      } catch (err) {
        setError("无法播放音频");
      }
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) {
      return;
    }
    setProgress(audio.currentTime / audio.duration);
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setProgress(1);
  };

  const seekToClientX = (clientX: number) => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas || !duration) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width)
    );
    audio.currentTime = ratio * duration;
    setProgress(ratio);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!hasWave) {
      return;
    }
    seekingRef.current = true;
    canvasRef.current?.setPointerCapture(event.pointerId);
    seekToClientX(event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!seekingRef.current) {
      return;
    }
    seekToClientX(event.clientX);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (seekingRef.current) {
      seekingRef.current = false;
      canvasRef.current?.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={cn("w-full space-y-1", className)}>
      {label && (
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {label}
        </p>
      )}
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white/70 px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? "暂停播放" : "开始播放"}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-white transition hover:-translate-y-0.5"
        >
          {isPlaying ? (
            <PauseIcon className="h-5 w-5" />
          ) : (
            <PlayIcon className="h-5 w-5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="relative">
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`w-full rounded-2xl ${
                hasWave ? "cursor-ew-resize" : "cursor-not-allowed"
              }`}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
            <span>{Math.round(progress * 100)}%</span>
            <span>{duration ? `${duration.toFixed(1)}秒` : "--"}</span>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        className="hidden"
      />
    </div>
  );
}
