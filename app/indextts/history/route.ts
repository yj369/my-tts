import { NextResponse } from "next/server";
import {
  loadHistoryRecords,
  removeHistoryRecord,
} from "../historyStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const records = await loadHistoryRecords();
  return NextResponse.json(
    { ok: true, data: records },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: string };
    if (!body.id) {
      return NextResponse.json(
        { ok: false, error: "缺少 id。" },
        { status: 400 }
      );
    }
    await removeHistoryRecord(body.id);
    const records = await loadHistoryRecords();
    return NextResponse.json(
      { ok: true, data: records },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "删除失败。" },
      { status: 500 }
    );
  }
}
