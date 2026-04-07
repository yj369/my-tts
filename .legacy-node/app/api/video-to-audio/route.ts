import { NextResponse } from "next/server";
import { resolveSandboxTarget, makeDirectory, deletePath } from "@/lib/sandboxFs";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

export async function POST(request: Request) {
  let inputAbs = "";
  try {
    const formData = await request.formData();
    const file = formData.get("video") as File | null;
    
    if (!file) {
      return NextResponse.json({ ok: false, error: "缺少视频文件。" }, { status: 400 });
    }

    // Prepare temp sandbox paths
    await makeDirectory("tts-workflow/tmp/video");
    const timestamp = Date.now();
    const ext = path.extname(file.name) || ".mp4";
    
    const inputRelPath = `tts-workflow/tmp/video/in_${timestamp}${ext}`;
    const outputRelPath = `tts-workflow/tmp/video/out_${timestamp}.wav`;

    const resolvedIn = await resolveSandboxTarget(inputRelPath);
    inputAbs = resolvedIn.absolute;
    
    const resolvedOut = await resolveSandboxTarget(outputRelPath);
    const outputAbs = resolvedOut.absolute;

    // Buffer read and write directly to bypass arbitrary String/Base64 encodings
    const arrayBuffer = await file.arrayBuffer();
    await fs.writeFile(inputAbs, Buffer.from(arrayBuffer));

    // Execute FFmpeg
    // -vn: No video. -acodec pcm_s16le: Uncompressed 16-bit WAV. -ar 44100: sample rate. -ac 1: Mono audio (best for TTS).
    await new Promise<void>((resolve, reject) => {
      const args = ["-i", inputAbs, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", "-y", "-hide_banner", "-loglevel", "error", outputAbs];
      const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderrMessage = "";
      child.stderr.on("data", (chunk) => {
        stderrMessage += chunk.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderrMessage.trim() || `FFmpeg failed with code ${code}`));
        }
      });
      child.on("error", reject);
    });

    const stat = await fs.lstat(outputAbs);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error("FFmpeg processed but output file is empty/missing.");
    }

    // Cleanup video file to save disk space
    try {
      await fs.rm(inputAbs, { force: true });
    } catch { /* ignore cleanup error */ }

    return NextResponse.json({ 
      ok: true, 
      data: {
        path: outputRelPath,
        url: `/sandbox/file?path=${encodeURIComponent(outputRelPath)}`,
        filename: `out_${timestamp}.wav`
      } 
    });

  } catch (error) {
    if (inputAbs) {
        try { await fs.rm(inputAbs, { force: true }); } catch { /* ignore */ }
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "提取音频失败。" },
      { status: 500 }
    );
  }
}
