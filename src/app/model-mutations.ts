import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isMap, isSeq, parseDocument } from "yaml";
import { AttributeObject } from "../core/schema.js";
import { flattenAttrs } from "../core/normalize.js";
import { lintText } from "./render.js";

export class MutationError extends Error {
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new MutationError(403, "The write path must be a regular file without links.");
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
/** Recheck immediately before rename. Ordinary editors cannot share a filesystem compare-and-swap;
 * an external write in the remaining check/rename interval is still possible. */
export function replaceBytes(path: string, expected: Buffer | null, next: Buffer | null): void {
  guardRegular(path, expected === null);
  if (revision(fileBytes(path)) !== revision(expected)) throw new MutationError(409, "The file changed externally. Reload and retry.");
  if (next === null) { if (expected !== null) unlinkSync(path); return; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { flag: "wx", mode: expected === null ? 0o600 : lstatSync(path).mode & 0o777 });
    guardRegular(path, expected === null);
    if (revision(fileBytes(path)) !== revision(expected)) throw new MutationError(409, "The file changed externally. Reload and retry.");
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
export function addAttribute(yaml: string, ownerId: unknown, value: unknown): string {
  const spec = AttributeObject.omit({ parts: true }).safeParse(value);
  if (!spec.success) throw new MutationError(400, "Use a valid attribute name, optional label and boolean multivalued/derived flags.");
  if (typeof ownerId !== "string" || !/^[ER]:/.test(ownerId)) throw new MutationError(400, "Select an entity or relationship.");
  const before = lintText(yaml);
  if (!before.model) throw new MutationError(422, "Fix the model's structural errors before adding attributes.");
  const owners = ownerId.startsWith("E:") ? before.model.entities : before.model.relationships;
  const owner = owners.find((o) => o.id === ownerId);
  if (!owner) throw new MutationError(409, "The selected owner no longer exists. Your draft has been kept.");
  if (flattenAttrs(owner.attrs).some((a) => a.name === spec.data.name)) throw new MutationError(422, `Attribute ${spec.data.name} already exists on this owner.`);
  const doc = parseDocument(yaml, { uniqueKeys: true });
  const node = doc.getIn([ownerId.startsWith("E:") ? "entities" : "relationships", owner.name], true);
  if (!isMap(node)) throw new MutationError(422, "This owner uses an alias. Expand it in YAML before adding an attribute.");
  let attrs = node.get("attrs", true);
  if (attrs === undefined) { node.set("attrs", doc.createNode([])); attrs = node.get("attrs", true); }
  if (!isSeq(attrs)) throw new MutationError(422, "The owner's attrs field must be a sequence.");
  const a = spec.data;
  attrs.add(doc.createNode(a.label !== undefined || a.multivalued || a.derived ? a : a.name));
  const next = doc.toString({ lineWidth: 0 });
  const after = lintText(next);
  if (!after.model) throw new MutationError(422, "The edit would make the model structurally invalid.");
  const signature = (d: { rule: string; path?: string; message: string }) => JSON.stringify([d.rule, d.path, d.message]);
  const oldErrors = new Set(before.diagnostics.filter((d) => d.severity === "error").map(signature));
  const errors = after.diagnostics.filter((d) => d.severity === "error" && !oldErrors.has(signature(d)));
  if (errors.length) throw new MutationError(422, `Attribute not saved: ${errors.map((d) => d.message).join(" ")}`);
  return next;
}
