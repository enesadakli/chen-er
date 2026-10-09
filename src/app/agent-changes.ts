// Change set of one agent turn, compared by stable node ids (E:, R:, A:).
import { flattenAttrs, parseModel, type NModel } from "../core/normalize.js";

export interface ChangeSet { added: string[]; removed: string[]; modified: string[]; parseError?: boolean }

/** One comparable string per node. Owners do not include their attribute list:
 * added or removed attributes are reported by their own ids. */
export function nodeSignatures(model: NModel): Map<string, string> {
  const nodes = new Map<string, string>();
  const attrs = (list: NModel["entities"][number]["attrs"]) => {
    for (const a of flattenAttrs(list)) {
      nodes.set(a.id, JSON.stringify([a.label, a.multivalued, a.derived, a.key, a.partial]));
    }
  };
  for (const e of model.entities) {
    nodes.set(e.id, JSON.stringify([e.label, e.weak, e.keys, e.partialKey, e.note ?? null]));
    attrs(e.attrs);
  }
  for (const r of model.relationships) {
    const ends = r.ends.map((end) => [end.id, end.entity, end.role ?? null, end.card]);
    nodes.set(r.id, JSON.stringify([r.label, r.identifies ?? null, ends, r.note ?? null]));
    attrs(r.attrs);
  }
  return nodes;
}

export function changeSet(before: string | null, after: string | null): ChangeSet {
  const a = before === null ? undefined : parseModel(before).model;
  const b = after === null ? undefined : parseModel(after).model;
  if (!a || !b) return { added: [], removed: [], modified: [], parseError: true };
  const old = nodeSignatures(a), next = nodeSignatures(b);
  const added: string[] = [], removed: string[] = [], modified: string[] = [];
  for (const [id, signature] of next) {
    const previous = old.get(id);
    if (previous === undefined) added.push(id);
    else if (previous !== signature) modified.push(id);
  }
  for (const id of old.keys()) if (!next.has(id)) removed.push(id);
  return { added, removed, modified };
}
