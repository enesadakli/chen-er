import { finding, type Rule } from "./rule.js";

const weakWithoutPartialKey: Rule = {
  id: "weak-without-partial-key", severity: "course",
  description: "Weak entities should declare a partial key.",
  check: (model) => model.entities.filter((entity) => entity.weak && !entity.partialKey.length)
    .map((entity) => finding(model, weakWithoutPartialKey, `${entity.path}.partialKey`,
      `Weak entity ${entity.name} has no partial key.`,
      `Add partialKey to ${entity.name} using top-level attributes that distinguish it within its owner.`)),
};

const entityWithoutKey: Rule = {
  id: "entity-without-key", severity: "course",
  description: "Non-weak entities should declare a candidate key.",
  check: (model) => model.entities.filter((entity) => !entity.weak && !entity.keys.length)
    .map((entity) => finding(model, entityWithoutKey, `${entity.path}.keys`,
      `Entity ${entity.name} has no candidate key.`,
      `Add keys to ${entity.name} using top-level attributes that uniquely identify each instance.`)),
};

const genericNames = new Set(["HAS", "HAVE", "HAVING", "IS", "ARE", "RELATES", "RELATEDTO", "BELONGS", "BELONGSTO"]);
const genericRelationshipName: Rule = {
  id: "generic-relationship-name", severity: "course",
  description: "Relationship names should express meaning instead of a generic association.",
  check: (model) => model.relationships.filter((rel) => genericNames.has(rel.name.replace(/[_-]/g, "").toUpperCase()))
    .map((rel) => finding(model, genericRelationshipName, rel.path,
      `Relationship ${rel.name} has a generic name that does not explain its meaning.`,
      `Rename ${rel.name} using a verb that says what the relationship means, or a role noun.`)),
};

export const courseRules: Rule[] = [weakWithoutPartialKey, entityWithoutKey, genericRelationshipName];
