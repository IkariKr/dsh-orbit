import { readdir } from "node:fs/promises";
import { join } from "node:path";

const RUNNERS = new Map([
  [".mjs", "node"],
  [".js", "node"],
  [".sh", "sh"],
]);

/**
 * 列出下游部署提供的运行时 Hook，并按文件名排序以保证执行顺序稳定。
 * Lists downstream runtime hooks in lexical order so execution is deterministic.
 */
export async function listRuntimeHooks(hookDir) {
  let entries;
  try {
    entries = await readdir(hookDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const dot = entry.name.lastIndexOf(".");
      const extension = dot >= 0 ? entry.name.slice(dot) : "";
      const runner = RUNNERS.get(extension);
      if (!runner) return null;
      return {
        name: entry.name,
        path: join(hookDir, entry.name),
        runner,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}
