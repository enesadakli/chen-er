import { flattenAttrs, type NModel } from "../core/normalize.js";

export function diagnosticTarget(path: string | undefined, model: NModel | undefined): string | undefined {
  if (!path || !model) return undefined;
  for (const owner of [...model.entities, ...model.relationships]) {
    if (path !== owner.path && !path.startsWith(`${owner.path}.`)) continue;
    const attrs = flattenAttrs(owner.attrs).sort((a, b) => b.path.length - a.path.length);
    const attr = attrs.find((a) => path === a.path || path.startsWith(`${a.path}.`));
    if (attr) return attr.id;
    if (path.startsWith(`${owner.path}.attrs.`)) return undefined;
    if ("ends" in owner && path.startsWith(`${owner.path}.ends.`)) {
      const end = owner.ends.find((e) => path === e.path || path.startsWith(`${e.path}.`));
      return end ? `edge:${end.id}` : undefined;
    }
    return owner.id;
  }
  return undefined;
}
