import { NextResponse } from "next/server";
import { getIndexTTSQueueSnapshot } from "../queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = getIndexTTSQueueSnapshot();
  return NextResponse.json(
    { ok: true, data },
    { headers: { "Cache-Control": "no-store" } }
  );
}
