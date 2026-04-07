import { NextResponse } from "next/server";
import {
  deletePath,
  listDirectory,
  makeDirectory,
  readFileContent,
  renamePath,
  statPath,
  writeFileContent,
} from "@/lib/sandboxFs";

export const dynamic = "force-dynamic";

const authorize = (request: Request) => {
  const token = process.env.APP_SANDBOX_TOKEN;
  if (!token) {
    return true;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const headerToken = request.headers.get("x-sandbox-token") ?? "";
  return bearer === token || headerToken === token;
};

const badRequest = (message: string) =>
  NextResponse.json({ ok: false, error: message }, { status: 400 });

export async function GET(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "未授权。" }, { status: 401 });
  }
  try {
    await listDirectory("");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "无法访问沙盒。" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ ok: false, error: "未授权。" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (err) {
    return badRequest("请求体必须是 JSON。");
  }

  const op = body.op;
  if (typeof op !== "string") {
    return badRequest("缺少 op。");
  }

  try {
    switch (op) {
      case "list": {
        const data = await listDirectory(
          typeof body.path === "string" ? body.path : "",
          Boolean(body.includeHidden)
        );
        return NextResponse.json({ ok: true, data });
      }
      case "read": {
        if (typeof body.path !== "string") {
          return badRequest("缺少 path。");
        }
        const encoding =
          body.encoding === "base64" ? "base64" : "utf8";
        const data = await readFileContent(body.path, encoding);
        return NextResponse.json({ ok: true, data });
      }
      case "write": {
        if (typeof body.path !== "string") {
          return badRequest("缺少 path。");
        }
        if (typeof body.content !== "string") {
          return badRequest("缺少 content。");
        }
        const encoding =
          body.encoding === "base64" ? "base64" : "utf8";
        const data = await writeFileContent(
          body.path,
          body.content,
          encoding,
          body.overwrite !== false,
          body.mkdirs !== false
        );
        return NextResponse.json({ ok: true, data });
      }
      case "mkdir": {
        if (typeof body.path !== "string") {
          return badRequest("缺少 path。");
        }
        const data = await makeDirectory(
          body.path,
          body.recursive !== false
        );
        return NextResponse.json({ ok: true, data });
      }
      case "delete": {
        if (typeof body.path !== "string") {
          return badRequest("缺少 path。");
        }
        const data = await deletePath(
          body.path,
          Boolean(body.recursive)
        );
        return NextResponse.json({ ok: true, data });
      }
      case "rename": {
        if (typeof body.path !== "string" || typeof body.to !== "string") {
          return badRequest("缺少 path 或 to。");
        }
        const data = await renamePath(
          body.path,
          body.to,
          Boolean(body.overwrite)
        );
        return NextResponse.json({ ok: true, data });
      }
      case "stat": {
        if (typeof body.path !== "string") {
          return badRequest("缺少 path。");
        }
        const data = await statPath(body.path);
        return NextResponse.json({ ok: true, data });
      }
      default:
        return badRequest("不支持的 op。");
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "操作失败。" },
      { status: 500 }
    );
  }
}
