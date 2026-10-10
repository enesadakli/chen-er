import { lint } from "../../src/core/lint/index.js";
import { flattenAttrs, parseCard, type NAttribute, type NEnd, type NEntity, type NModel, type NRelationship } from "../../src/core/normalize.js";
import { liveTrace, parseRequirements, type RequirementsDoc } from "../../src/core/requirements.js";

export interface Aliases {
  entities?: Record<string, string[]>;
  relationships?: Record<string, string[]>;
  attributes?: Record<string, string[]>;
}
export interface ItemMatch { gold: string; candidate: string }
export type GoldVariantName = "primary" | `alt-${string}`;
interface CheckBase { id: string; why: string; variants?: GoldVariantName[] }
export type DecisionCheck = CheckBase & (
  | { kind: "weak"; entity: string; owner: string }
  | { kind: "ternary" | "recursive"; relationship: string }
  | { kind: "multivalued" | "derived" | "composite"; attribute: string; minParts?: number }
  | { kind: "relationshipAttribute"; relationship: string; attribute: string }
  | { kind: "entity"; entity: string }
  | { kind: "cardinality"; relationship: string; entity: string; card: string; role?: string }
  | { kind: "key"; entity: string; attrs: string[] }
);
export interface ChecksDocument { checks: DecisionCheck[] }
export interface Decisions {
  correct: number;
  total: number;
  accuracy: number;
  failed: { id: string; kind: DecisionCheck["kind"]; why: string; reason: string }[];
}
export interface GoldVariant { name: GoldVariantName; model: NModel }
type NameMatch = "name" | "alias" | "folded";
export interface EntityMatch extends ItemMatch { matchedBy: NameMatch | "structure" }
export interface AttributeMatch extends ItemMatch { matchedBy: NameMatch | "key" | "tokens" }
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
  goldVariant: GoldVariantName;
  decisions: Decisions | null;
  entities: PRF;
  relationships: PRF;
  attributes: PRF;
  keys: Accuracy & { strong: Accuracy; weak: Accuracy; identifying: Accuracy };
  cardinality: Accuracy;
  attributeProperties: Accuracy;
  structure: { lintErrorCount: number; errors: ReturnType<typeof lint> };
  trace: { covered: number; total: number; coverage: number; uncovered: string[] } | null;
  matches: { entities: EntityMatch[]; relationships: ItemMatch[]; attributes: AttributeMatch[] };
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

const foldLetters = (name: string): string => name.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
const plainName = (name: string): string => name.normalize("NFC").toLowerCase().replace(/\u0307/g, "").replace(/[_\s-]/gu, "");
/** Matching only: fold accents and Turkish I; ignore spaces, underscores and hyphens. */
export const normalizeName = (name: string): string => foldLetters(name).toLowerCase().replace(/[_\s-]/gu, "");

function nameMatch(gold: string, candidate: string, aliases: Record<string, string[]> = {}, scopes: string[] = []): NameMatch | undefined {
  if (plainName(gold) === plainName(candidate)) return "name";
  const keys = new Set([gold, ...scopes].map(normalizeName));
  if (Object.entries(aliases).some(([key, values]) => keys.has(normalizeName(key)) &&
    values.some((alias) => normalizeName(alias) === normalizeName(candidate)))) return "alias";
  return normalizeName(gold) === normalizeName(candidate) ? "folded" : undefined;
}
const nameMatches = (gold: string, candidate: string, aliases?: Record<string, string[]>, scopes?: string[]): boolean =>
  nameMatch(gold, candidate, aliases, scopes) !== undefined;
const nameRank = (match: NameMatch | undefined): number => match === "name" ? 0 : match === "alias" ? 1 : match === "folded" ? 2 : 3;

function commonPrefix(gold: string, candidate: string): number {
  const g = normalizeName(gold), c = normalizeName(candidate);
  let length = 0;
  while (length < Math.min(g.length, c.length) && g[length] === c[length]) length++;
  return length;
}

function nameTokens(name: string): string[] {
  return foldLetters(name).replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").match(/\p{L}+|\p{N}+/gu)?.map((token) => token.toLowerCase()) ?? [];
}

function tokenMatches(gold: string, candidate: string): boolean {
  const g = normalizeName(gold), c = normalizeName(candidate);
  const [shorter, longer] = g.length <= c.length ? [g, c] : [c, g];
  if (shorter.length < 3) return false;
  if (longer.startsWith(shorter) || longer.endsWith(shorter)) return true;
  const gt = nameTokens(gold), ct = nameTokens(candidate);
  return gt.length > 0 && gt.length === ct.length && gt.every((token, i) => {
    const other = ct[i]!;
    return Math.min(token.length, other.length) >= 2 && (token.startsWith(other) || other.startsWith(token));
  });
}

export function precisionRecallF1(gold: number, candidate: number, matched: number): PRF {
  return { gold, candidate, matched, precision: ratio(matched, candidate), recall: ratio(matched, gold),
    f1: gold + candidate ? 2 * matched / (gold + candidate) : 1 };
}

function namedPairs<T extends Named>(gold: readonly T[], candidate: readonly T[], match: (g: T, c: T) => NameMatch | undefined): (Pair<T> & { matchedBy: NameMatch })[] {
  const choices = gold.flatMap((g) => candidate.flatMap((c) => {
    const matchedBy = match(g, c);
    return matchedBy ? [{ gold: g, candidate: c, matchedBy }] : [];
  }));
  choices.sort((a, b) => nameRank(a.matchedBy) - nameRank(b.matchedBy) ||
    commonPrefix(b.gold.name, b.candidate.name) - commonPrefix(a.gold.name, a.candidate.name) ||
    compare(a.gold.id, b.gold.id) || compare(a.candidate.id, b.candidate.id));
  const usedGold = new Set<string>(), usedCandidate = new Set<string>();
  return choices.filter((p) => {
    if (usedGold.has(p.gold.id) || usedCandidate.has(p.candidate.id)) return false;
    usedGold.add(p.gold.id); usedCandidate.add(p.candidate.id);
    return true;
  });
}

function entityPairs(gold: NModel, candidate: NModel, aliases: Aliases): Pair<NEntity>[] {
  const pairs: Pair<NEntity>[] = namedPairs(gold.entities, candidate.entities, (g, c) => nameMatch(g.name, c.name, aliases.entities));
  const usedGold = new Set(pairs.map((p) => p.gold.id)), usedCandidate = new Set(pairs.map((p) => p.candidate.id));
  const choices: (Pair<NEntity> & { jaccard: number })[] = [];
  for (const g of sorted(gold.entities).filter((e) => !usedGold.has(e.id))) {
    const ga = sorted(flattenAttrs(g.attrs)), names = new Set(ga.map((a) => normalizeName(a.name)));
    const canonical = (name: string): string => normalizeName((ga.find((a) => normalizeName(a.name) === normalizeName(name)) ??
      ga.find((a) => nameMatches(a.name, name, aliases.attributes, [a.id, a.id.slice(2)])))?.name ?? name);
    const keys = (e: NEntity): string[][] => [...e.keys, ...(e.partialKey.length ? [e.partialKey] : [])];
    for (const c of sorted(candidate.entities).filter((e) => !usedCandidate.has(e.id))) {
      const cn = new Set(flattenAttrs(c.attrs).map((a) => canonical(a.name)));
      const shared = [...names].filter((name) => cn.has(name)).length;
      const union = new Set([...names, ...cn]).size;
      const jaccard = union ? shared / union : 0;
      const equalKey = keys(g).some((gk) => gk.length > 0 && keys(c).some((ck) =>
        signature([...new Set(gk.map(normalizeName))]) === signature([...new Set(ck.map(canonical))])));
      if ((jaccard >= 0.5 && shared >= 2) || equalKey) choices.push({ gold: g, candidate: c, jaccard });
    }
  }
  choices.sort((a, b) => b.jaccard - a.jaccard || compare(a.gold.id, b.gold.id) || compare(a.candidate.id, b.candidate.id));
  for (const choice of choices) {
    if (usedGold.has(choice.gold.id) || usedCandidate.has(choice.candidate.id)) continue;
    pairs.push({ gold: choice.gold, candidate: choice.candidate });
    usedGold.add(choice.gold.id); usedCandidate.add(choice.candidate.id);
  }
  return pairs.sort((a, b) => compare(a.gold.id, b.gold.id));
}

type AttributePair = Pair<NAttribute> & { matchedBy: AttributeMatch["matchedBy"] };
function attributePairs(gold: readonly NAttribute[], candidate: readonly NAttribute[], aliases: Aliases): AttributePair[] {
  const pairs: AttributePair[] = namedPairs(gold, candidate, (g, c) => nameMatch(g.name, c.name, aliases.attributes, [g.id, g.id.slice(2)]));
  const usedGold = new Set(pairs.map((p) => p.gold.id)), usedCandidate = new Set(pairs.map((p) => p.candidate.id));
  const unmatchedGold = gold.filter((a) => !usedGold.has(a.id)), unmatchedCandidate = candidate.filter((a) => !usedCandidate.has(a.id));
  const gKeys = unmatchedGold.filter((a) => a.key || a.partial), cKeys = unmatchedCandidate.filter((a) => a.key || a.partial);
  if (gKeys.length === 1 && cKeys.length === 1) {
    pairs.push({ gold: gKeys[0]!, candidate: cKeys[0]!, matchedBy: "key" });
    usedGold.add(gKeys[0]!.id); usedCandidate.add(cKeys[0]!.id);
  }
  const choices = unmatchedGold.flatMap((g) => unmatchedCandidate.filter((c) =>
    g.multivalued === c.multivalued && tokenMatches(g.name, c.name)).map((c) => ({ gold: g, candidate: c })));
  choices.sort((a, b) => commonPrefix(b.gold.name, b.candidate.name) - commonPrefix(a.gold.name, a.candidate.name) ||
    compare(a.gold.id, b.gold.id) || compare(a.candidate.id, b.candidate.id));
  for (const choice of choices) {
    if (usedGold.has(choice.gold.id) || usedCandidate.has(choice.candidate.id)) continue;
    pairs.push({ ...choice, matchedBy: "tokens" });
    usedGold.add(choice.gold.id); usedCandidate.add(choice.candidate.id);
  }
  pairs.sort((a, b) => compare(a.gold.id, b.gold.id));
  return pairs.flatMap((pair) => [pair, ...attributePairs(pair.gold.parts, pair.candidate.parts, aliases)]);
}

const signature = (names: string[]): string => JSON.stringify([...names].sort(compare));
function relationshipPairs(gold: NModel, candidate: NModel, entities: Pair<NEntity>[], aliases: Aliases): Pair<NRelationship>[] {
  const entityMap = new Map(entities.map((pair) => [pair.candidate.name, pair.gold.name]));
  const available = sorted(candidate.relationships), pairs: Pair<NRelationship>[] = [];
  for (const g of sorted(gold.relationships)) {
    const target = signature(g.ends.map((end) => `gold:${end.entity}`));
    const choices = available.filter((c) => signature(c.ends.map((end) => entityMap.has(end.entity)
      ? `gold:${entityMap.get(end.entity)!}` : `candidate:${end.entity}`)) === target);
    choices.sort((a, b) => nameRank(nameMatch(g.name, a.name, aliases.relationships)) - nameRank(nameMatch(g.name, b.name, aliases.relationships)) ||
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

/** Gold references are exact model names; aliases apply only when mapping to the candidate. */
export function checkReferenceErrors(check: DecisionCheck, gold: NModel): string[] {
  const errors: string[] = [];
  const entity = (name: string): NEntity | undefined => {
    const found = gold.entities.find((e) => e.name === name);
    if (!found) errors.push(`Unknown gold entity: ${name}`);
    return found;
  };
  const relationship = "relationship" in check ? gold.relationships.find((r) => r.name === check.relationship) : undefined;
  if ("relationship" in check && !relationship) errors.push(`Unknown gold relationship: ${check.relationship}`);
  if ("entity" in check) {
    entity(check.entity);
    if (check.kind === "cardinality" && relationship && !relationship.ends.some((e) =>
      e.entity === check.entity && (check.role === undefined || e.role === check.role))) errors.push("Unknown gold end or role");
  }
  if (check.kind === "weak") entity(check.owner);
  const attributes = [...gold.entities, ...gold.relationships].flatMap((o) => flattenAttrs(o.attrs));
  if ("attribute" in check) {
    const path = check.kind === "relationshipAttribute" && !check.attribute.includes(".")
      ? `${check.relationship}.${check.attribute}` : check.attribute;
    if (!attributes.some((a) => a.id === `A:${path}`)) errors.push(`Unknown gold attribute: ${path}`);
  }
  if (check.kind === "key") for (const name of check.attrs) {
    if (!attributes.some((a) => a.id === `A:${check.entity}.${name}`)) errors.push(`Unknown gold attribute: ${check.entity}.${name}`);
  }
  return errors;
}

function decisionScores(gold: NModel, candidate: NModel, entities: Pair<NEntity>[], relationships: Pair<NRelationship>[],
  attrs: Pair<NAttribute>[], aliases: Aliases, checks: ChecksDocument | undefined, variant: GoldVariantName): Decisions | null {
  if (!checks) return null;
  const applicable = checks.checks.filter((c) => !c.variants || c.variants.includes(variant));
  const entity = (name: string): NEntity | undefined => entities.find((p) => p.gold.name === name)?.candidate;
  const relationship = (name: string): NRelationship | undefined => relationships.find((p) => p.gold.name === name)?.candidate;
  const attribute = (path: string): NAttribute | undefined => attrs.find((p) => p.gold.id === `A:${path}`)?.candidate;
  const evaluate = (check: DecisionCheck): string | null => {
    const invalid = checkReferenceErrors(check, gold);
    if (invalid.length) return invalid.join("; ");
    const e = "entity" in check ? entity(check.entity) : undefined;
    const r = "relationship" in check ? relationship(check.relationship) : undefined;
    if ("entity" in check && !e) return `No candidate entity matches ${check.entity}`;
    switch (check.kind) {
      case "entity": return null;
      case "weak": {
        const owner = entity(check.owner);
        if (!owner) return `No candidate entity matches owner ${check.owner}`;
        if (!e!.weak) return "Matched entity is not weak";
        if (!e!.partialKey.length || !e!.partialKey.every((name) => e!.attrs.some((a) => a.name === name))) return "Matched entity has no valid partial key";
        return candidate.relationships.some((rel) => rel.identifies === e!.name && rel.ends.some((end) => end.entity === e!.name) &&
          rel.ends.some((end) => end.entity === owner.name)) ? null : "No identifying relationship links the matched entity to its owner";
      }
      case "ternary": {
        if (!r) return `No candidate relationship matches ${check.relationship}`;
        const g = gold.relationships.find((rel) => rel.name === check.relationship)!;
        const participants = g.ends.map((end) => entity(end.entity)?.name);
        if (participants.some((name) => name === undefined)) return "A gold participant has no candidate entity match";
        return participants.length === 3 && candidate.relationships.some((rel) => rel.ends.length === 3 &&
          signature(rel.ends.map((end) => end.entity)) === signature(participants as string[])) ? null : "No three-ended relationship has the matched participants";
      }
      case "recursive": {
        if (!r) return `No candidate relationship matches ${check.relationship}`;
        const g = gold.relationships.find((rel) => rel.name === check.relationship)!;
        const participant = entity(g.ends[0]!.entity);
        return participant && r.ends.length === 2 && r.ends.every((end) => end.entity === participant.name)
          ? null : "Matched relationship does not have two ends on the same matched entity";
      }
      case "multivalued": case "derived": case "composite": {
        const a = attribute(check.attribute);
        if (!a) return `No candidate attribute matches ${check.attribute}`;
        if (check.kind === "composite") return a.parts.length >= (check.minParts ?? 2) ? null : `Matched attribute has fewer than ${check.minParts ?? 2} parts`;
        return a[check.kind] ? null : `Matched attribute is not ${check.kind}`;
      }
      case "relationshipAttribute": {
        if (!r) return `No candidate relationship matches ${check.relationship}`;
        const path = check.attribute.includes(".") ? check.attribute : `${check.relationship}.${check.attribute}`;
        const a = attribute(path);
        if (!a || a.ownerKind !== "relationship" || a.owner !== r.name) return "Attribute is missing from the matched relationship";
        const g = attrs.find((p) => p.gold.id === `A:${path}`)!.gold;
        const onParticipant = r.ends.some((end) => {
          const participant = candidate.entities.find((item) => item.name === end.entity);
          return flattenAttrs(participant?.attrs ?? []).some((item) => nameMatches(g.name, item.name, aliases.attributes, [g.id, path]));
        });
        return onParticipant ? "Attribute also occurs on a participant entity" : null;
      }
      case "cardinality": {
        if (!r) return `No candidate relationship matches ${check.relationship}`;
        const g = gold.relationships.find((rel) => rel.name === check.relationship)!;
        const goldEnds = g.ends.filter((end) => end.entity === check.entity && (check.role === undefined || end.role === check.role));
        if (goldEnds.length !== 1) return "Gold end is ambiguous; specify a role";
        const end = endPairs({ gold: g, candidate: r }, entities).find((p) => p.gold === goldEnds[0])?.candidate;
        if (!end) return "No candidate end matches the gold end";
        const expected = parseCard(check.card);
        return end.min === expected.min && end.max === expected.max ? null : `Expected ${check.card}, got ${end.min}..${end.max}`;
      }
      case "key": {
        if (e!.weak) return "Matched entity is weak instead of strong";
        const mapped = check.attrs.map((name) => attribute(`${check.entity}.${name}`)?.name);
        if (mapped.some((name) => name === undefined)) return "A key attribute has no candidate match";
        return e!.keys.some((key) => signature([...new Set(key)]) === signature([...new Set(mapped as string[])])) ? null : "No candidate key equals the matched attribute set";
      }
    }
  };
  const failed = applicable.flatMap((check) => {
    const reason = evaluate(check);
    return reason === null ? [] : [{ id: check.id, kind: check.kind, why: check.why, reason }];
  });
  const correct = applicable.length - failed.length;
  return { correct, total: applicable.length, accuracy: ratio(correct, applicable.length), failed };
}

/** Select the highest overall score, breaking ties by primary then lexical variant name. */
export function scoreVariants(variants: readonly GoldVariant[], candidate: NModel, aliases: Aliases = {},
  requirements?: RequirementsDoc | string, checks?: ChecksDocument): ScoreReport {
  if (!variants.length) throw new Error("At least one gold variant is required");
  const ordered = [...variants].sort((a, b) => Number(b.name === "primary") - Number(a.name === "primary") || compare(a.name, b.name));
  const reports = ordered.map((variant) => scoreModels(variant.model, candidate, aliases, requirements, checks, variant.name));
  return reports.reduce((best, report) => report.overall > best.overall ? report : best);
}

/** Scores normalized models without I/O, mutation, randomness, or global state. */
export function scoreModels(gold: NModel, candidate: NModel, aliases: Aliases = {}, requirements?: RequirementsDoc | string, checks?: ChecksDocument, goldVariant: GoldVariantName = "primary"): ScoreReport {
  const entities = entityPairs(gold, candidate, aliases);
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
  const decisions = decisionScores(gold, candidate, entities, relationships, attrs, aliases, checks, goldVariant);
  const terms = [entityMetric.f1, relMetric.f1, attrMetric.f1, keys.accuracy, cardinality.accuracy];
  if (decisions) terms.push(decisions.accuracy);
  return {
    goldVariant, decisions,
    overall: terms.reduce((sum, term) => sum + term, 0) / terms.length,
    entities: entityMetric, relationships: relMetric, attributes: attrMetric, keys, cardinality,
    attributeProperties: { correct: attrs.length - wrongAttributeProperties.length, total: goldAttrs.length, evaluated: attrs.length,
      accuracy: ratio(attrs.length - wrongAttributeProperties.length, goldAttrs.length) },
    structure: { lintErrorCount: errors.length, errors },
    trace: doc ? { covered: doc.items.length - uncovered.length, total: doc.items.length, coverage: ratio(doc.items.length - uncovered.length, doc.items.length), uncovered } : null,
    matches: { entities: entities.map((p) => ({ gold: p.gold.id, candidate: p.candidate.id,
      matchedBy: nameMatch(p.gold.name, p.candidate.name, aliases.entities) ?? "structure" })), relationships: ids(relationships),
      attributes: attrs.map((p) => ({ gold: p.gold.id, candidate: p.candidate.id, matchedBy: p.matchedBy })) },
    details: {
      unmatchedGold: { entities: missing(gold.entities, entities, "gold"), relationships: missing(gold.relationships, relationships, "gold"), attributes: missing(goldAttrs, attrs, "gold") },
      extraCandidate: { entities: missing(candidate.entities, entities, "candidate"), relationships: missing(candidate.relationships, relationships, "candidate"), attributes: missing(candidateAttrs, attrs, "candidate") },
      wrongKeys, wrongCardinalities, degreeErrors: degreeErrors(gold, candidate, entities, relationships, aliases), wrongAttributeProperties,
    },
  };
}
