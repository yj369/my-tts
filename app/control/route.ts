import { NextResponse } from "next/server";
import {
  getWorkflowHistoryRecordById,
  updateWorkflowHistoryRecord,
} from "../historyStore";
import { isWorkflowTaskRunning, startWorkflowTask } from "../runner";
import { setTaskCancelled, setTaskPaused } from "../taskControl";

type Action = "pause" | "resume" | "cancel";

export const dynamic = "force-dynamic";

const isAction = (value: string): value is Action =>
  value === "pause" || value === "resume" || value === "cancel";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      action?: string;
    };

    const id = body.id?.trim();
    const action = body.action?.trim();

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "缺少 id。" },
        { status: 400 }
      );
    }

    if (!action || !isAction(action)) {
      return NextResponse.json(
        { ok: false, error: "不支持的 action。" },
        { status: 400 }
      );
    }

    const record = await getWorkflowHistoryRecordById(id);
    if (!record) {
      return NextResponse.json(
        { ok: false, error: "任务不存在。" },
        { status: 404 }
      );
    }

    if (action === "pause") {
      setTaskCancelled(id, false);
      setTaskPaused(id, true);
      await updateWorkflowHistoryRecord(id, {
        status: "paused",
        error: undefined,
      });
    }

    if (action === "cancel") {
      setTaskPaused(id, false);
      setTaskCancelled(id, true);
      if (!isWorkflowTaskRunning(id)) {
        await updateWorkflowHistoryRecord(id, {
          status: "cancelled",
          error: undefined,
        });
      }
    }

    if (action === "resume") {
      if (record.status === "success") {
        return NextResponse.json(
          { ok: false, error: "任务已完成，无需续跑。" },
          { status: 400 }
        );
      }
      setTaskPaused(id, false);
      setTaskCancelled(id, false);
      if (!isWorkflowTaskRunning(id)) {
        await startWorkflowTask(id);
      } else {
        await updateWorkflowHistoryRecord(id, {
          status: "processing",
          error: undefined,
        });
      }
    }

    const refreshed = await getWorkflowHistoryRecordById(id);
    return NextResponse.json({ ok: true, data: refreshed });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "任务控制失败。" },
      { status: 500 }
    );
  }
}
