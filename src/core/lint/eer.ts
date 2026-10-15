import { finding, type Rule } from "./rule.js";

const self: Rule = {
  id: "specialization-self", severity: "error",
  description: "A subtype must differ from its supertype.",
  check: (model) => model.specializations.flatMap((s) => s.subtypes.flatMap((child, j) =>
    child === s.supertype ? [finding(model, self, `${s.path}.subtypes.${j}`,
      `${child} cannot specialize itself.`, "Remove the self-reference from subtypes.")] : [])),
};

const cycle: Rule = {
  id: "specialization-cycle", severity: "error",
  description: "The specialization and category graph must be acyclic.",
  check(model) {
    const edges = new Map<string, Set<string>>();
    const diagnostics: ReturnType<Rule["check"]> = [];
    // Superclass → subclass links in source order, specializations first: each simple cycle is found at its last link.
    const links = [
      ...model.specializations.flatMap((s) => s.subtypes.map((child, j) => ({ parent: s.supertype, child, path: `${s.path}.subtypes.${j}` }))),
      ...model.categories.flatMap((c) => c.supertypes.map((parent, j) => ({ parent, child: c.subtype, path: `${c.path}.supertypes.${j}` }))),
    ];
    for (const { parent, child, path: at } of links) {
      if (child === parent || edges.get(parent)?.has(child)) continue;
      const walk = (node: string, path: string[]) => {
        if (node === parent) {
          diagnostics.push(finding(model, cycle, at,
            `Specialization cycle: ${[...path, child].join(" → ")}.`,
            "Remove a superclass/subclass link to break this cycle."));
          return;
        }
        for (const next of edges.get(node) ?? []) if (!path.includes(next)) walk(next, [...path, next]);
      };
      walk(child, [child]);
      if (!edges.has(parent)) edges.set(parent, new Set());
      edges.get(parent)!.add(child);
    }
    return diagnostics;
  },
};

const duplicateSubtype: Rule = {
  id: "duplicate-subtype", severity: "error",
  description: "Subtypes must be unique within each specialization.",
  check: (model) => model.specializations.flatMap((s) => {
    const seen = new Set<string>();
    return s.subtypes.flatMap((child, j) => {
      const duplicate = seen.has(child);
      seen.add(child);
      return duplicate ? [finding(model, duplicateSubtype, `${s.path}.subtypes.${j}`,
        `${s.name} repeats subtype ${child}.`, "Remove the duplicate subtype.")] : [];
    });
  }),
};

const duplicateId: Rule = {
  id: "duplicate-specialization-id", severity: "error",
  description: "Normalized specialization names must be unique.",
  check(model) {
    const seen = new Set<string>();
    return model.specializations.flatMap((s) => {
      const duplicate = seen.has(s.name);
      seen.add(s.name);
      return duplicate ? [finding(model, duplicateId, `${s.path}.id`,
        `Specialization id ${s.name} is repeated.`, "Assign a unique explicit id to the specialization.")] : [];
    });
  },
};

const unknownAttribute: Rule = {
  id: "unknown-defining-attribute", severity: "error",
  description: "Defining attributes must be top-level attributes of the supertype.",
  check: (model) => model.specializations.flatMap((s) => {
    const parent = model.entities.find((e) => e.name === s.supertype);
    return s.attribute && parent && !parent.attrs.some((a) => a.name === s.attribute)
      ? [finding(model, unknownAttribute, `${s.path}.attribute`,
        `${s.attribute} is not a top-level attribute of ${s.supertype}.`,
        "Use a top-level attribute of the supertype as the defining attribute.")] : [];
  }),
};

const attributeOverlap: Rule = {
  id: "attribute-defined-overlap", severity: "course",
  description: "A single-valued defining attribute implies disjoint subclasses.",
  check: (model) => model.specializations.flatMap((s) => {
    const attr = model.entities.find((e) => e.name === s.supertype)?.attrs.find((a) => a.name === s.attribute);
    return attr && !attr.multivalued && s.disjointness === "overlapping"
      ? [finding(model, attributeOverlap, `${s.path}.attribute`,
        `${s.name} overlaps despite single-valued defining attribute ${s.attribute}.`,
        "Set disjointness to disjoint, or make the defining attribute multivalued.")] : [];
  }),
};

const categorySelf: Rule = {
  id: "category-self", severity: "error",
  description: "A category must differ from each of its superclasses.",
  check: (model) => model.categories.flatMap((c) => c.supertypes.flatMap((parent, j) =>
    parent === c.subtype ? [finding(model, categorySelf, `${c.path}.supertypes.${j}`,
      `${c.subtype} cannot be a category of itself.`, "Remove the category from its own supertypes.")] : [])),
};

const duplicateSupertype: Rule = {
  id: "duplicate-supertype", severity: "error",
  description: "Superclasses must be unique within each category.",
  check: (model) => model.categories.flatMap((c) => {
    const seen = new Set<string>();
    return c.supertypes.flatMap((parent, j) => {
      const duplicate = seen.has(parent);
      seen.add(parent);
      return duplicate ? [finding(model, duplicateSupertype, `${c.path}.supertypes.${j}`,
        `${c.name} repeats superclass ${parent}.`, "Remove the duplicate superclass.")] : [];
    });
  }),
};

const duplicateCategoryId: Rule = {
  id: "duplicate-category-id", severity: "error",
  description: "Normalized category names must be unique.",
  check(model) {
    const seen = new Set<string>();
    return model.categories.flatMap((c) => {
      const duplicate = seen.has(c.name);
      seen.add(c.name);
      return duplicate ? [finding(model, duplicateCategoryId, `${c.path}.id`,
        `Category id ${c.name} is repeated.`, "Assign a unique explicit id to the category.")] : [];
    });
  },
};

export const eerRules: Rule[] = [self, cycle, duplicateSubtype, duplicateId, unknownAttribute, attributeOverlap,
  categorySelf, duplicateSupertype, duplicateCategoryId];
