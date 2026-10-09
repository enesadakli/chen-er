import { finding, type Rule } from "./rule.js";

const movableRelationshipAttribute: Rule = {
  id: "movable-relationship-attribute", severity: "info",
  description: "Attributes of binary to-one relationships could move to the entity with maximum participation one.",
  check: (model) => model.relationships.flatMap((rel) => {
    if (rel.ends.length !== 2 || !rel.attrs.length) return [];
    const candidates = [...new Set(rel.ends.filter((end) => end.max === 1 && end.min <= 1 &&
      model.entities.some((entity) => entity.name === end.entity)).map((end) => end.entity))];
    if (!candidates.length) return [];
    const destination = candidates.join(" or ");
    return [finding(model, movableRelationshipAttribute, `${rel.path}.attrs`,
      `Attributes ${rel.attrs.map((attr) => attr.name).join(", ")} of ${rel.name} could move to ${destination}, whose end has max = 1.`,
      `Consider moving ${rel.name}'s attributes to ${destination}; preserve whether the relationship participates when it is optional.`)];
  }),
};

export const infoRules: Rule[] = [movableRelationshipAttribute];
