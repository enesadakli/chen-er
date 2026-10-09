// File helpers for the viewer's layout writes. The viewer never writes the model file.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export class GuardError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const revision = (bytes: Buffer | null): string => bytes === null ? "absent" : createHash("sha256").update(bytes).digest("hex");
export function fileBytes(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function guardRegular(path: string, absent = false): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new GuardError(403, "The write path must be a regular file without links.");
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
/** Recheck immediately before rename. Ordinary editors cannot share a filesystem compare-and-swap;
 * an external write in the remaining check/rename interval is still possible. */
export function replaceBytes(path: string, expected: Buffer | null, next: Buffer | null): void {
  guardRegular(path, expected === null);
  if (revision(fileBytes(path)) !== revision(expected)) throw new GuardError(409, "The file changed externally. Reload and retry.");
  if (next === null) { if (expected !== null) unlinkSync(path); return; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { flag: "wx", mode: expected === null ? 0o600 : lstatSync(path).mode & 0o777 });
    guardRegular(path, expected === null);
    if (revision(fileBytes(path)) !== revision(expected)) throw new GuardError(409, "The file changed externally. Reload and retry.");
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
