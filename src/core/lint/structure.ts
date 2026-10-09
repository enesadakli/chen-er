import type { NAttribute } from "../normalize.js";
import { finding, type Rule } from "./rule.js";

const unknownEntity: Rule = {
  id: "unknown-entity", severity: "error",
  description: "Every relationship and specialization reference must name an existing entity.",
  check(model) {
    const names = new Set(model.entities.map((entity) => entity.name));
    const references = model.relationships.flatMap((rel) => [
      ...rel.ends.map((end) => ({ name: end.entity, path: `${end.path}.entity`, owner: rel.name })),
      ...(rel.identifies ? [{ name: rel.identifies, path: `${rel.path}.identifies`, owner: rel.name }] : []),
    ]);
    model.specializations.forEach((spec, index) => {
      references.push({ name: spec.supertype, path: `specializations.${index}.supertype`, owner: "specialization" });
      spec.subtypes.forEach((name, sub) => references.push({
        name, path: `specializations.${index}.subtypes.${sub}`, owner: `specialization of ${spec.supertype}`,
      }));
    });
    return references.filter((ref) => !names.has(ref.name)).map((ref) => finding(model, unknownEntity, ref.path,
      `${ref.owner} references unknown entity ${ref.name}.`,
      `Define ${ref.name} under entities or replace this reference with an existing entity name.`));
  },
};

const unknownKey: Rule = {
  id: "unknown-key-attribute", severity: "error",
  description: "Candidate and partial keys must reference top-level attributes of their entity.",
  check(model) {
    return model.entities.flatMap((entity) => {
      const names = new Set(entity.attrs.map((attr) => attr.name));
      const references = [
        ...entity.keys.flatMap((key, i) => key.map((name, j) => ({ name, path: `${entity.path}.keys.${i}.${j}` }))),
        ...entity.partialKey.map((name, i) => ({ name, path: `${entity.path}.partialKey.${i}` })),
      ];
      return references.filter((ref) => !names.has(ref.name)).map((ref) => finding(model, unknownKey, ref.path,
        `Key of ${entity.name} references ${ref.name}, which is not a top-level attribute.`,
        `Add ${ref.name} to ${entity.name}.attrs or replace the key reference with a top-level attribute name.`));
    });
  },
};

const duplicateAttribute: Rule = {
  id: "duplicate-attribute", severity: "error",
  description: "Attribute names must be unique among siblings within each owner.",
  check(model) {
    const checkLevel = (attrs: readonly NAttribute[], owner: string): ReturnType<Rule["check"]> => {
      const seen = new Set<string>();
      return attrs.flatMap((attr) => {
        const duplicates = seen.has(attr.name) ? [finding(model, duplicateAttribute, attr.path,
          `${owner} repeats attribute ${attr.name} at the same level.`,
          `Rename or merge the duplicate ${attr.name} attribute in ${owner}.`)] : [];
        seen.add(attr.name);
        return [...duplicates, ...checkLevel(attr.parts, `${owner}.${attr.name}`)];
      });
    };
    return [...model.entities, ...model.relationships].flatMap((owner) => checkLevel(owner.attrs, owner.name));
  },
};

const invalidCardinality: Rule = {
  id: "invalid-cardinality", severity: "error",
  description: "Cardinality maxima must be positive and at least their minima.",
  check: (model) => model.relationships.flatMap((rel) => rel.ends
    .filter((end) => typeof end.max === "number" && (end.max === 0 || end.min > end.max))
    .map((end) => finding(model, invalidCardinality, `${end.path}.card`,
      `${rel.name}'s ${end.entity} end has invalid cardinality ${end.card}.`,
      `Set ${rel.name}'s ${end.entity} cardinality to a positive maximum at least as large as its minimum.`))),
};

const duplicateEndId: Rule = {
  id: "duplicate-end-id", severity: "error",
  description: "Explicit end ids must be unique within a relationship.",
  check: (model) => model.relationships.flatMap((rel) => {
    const seen = new Set<string>();
    return rel.ends.flatMap((end) => {
      // Generated ids have numeric suffixes; explicit identifiers cannot start with a digit.
      if (end.id === `${rel.name}#${end.index}`) return [];
      const duplicate = seen.has(end.id);
      seen.add(end.id);
      return duplicate ? [finding(model, duplicateEndId, `${end.path}.id`,
        `${rel.name} repeats end id ${end.id.slice(rel.name.length + 1)} at entity ${end.entity}.`,
        `Assign a unique explicit id to each end of ${rel.name}.`)] : [];
    });
  }),
};

const recursiveMissingRole: Rule = {
  id: "recursive-missing-role", severity: "error",
  description: "Every repeated entity end of a recursive relationship must have a role.",
  check: (model) => model.relationships.flatMap((rel) => {
    const counts = new Map<string, number>();
    rel.ends.forEach((end) => counts.set(end.entity, (counts.get(end.entity) ?? 0) + 1));
    return rel.ends.filter((end) => (counts.get(end.entity) ?? 0) > 1 && !end.role?.trim())
      .map((end) => finding(model, recursiveMissingRole, `${end.path}.role`,
        `${rel.name} repeats ${end.entity}, but end ${end.index} has no role.`,
        `Give every ${end.entity} end of ${rel.name} a role describing its participation.`));
  }),
};

const unsupportedEer: Rule = {
  id: "unsupported-eer", severity: "error",
  description: "Version 1 cannot draw non-empty specializations.",
  check: (model) => model.specializations.length ? [finding(model, unsupportedEer, "specializations",
    `Version 1 cannot draw specializations of ${model.specializations.map((spec) => spec.supertype).join(", ")}.`,
    "Remove specializations from this version 1 model and represent the required facts with entities and relationships.")] : [],
};

export const structureRules: Rule[] = [unknownEntity, unknownKey, duplicateAttribute, invalidCardinality,
  duplicateEndId, recursiveMissingRole, unsupportedEer];
