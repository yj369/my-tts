import { NextResponse } from "next/server";
import path from "path";
import { listDirectory } from "@/lib/sandboxFs";

export const dynamic = "force-dynamic";

const VOICE_DIR = "indextts/voices";
const ALLOWED_AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".webm"]);

type VoiceItem = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  type: "file" | "dir";
};

const isAudioFile = (name: string) =>
  ALLOWED_AUDIO_EXTS.has(path.extname(name).toLowerCase());

const isMissingDirectoryError = (err: unknown) => {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes("路径不存在") || err.message.includes("目标不是目录");
};

export async function GET() {
  try {
    const data = await listDirectory(VOICE_DIR);
    const audioItems = (data.items as VoiceItem[]).filter(
      (item) => item.type === "file" && isAudioFile(item.name)
    );
    return NextResponse.json({ ok: true, data: { items: audioItems } });
  } catch (err) {
    if (isMissingDirectoryError(err)) {
      return NextResponse.json({ ok: true, data: { items: [] } });
    }
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "读取音色失败。",
      },
      { status: 500 }
    );
  }
}
