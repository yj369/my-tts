import path from "path";
import fs from "fs/promises";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const normalizeRelativePath = (input?: string) => {
  if (!input) {
    return "";
  }
  const cleaned = input.replace(/\\/g, "/").trim();
  if (!cleaned || cleaned === ".") {
    return "";
  }
  if (cleaned.includes("\0")) {
    throw new Error("路径包含非法字符。");
  }
  const stripped = cleaned.replace(/^\/+/, "");
  const segments = stripped.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("不允许使用 .. 路径。");
  }
  return segments.join(path.sep);
};

const ensureNoSymlink = async (
  rootReal: string,
  targetPath: string,
  allowMissing: boolean
) => {
  const relative = path.relative(rootReal, targetPath);
  if (!relative) {
    return;
  }
  const parts = relative.split(path.sep);
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("不允许访问符号链接。");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (allowMissing) {
          return;
        }
        throw new Error("路径不存在。");
      }
      throw err;
    }
  }
};

const getSandboxRoot = async () => {
  const envRoot = process.env.APP_SANDBOX_DIR;
  if (!envRoot) {
    throw new Error("APP_SANDBOX_DIR 未配置。");
  }
  const rootPath = path.isAbsolute(envRoot)
    ? envRoot
    : path.resolve(process.cwd(), envRoot);

  await fs.mkdir(rootPath, { recursive: true });
  const stat = await fs.lstat(rootPath);
  if (stat.isSymbolicLink()) {
    throw new Error("APP_SANDBOX_DIR 不能是符号链接。");
  }
  if (!stat.isDirectory()) {
    throw new Error("APP_SANDBOX_DIR 必须是目录。");
  }
  const rootReal = await fs.realpath(rootPath);
  return { rootPath, rootReal };
};

const resolveSandboxPath = async (
  input: string | undefined,
  mustExist: boolean
) => {
  const { rootReal } = await getSandboxRoot();
  const relative = normalizeRelativePath(input);
  const absolute = path.resolve(rootReal, relative);
  const relCheck = path.relative(rootReal, absolute);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error("路径超出沙盒范围。");
  }
  await ensureNoSymlink(rootReal, absolute, !mustExist);
  return {
    rootReal,
    absolute,
    relative: relCheck.split(path.sep).join("/"),
  };
};

export const resolveSandboxFile = async (inputPath: string) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, true);
  return { absolute, relative };
};

const getMaxBytes = () => {
  const raw = process.env.APP_SANDBOX_MAX_BYTES;
  if (!raw) {
    return DEFAULT_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BYTES;
  }
  return parsed;
};

export const listDirectory = async (
  inputPath?: string,
  includeHidden = false
) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, true);
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory()) {
    throw new Error("目标不是目录。");
  }
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const filtered = entries.filter((entry) => {
    if (entry.isSymbolicLink()) {
      return false;
    }
    if (!includeHidden && entry.name.startsWith(".")) {
      return false;
    }
    return true;
  });

  const items = await Promise.all(
    filtered.map(async (entry) => {
      const entryPath = path.join(absolute, entry.name);
      const entryStat = await fs.lstat(entryPath);
      const entryRelative = path
        .posix
        .join(relative ? relative.replace(/\\/g, "/") : "", entry.name);
      return {
        name: entry.name,
        path: entryRelative,
        type: entry.isDirectory() ? "dir" : "file",
        size: entryStat.isFile() ? entryStat.size : 0,
        modifiedAt: entryStat.mtime.toISOString(),
      };
    })
  );

  return {
    path: relative,
    items,
  };
};

export const readFileContent = async (
  inputPath: string,
  encoding: "utf8" | "base64" = "utf8"
) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, true);
  const stat = await fs.lstat(absolute);
  if (stat.isDirectory()) {
    throw new Error("目标是目录，无法读取。");
  }
  const maxBytes = getMaxBytes();
  if (stat.size > maxBytes) {
    throw new Error(`文件过大，超过 ${maxBytes} 字节限制。`);
  }
  if (encoding === "base64") {
    const buffer = await fs.readFile(absolute);
    return {
      path: relative,
      encoding: "base64",
      size: stat.size,
      content: buffer.toString("base64"),
    };
  }
  const content = await fs.readFile(absolute, "utf8");
  return {
    path: relative,
    encoding: "utf8",
    size: stat.size,
    content,
  };
};

export const writeFileContent = async (
  inputPath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  overwrite = true,
  mkdirs = true
) => {
  const { rootReal, absolute, relative } = await resolveSandboxPath(
    inputPath,
    false
  );
  if (!relative) {
    throw new Error("不能写入根目录。");
  }
  const parentDir = path.dirname(absolute);
  await ensureNoSymlink(rootReal, parentDir, mkdirs);
  if (!mkdirs) {
    const parentStat = await fs.lstat(parentDir);
    if (!parentStat.isDirectory()) {
      throw new Error("父目录不存在。");
    }
  }
  if (mkdirs) {
    await fs.mkdir(parentDir, { recursive: true });
  }
  if (!overwrite) {
    try {
      await fs.lstat(absolute);
      throw new Error("目标已存在。");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  const data =
    encoding === "base64" ? Buffer.from(content, "base64") : content;
  await fs.writeFile(absolute, data);
  return {
    path: relative,
    size: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data),
  };
};

export const makeDirectory = async (
  inputPath: string,
  recursive = true
) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, false);
  if (!relative) {
    return { path: relative };
  }
  await fs.mkdir(absolute, { recursive });
  return { path: relative };
};

export const deletePath = async (
  inputPath: string,
  recursive = false
) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, true);
  if (!relative) {
    throw new Error("禁止删除根目录。");
  }
  const stat = await fs.lstat(absolute);
  if (stat.isDirectory() && !recursive) {
    throw new Error("目录删除需要 recursive=true。");
  }
  await fs.rm(absolute, { recursive, force: false });
  return { path: relative };
};

export const renamePath = async (
  fromPath: string,
  toPath: string,
  overwrite = false
) => {
  const { rootReal, absolute: fromAbs, relative: fromRel } =
    await resolveSandboxPath(fromPath, true);
  const { absolute: toAbs, relative: toRel } = await resolveSandboxPath(
    toPath,
    false
  );
  if (!fromRel || !toRel) {
    throw new Error("目标路径无效。");
  }
  await ensureNoSymlink(rootReal, path.dirname(toAbs), false);
  if (!overwrite) {
    try {
      await fs.lstat(toAbs);
      throw new Error("目标已存在。");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  await fs.rename(fromAbs, toAbs);
  return { from: fromRel, to: toRel };
};

export const statPath = async (inputPath: string) => {
  const { absolute, relative } = await resolveSandboxPath(inputPath, true);
  const stat = await fs.lstat(absolute);
  return {
    path: relative,
    type: stat.isDirectory() ? "dir" : "file",
    size: stat.isFile() ? stat.size : 0,
    modifiedAt: stat.mtime.toISOString(),
  };
};
