import { lint } from "../../src/core/lint/index.js";
import { flattenAttrs, type NAttribute, type NEnd, type NEntity, type NModel, type NRelationship } from "../../src/core/normalize.js";
import { liveTrace, parseRequirements, type RequirementsDoc } from "../../src/core/requirements.js";

export interface Aliases {
  entities?: Record<string, string[]>;
  relationships?: Record<string, string[]>;
  attributes?: Record<string, string[]>;
}
export interface ItemMatch { gold: string; candidate: string }
export interface PRF {
  gold: number;
  candidate: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}
export interface Accuracy { correct: number; total: number; evaluated: number; accuracy: number }
export interface CardinalityValue { min: number; max: number | "N" }
export interface ScoreReport {
  overall: number;
  entities: PRF;
  relationships: PRF;
  attributes: PRF;
  keys: Accuracy & { strong: Accuracy; weak: Accuracy; identifying: Accuracy };
  cardinality: Accuracy;
  attributeProperties: Accuracy;
  structure: { lintErrorCount: number; errors: ReturnType<typeof lint> };
  trace: { covered: number; total: number; coverage: number; uncovered: string[] } | null;
  matches: { entities: ItemMatch[]; relationships: ItemMatch[]; attributes: ItemMatch[] };
  details: {
    unmatchedGold: { entities: string[]; relationships: string[]; attributes: string[] };
    extraCandidate: { entities: string[]; relationships: string[]; attributes: string[] };
    wrongKeys: { gold: string; candidate: string; kind: "strong" | "weak" | "identifying"; expected: unknown; actual: unknown }[];
    wrongCardinalities: { gold: string; candidate: string; expected: CardinalityValue; actual: CardinalityValue }[];
    degreeErrors: { gold: string; candidate: string; goldDegree: number; candidateDegree: number }[];
    wrongAttributeProperties: { gold: string; candidate: string; expected: AttributeProperties; actual: AttributeProperties }[];
  };
}
interface AttributeProperties { multivalued: boolean; derived: boolean }
type Named = { id: string; name: string };
type Pair<T> = { gold: T; candidate: T };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T extends Named>(items: readonly T[]): T[] => [...items].sort((a, b) => compare(a.id, b.id));
const ratio = (correct: number, total: number): number => total ? correct / total : 1;

/** Unicode case folding preserves accents; spaces and underscores are insignificant. */
export const normalizeName = (name: string): string => name.normalize("NFC").toLowerCase().replace(/\u0307/g, "").replace(/[_\s]/gu, "");

function nameMatches(gold: string, candidate: string, aliases: Record<string, string[]> = {}, scopes: string[] = []): boolean {
  if (normalizeName(gold) === normalizeName(candidate)) return true;
  const keys = new Set([gold, ...scopes].map(normalizeName));
  return Object.entries(aliases).some(([key, values]) => keys.has(normalizeName(key)) &&
    values.some((alias) => normalizeName(alias) === normalizeName(candidate)));
}

export function precisionRecallF1(gold: number, candidate: number, matched: number): PRF {
  return { gold, candidate, matched, precision: ratio(matched, candidate), recall: ratio(matched, gold),
    f1: gold + candidate ? 2 * matched / (gold + candidate) : 1 };
}

function greedy<T extends Named>(gold: readonly T[], candidate: readonly T[], accepts: (g: T, c: T) => boolean): Pair<T>[] {
  const available = sorted(candidate), pairs: Pair<T>[] = [];
  for (const g of sorted(gold)) {
    const choices = available.filter((c) => accepts(g, c)).sort((a, b) =>
      Number(normalizeName(g.name) === normalizeName(b.name)) - Number(normalizeName(g.name) === normalizeName(a.name)) || compare(a.id, b.id));
    const c = choices[0];
    if (c) { pairs.push({ gold: g, candidate: c }); available.splice(available.indexOf(c), 1); }
  }
  return pairs;
}

function attributePairs(gold: readonly NAttribute[], candidate: readonly NAttribute[], aliases: Aliases): Pair<NAttribute>[] {
  const pairs = greedy(gold, candidate, (g, c) => nameMatches(g.name, c.name, aliases.attributes, [g.id, g.id.slice(2)]));
  return pairs.flatMap((pair) => [pair, ...attributePairs(pair.gold.parts, pair.candidate.parts, aliases)]);
}

const signature = (names: string[]): string => JSON.stringify(names.sort(compare));
function relationshipPairs(gold: NModel, candidate: NModel, entities: Pair<NEntity>[], aliases: Aliases): Pair<NRelationship>[] {
  const entityMap = new Map(entities.map((pair) => [pair.candidate.name, pair.gold.name]));
  const available = sorted(candidate.relationships), pairs: Pair<NRelationship>[] = [];
  for (const g of sorted(gold.relationships)) {
    const target = signature(g.ends.map((end) => `gold:${end.entity}`));
    const choices = available.filter((c) => signature(c.ends.map((end) => entityMap.has(end.entity)
      ? `gold:${entityMap.get(end.entity)!}` : `candidate:${end.entity}`)) === target);
    choices.sort((a, b) => Number(nameMatches(g.name, b.name, aliases.relationships)) - Number(nameMatches(g.name, a.name, aliases.relationships)) ||
      attributePairs(g.attrs, b.attrs, aliases).length - attributePairs(g.attrs, a.attrs, aliases).length || compare(a.id, b.id));
    const c = choices[0];
    if (c) { pairs.push({ gold: g, candidate: c }); available.splice(available.indexOf(c), 1); }
  }
  return pairs;
}

function endPairs(pair: Pair<NRelationship>, entities: Pair<NEntity>[]): Pair<NEnd>[] {
  const entityMap = new Map(entities.map((p) => [p.gold.name, p.candidate.name]));
  const available = [...pair.candidate.ends], pairs: Pair<NEnd>[] = [];
  const suffix = (end: NEnd): string => end.id.slice(end.relationship.length + 1);
  for (const g of pair.gold.ends) {
    const choices = available.filter((c) => c.entity === entityMap.get(g.entity));
    choices.sort((a, b) => Number(!!g.role && normalizeName(g.role) === normalizeName(b.role ?? "")) -
      Number(!!g.role && normalizeName(g.role) === normalizeName(a.role ?? "")) ||
      Number(normalizeName(suffix(g)) === normalizeName(suffix(b))) - Number(normalizeName(suffix(g)) === normalizeName(suffix(a))) || a.index - b.index);
    const c = choices[0];
    if (c) { pairs.push({ gold: g, candidate: c }); available.splice(available.indexOf(c), 1); }
  }
  return pairs;
}

function missing<T extends Named>(items: readonly T[], matches: Pair<T>[], side: "gold" | "candidate"): string[] {
  const matched = new Set(matches.map((pair) => pair[side].id));
  return sorted(items).filter((item) => !matched.has(item.id)).map((item) => item.id);
}

function degreeErrors(gold: NModel, candidate: NModel, entities: Pair<NEntity>[], relationships: Pair<NRelationship>[], aliases: Aliases): ScoreReport["details"]["degreeErrors"] {
  const entityMap = new Map(entities.map((p) => [p.candidate.name, p.gold.name]));
  const matchedGold = new Set(relationships.map((p) => p.gold.id)), matchedCandidate = new Set(relationships.map((p) => p.candidate.id));
  const subset = (a: string[], b: string[]): boolean => {
    const remaining = [...b];
    return a.every((name) => { const index = remaining.indexOf(name); if (index < 0) return false; remaining.splice(index, 1); return true; });
  };
  return sorted(gold.relationships).filter((g) => !matchedGold.has(g.id)).flatMap((g) => sorted(candidate.relationships)
    .filter((c) => !matchedCandidate.has(c.id) && c.ends.length !== g.ends.length && c.ends.every((end) => entityMap.has(end.entity)))
    .filter((c) => {
      const gn = g.ends.map((end) => end.entity), cn = c.ends.map((end) => entityMap.get(end.entity)!);
      return (subset(gn, cn) || subset(cn, gn)) &&
        (Math.min(gn.length, cn.length) === 2 || nameMatches(g.name, c.name, aliases.relationships));
    }).map((c) => ({ gold: g.id, candidate: c.id, goldDegree: g.ends.length, candidateDegree: c.ends.length })));
}

function keyScores(gold: NModel, entities: Pair<NEntity>[], relationships: Pair<NRelationship>[], attrs: Pair<NAttribute>[]): Pick<ScoreReport, "keys"> & { wrongKeys: ScoreReport["details"]["wrongKeys"] } {
  const wrongKeys: ScoreReport["details"]["wrongKeys"] = [];
  const strong: Accuracy = { correct: 0, total: gold.entities.filter((e) => !e.weak).length, evaluated: 0, accuracy: 0 };
  const weak: Accuracy = { correct: 0, total: gold.entities.filter((e) => e.weak).length, evaluated: 0, accuracy: 0 };
  const identifying: Accuracy = { correct: 0, total: gold.relationships.length, evaluated: relationships.length, accuracy: 0 };
  const attrMap = new Map(attrs.map((p) => [p.candidate.id, p.gold.name]));
  const entityMap = new Map(entities.map((p) => [p.candidate.name, p.gold.name]));
  const keySet = (sets: string[][], owner: NEntity, candidate: boolean): string => signature([...new Set(sets.map((names) =>
    signature([...new Set(names.map((name) => candidate ? attrMap.get(`A:${owner.name}.${name}`) ?? `unmatched:${name}` : name))])))]);
  for (const { gold: g, candidate: c } of entities) {
    const metric = g.weak ? weak : strong;
    metric.evaluated++;
    const expected = g.weak ? { weak: g.weak, partialKey: g.partialKey } : { weak: g.weak, keys: g.keys };
    const actual = g.weak ? { weak: c.weak, partialKey: c.partialKey } : { weak: c.weak, keys: c.keys };
    const equal = g.weak === c.weak && (g.weak
      ? keySet([g.partialKey], g, false) === keySet([c.partialKey], c, true)
      : keySet(g.keys, g, false) === keySet(c.keys, c, true));
    if (equal) metric.correct++;
    else wrongKeys.push({ gold: g.id, candidate: c.id, kind: g.weak ? "weak" : "strong", expected, actual });
  }
  for (const { gold: g, candidate: c } of relationships) {
    const actual = c.identifies ? entityMap.get(c.identifies) ?? `unmatched:${c.identifies}` : null;
    if ((g.identifies ?? null) === actual) identifying.correct++;
    else wrongKeys.push({ gold: g.id, candidate: c.id, kind: "identifying", expected: g.identifies ?? null, actual: c.identifies ?? null });
  }
  for (const metric of [strong, weak, identifying]) metric.accuracy = ratio(metric.correct, metric.total);
  const correct = strong.correct + weak.correct + identifying.correct, total = strong.total + weak.total + identifying.total;
  return { keys: { correct, total, evaluated: strong.evaluated + weak.evaluated + identifying.evaluated, accuracy: ratio(correct, total), strong, weak, identifying }, wrongKeys };
}

/** Scores normalized models without I/O, mutation, randomness, or global state. */
export function scoreModels(gold: NModel, candidate: NModel, aliases: Aliases = {}, requirements?: RequirementsDoc | string): ScoreReport {
  const entities = greedy(gold.entities, candidate.entities, (g, c) => nameMatches(g.name, c.name, aliases.entities));
  const relationships = relationshipPairs(gold, candidate, entities, aliases);
  const attrs = [...entities, ...relationships].flatMap((p) => attributePairs(p.gold.attrs, p.candidate.attrs, aliases));
  const allAttrs = (model: NModel): NAttribute[] => [...model.entities, ...model.relationships].flatMap((owner) => flattenAttrs(owner.attrs));
  const goldAttrs = allAttrs(gold), candidateAttrs = allAttrs(candidate);
  const { keys, wrongKeys } = keyScores(gold, entities, relationships, attrs);
  const ends = relationships.flatMap((pair) => endPairs(pair, entities));
  const wrongCardinalities = ends.filter((p) => p.gold.min !== p.candidate.min || p.gold.max !== p.candidate.max)
    .map((p) => ({ gold: p.gold.id, candidate: p.candidate.id, expected: { min: p.gold.min, max: p.gold.max }, actual: { min: p.candidate.min, max: p.candidate.max } }));
  const cardTotal = gold.relationships.reduce((total, rel) => total + rel.ends.length, 0);
  const cardCorrect = ends.length - wrongCardinalities.length;
  const properties = (attr: NAttribute): AttributeProperties => ({ multivalued: attr.multivalued, derived: attr.derived });
  const wrongAttributeProperties = attrs.filter((p) => p.gold.multivalued !== p.candidate.multivalued || p.gold.derived !== p.candidate.derived)
    .map((p) => ({ gold: p.gold.id, candidate: p.candidate.id, expected: properties(p.gold), actual: properties(p.candidate) }));
  const errors = lint(candidate).filter((diagnostic) => diagnostic.severity === "error");
  const doc = typeof requirements === "string" ? parseRequirements(requirements) : requirements;
  const live = new Set([...candidate.entities, ...candidate.relationships, ...candidateAttrs].map((item) => item.id));
  const uncovered = doc?.items.filter((item) => !liveTrace(item, live).length).map((item) => item.id) ?? [];
  const entityMetric = precisionRecallF1(gold.entities.length, candidate.entities.length, entities.length);
  const relMetric = precisionRecallF1(gold.relationships.length, candidate.relationships.length, relationships.length);
  const attrMetric = precisionRecallF1(goldAttrs.length, candidateAttrs.length, attrs.length);
  const cardinality: Accuracy = { correct: cardCorrect, total: cardTotal, evaluated: ends.length, accuracy: ratio(cardCorrect, cardTotal) };
  const ids = <T extends Named>(pairs: Pair<T>[]): ItemMatch[] => pairs.map((p) => ({ gold: p.gold.id, candidate: p.candidate.id }));
  return {
    overall: (entityMetric.f1 + relMetric.f1 + attrMetric.f1 + keys.accuracy + cardinality.accuracy) / 5,
    entities: entityMetric, relationships: relMetric, attributes: attrMetric, keys, cardinality,
    attributeProperties: { correct: attrs.length - wrongAttributeProperties.length, total: goldAttrs.length, evaluated: attrs.length,
      accuracy: ratio(attrs.length - wrongAttributeProperties.length, goldAttrs.length) },
    structure: { lintErrorCount: errors.length, errors },
    trace: doc ? { covered: doc.items.length - uncovered.length, total: doc.items.length, coverage: ratio(doc.items.length - uncovered.length, doc.items.length), uncovered } : null,
    matches: { entities: ids(entities), relationships: ids(relationships), attributes: ids(attrs) },
    details: {
      unmatchedGold: { entities: missing(gold.entities, entities, "gold"), relationships: missing(gold.relationships, relationships, "gold"), attributes: missing(goldAttrs, attrs, "gold") },
      extraCandidate: { entities: missing(candidate.entities, entities, "candidate"), relationships: missing(candidate.relationships, relationships, "candidate"), attributes: missing(candidateAttrs, attrs, "candidate") },
      wrongKeys, wrongCardinalities, degreeErrors: degreeErrors(gold, candidate, entities, relationships, aliases), wrongAttributeProperties,
    },
  };
}
