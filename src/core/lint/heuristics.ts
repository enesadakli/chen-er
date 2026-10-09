import { flattenAttrs, type NEnd, type NRelationship } from "../normalize.js";
import { compareText, finding, type Rule } from "./rule.js";

const parallelRelationships: Rule = {
  id: "parallel-relationships", severity: "heuristic",
  description: "Relationships connecting the same entity set may record the same fact twice.",
  check(model) {
    const groups = new Map<string, NRelationship[]>();
    for (const rel of model.relationships) {
      const key = JSON.stringify([...new Set(rel.ends.map((end) => end.entity))].sort(compareText));
      groups.set(key, [...(groups.get(key) ?? []), rel]);
    }
    return [...groups.values()].flatMap((group) => {
      if (group.length < 2) return [];
      const sorted = group.toSorted((a, b) => compareText(a.name, b.name));
      const first = sorted[0]!;
      const names = sorted.map((rel) => rel.name).join(", ");
      const entities = [...new Set(first.ends.map((end) => end.entity))].sort(compareText).join(", ");
      return [finding(model, parallelRelationships, first.path,
        `Relationships ${names} connect the same entities (${entities}) and may record the same fact twice.`,
        `Justify the difference between ${names} in a note or merge them into one relationship.`)];
    });
  },
};

interface Hop {
  from: string;
  to: string;
  rel: NRelationship;
  end: NEnd;
}

function alternativePath(direct: Hop, adjacency: ReadonlyMap<string, readonly Hop[]>, totalOnly: boolean): Hop[] | undefined {
  const allowed = (hop: Hop) => hop.rel !== direct.rel && (!totalOnly || hop.end.min >= 1);
  const parents = new Map<string, Hop>();
  const visited = new Set([direct.from]);
  const queue: string[] = [];
  // An alternative must start through an intermediate entity, not a parallel direct edge.
  for (const hop of adjacency.get(direct.from) ?? []) {
    if (!allowed(hop) || hop.to === direct.to || visited.has(hop.to)) continue;
    parents.set(hop.to, hop);
    visited.add(hop.to);
    queue.push(hop.to);
  }
  for (let index = 0; index < queue.length; index++) {
    for (const hop of adjacency.get(queue[index]!) ?? []) {
      if (!allowed(hop) || visited.has(hop.to)) continue;
      parents.set(hop.to, hop);
      if (hop.to === direct.to) {
        const path: Hop[] = [];
        let current = direct.to;
        while (current !== direct.from) {
          const step = parents.get(current)!;
          path.push(step);
          current = step.from;
        }
        return path.reverse();
      }
      visited.add(hop.to);
      queue.push(hop.to);
    }
  }
  return undefined;
}

const redundantFunctionalPath: Rule = {
  id: "redundant-functional-path", severity: "heuristic",
  description: "A direct to-one relationship and another to-one path may duplicate a fact or contradict participation.",
  check(model) {
    const entities = new Set(model.entities.map((entity) => entity.name));
    const hops: Hop[] = model.relationships.flatMap((rel) => {
      if (rel.ends.length !== 2 || rel.ends.some((end) => !entities.has(end.entity) ||
        (typeof end.max === "number" && (end.max === 0 || end.min > end.max)))) return [];
      const [left, right] = rel.ends as [NEnd, NEnd];
      if (left.entity === right.entity) return [];
      const directions: [NEnd, NEnd][] = [[left, right], [right, left]];
      return directions.flatMap(([source, target]) => source.max === 1 ?
        [{ from: source.entity, to: target.entity, rel, end: source }] : []);
    }).sort((a, b) => compareText(a.rel.name, b.rel.name) || a.end.index - b.end.index);
    const adjacency = new Map<string, Hop[]>();
    hops.forEach((hop) => adjacency.set(hop.from, [...(adjacency.get(hop.from) ?? []), hop]));
    return hops.flatMap((direct) => {
      const totalPath = alternativePath(direct, adjacency, true);
      const path = totalPath ?? alternativePath(direct, adjacency, false);
      if (!path) return [];
      const route = [direct.from, ...path.map((hop) => `${hop.rel.name} → ${hop.to}`)].join(" → ");
      const contradiction = direct.end.min === 0 && totalPath !== undefined;
      return [finding(model, redundantFunctionalPath, `${direct.end.path}.card`,
        `${direct.rel.name} directly maps ${direct.from} to at most one ${direct.to}, while the to-one path ${route} ` +
        `stores the same fact (${direct.from}'s ${direct.to}) twice and may disagree.` +
        (contradiction ? ` Its direct cardinality ${direct.end.card} permits absence (min = 0), but the path requires a ${direct.to} (min ≥ 1).` : ""),
        `Remove the duplicate ${direct.rel.name} fact or document why it differs from ${path.map((hop) => hop.rel.name).join(" / ")}` +
        (contradiction ? `, and reconcile ${direct.from}'s optional direct participation with the mandatory path.` : "."))];
    });
  },
};

const attributeNamesEntity: Rule = {
  id: "attribute-names-entity", severity: "heuristic",
  description: "Entity attributes named after another entity may hide a relationship.",
  check: (model) => model.entities.flatMap((owner) => flattenAttrs(owner.attrs).flatMap((attr) => {
    const name = attr.name.toLowerCase();
    return model.entities.filter((entity) => entity !== owner &&
      ["", "Id", "No", "Code", "Name"].some((suffix) => name === `${entity.name}${suffix}`.toLowerCase()))
      .map((entity) => finding(model, attributeNamesEntity, attr.path,
        `Attribute ${owner.name}.${attr.name} names entity ${entity.name} and may hide a relationship.`,
        `Replace ${owner.name}.${attr.name} with an explicit relationship to ${entity.name}, or document why it is an independent value.`));
  })),
};

export const heuristicRules: Rule[] = [parallelRelationships, redundantFunctionalPath, attributeNamesEntity];
