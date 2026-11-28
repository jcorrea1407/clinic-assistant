import { existsSync, readFileSync } from "node:fs";

/**
 * Reads a JSON-lines file, one object per non-empty line. A missing file is
 * empty. A line that doesn't parse (say, one cut short when a run was killed
 * mid-write) is skipped with a warning naming the file and line, so one bad
 * line never blocks a resume or a summary.
 */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        console.warn(`${path}:${i + 1}: not valid JSON, skipped`);
      }
    });
  return rows;
}
