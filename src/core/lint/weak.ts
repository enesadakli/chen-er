import { compareText, finding, type Rule } from "./rule.js";

const identifiesNotAnEnd: Rule = {
  id: "identifies-not-an-end", severity: "error",
  description: "An identifying relationship must include the entity it identifies as an end.",
  check: (model) => model.relationships.filter((rel) => rel.identifies && !rel.ends.some((end) => end.entity === rel.identifies))
    .map((rel) => finding(model, identifiesNotAnEnd, `${rel.path}.identifies`,
      `${rel.name} identifies ${rel.identifies}, which is not one of its ends.`,
      `Add ${rel.identifies} as an end of ${rel.name} or correct the identifies reference.`)),
};

const identifiesNotWeak: Rule = {
  id: "identifies-not-weak", severity: "error",
  description: "An identifies reference must name a weak entity.",
  check: (model) => model.relationships.filter((rel) => model.entities.some((entity) => entity.name === rel.identifies && !entity.weak))
    .map((rel) => finding(model, identifiesNotWeak, `${rel.path}.identifies`,
      `${rel.name} identifies ${rel.identifies}, which is not weak.`,
      `Mark ${rel.identifies} weak if its identity depends on an owner, or remove identifies from ${rel.name}.`)),
};

const weakWithoutIdentifying: Rule = {
  id: "weak-without-identifying", severity: "error",
  description: "Every weak entity must be named by an identifying relationship.",
  check: (model) => model.entities.filter((entity) => entity.weak && !model.relationships.some((rel) => rel.identifies === entity.name))
    .map((entity) => finding(model, weakWithoutIdentifying, `${entity.path}.weak`,
      `Weak entity ${entity.name} has no identifying relationship.`,
      `Add a relationship connecting ${entity.name} to its owner and set identifies to ${entity.name}.`)),
};

const weakEndNotTotal: Rule = {
  id: "weak-end-not-total", severity: "error",
  description: "Identified weak ends require total participation and exactly 1..1 in binary relationships.",
  check: (model) => model.relationships.flatMap((rel) => {
    if (!model.entities.some((entity) => entity.name === rel.identifies && entity.weak)) return [];
    return rel.ends.filter((end) => end.entity === rel.identifies &&
      (end.min === 0 || (rel.ends.length === 2 && (end.min !== 1 || end.max !== 1))))
      .map((end) => finding(model, weakEndNotTotal, `${end.path}.card`,
        `${rel.name} identifies weak entity ${end.entity}, but its end has cardinality ${end.card}; ` +
        (rel.ends.length === 2 ? "a binary identifying end must be exactly 1..1." : "total participation is required."),
        rel.ends.length === 2 ? `Set ${rel.name}'s ${end.entity} end to 1..1.` :
          `Set ${rel.name}'s ${end.entity} minimum participation to at least 1.`));
  }),
};

const identificationCycle: Rule = {
  id: "identification-cycle", severity: "error",
  description: "Weak entities must not depend on each other through a cycle of identifying relationships.",
  check(model) {
    const weakNames = new Set(model.entities.filter((entity) => entity.weak).map((entity) => entity.name));
    const edges = model.relationships.flatMap((rel) => {
      if (!rel.identifies || !weakNames.has(rel.identifies) || !rel.ends.some((end) => end.entity === rel.identifies)) return [];
      const identified = rel.ends.find((end) => end.entity === rel.identifies);
      return rel.ends.filter((end) => end !== identified && weakNames.has(end.entity))
        .map((end) => ({ from: rel.identifies!, to: end.entity, rel }));
    });
    const adjacency = new Map<string, string[]>();
    edges.forEach((edge) => adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]));
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const active = new Set<string>();
    const components: string[][] = [];
    let nextIndex = 0;
    const visit = (name: string): void => {
      indices.set(name, nextIndex);
      low.set(name, nextIndex++);
      stack.push(name);
      active.add(name);
      for (const owner of adjacency.get(name) ?? []) {
        if (!indices.has(owner)) {
          visit(owner);
          low.set(name, Math.min(low.get(name)!, low.get(owner)!));
        } else if (active.has(owner)) low.set(name, Math.min(low.get(name)!, indices.get(owner)!));
      }
      if (low.get(name) !== indices.get(name)) return;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        component.push(member);
      } while (member !== name);
      components.push(component.sort(compareText));
    };
    [...weakNames].sort(compareText).forEach((name) => { if (!indices.has(name)) visit(name); });
    return components.flatMap((component) => {
      const names = new Set(component);
      const cycleEdges = edges.filter((edge) => names.has(edge.from) && names.has(edge.to))
        .sort((a, b) => compareText(a.rel.name, b.rel.name));
      if (component.length === 1 && !cycleEdges.some((edge) => edge.from === edge.to)) return [];
      const first = cycleEdges[0];
      if (!first) return [];
      const relationships = [...new Set(cycleEdges.map((edge) => edge.rel.name))].join(", ");
      return [finding(model, identificationCycle, `${first.rel.path}.identifies`,
        `Weak entities ${component.join(", ")} form an identification cycle through ${relationships}.`,
        `Break the ownership cycle among ${component.join(", ")} by using an independent owner or making an entity strong with its own key.`)];
    });
  },
};

export const weakRules: Rule[] = [identifiesNotAnEnd, identifiesNotWeak, weakWithoutIdentifying, weakEndNotTotal, identificationCycle];
