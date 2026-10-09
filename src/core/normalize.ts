import { LineCounter, parseDocument, isMap, isSeq, type Node as YamlNode } from "yaml";
import type { Diagnostic } from "./diagnostics.js";
import { Model, type AttributeInput, type ModelInput } from "./schema.js";

/**
 * Normalized model: the shape every later stage (lint, layout, render) works on.
 * Ids are stable and derived from the model, so pins and diagnostics survive edits.
 *
 * Node ids used across the code base:
 *   entity        "E:<Entity>"
 *   relationship  "R:<Relationship>"
 *   attribute     "A:<Owner>.<attr>[.<part>...]"   (owner = entity or relationship name)
 *   end           "<Relationship>#<end id or index>"
 */
export type Max = number | "N";

export interface NAttribute {
  id: string;
  name: string;
  label: string;
  /** Model name of the owning entity or relationship. */
  owner: string;
  ownerKind: "entity" | "relationship";
  /** Id of the parent attribute for composite parts. */
  parent?: string;
  parts: NAttribute[];
  multivalued: boolean;
  derived: boolean;
  /** Member of at least one candidate key (solid underline). */
  key: boolean;
  /** Member of the partial key (dashed underline). */
  partial: boolean;
  path: string;
}

export interface NEntity {
  id: string;
  name: string;
  label: string;
  weak: boolean;
  attrs: NAttribute[];
  keys: string[][];
  partialKey: string[];
  note?: string;
  path: string;
}

export interface NEnd {
  id: string;
  /** Index of the end inside its relationship. */
  index: number;
  relationship: string;
  entity: string;
  role?: string;
  min: number;
  max: Max;
  card: string;
  path: string;
}

export interface NRelationship {
  id: string;
  name: string;
  label: string;
  identifies?: string;
  ends: NEnd[];
  attrs: NAttribute[];
  note?: string;
  path: string;
}

export interface NModel {
  title?: string;
  entities: NEntity[];
  relationships: NRelationship[];
  notes: string[];
  specializations: NonNullable<ModelInput["specializations"]>;
  /** Maps a dotted path to a 1-based source position. */
  locate(path: string): { line: number; column: number } | undefined;
}

export interface ParseResult {
  model?: NModel;
  diagnostics: Diagnostic[];
}

export const entityNodeId = (name: string) => `E:${name}`;
export const relationshipNodeId = (name: string) => `R:${name}`;

export function parseCard(card: string): { min: number; max: Max } {
  const [lo = "0", hi = "N"] = card.split("..").map((s) => s.trim());
  const min = Number.parseInt(lo, 10);
  const max: Max = /^\d+$/.test(hi) ? Number.parseInt(hi, 10) : "N";
  return { min, max };
}

/** Parse YAML text, validate its structure and normalize it. Never throws. */
export function parseModel(text: string): ParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false });
  const diagnostics: Diagnostic[] = [];

  const locate = (path: string) => {
    const segments = path === "" ? [] : path.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    let node: unknown = doc.contents;
    let last: unknown = node;
    for (const seg of segments) {
      if (isMap(node)) node = node.get(seg, true);
      else if (isSeq(node) && typeof seg === "number") node = node.get(seg, true);
      else break;
      if (node) last = node;
      else break;
    }
    const range = (last as YamlNode | undefined)?.range;
    if (!range) return undefined;
    const pos = lineCounter.linePos(range[0]);
    return { line: pos.line, column: pos.col };
  };

  for (const err of doc.errors) {
    const pos = err.linePos?.[0] ?? lineCounter.linePos(err.pos[0]);
    diagnostics.push({
      rule: err.code === "DUPLICATE_KEY" ? "duplicate-id" : "yaml-syntax",
      severity: "error",
      message: err.message.split("\n")[0] ?? err.message,
      hint: err.code === "DUPLICATE_KEY" ? "Rename or merge the duplicated key." : "Fix the YAML syntax at this position.",
      line: pos?.line,
      column: pos?.col,
    });
  }
  if (diagnostics.length) return { diagnostics };

  const raw = doc.toJS();
  const parsed = Model.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join(".");
      diagnostics.push({
        rule: "schema",
        severity: "error",
        message: path ? `${path}: ${issue.message}` : issue.message,
        hint: "Run `chen schema` to see the expected structure.",
        path,
        ...locate(path),
      });
    }
    return { diagnostics };
  }

  return { model: normalize(parsed.data, locate), diagnostics };
}

export function normalize(input: ModelInput, locate: NModel["locate"] = () => undefined): NModel {
  const entities: NEntity[] = Object.entries(input.entities).map(([name, e]) => {
    const keys = e.keys ?? [];
    const keyNames = new Set(keys.flat());
    const partial = new Set(e.partialKey ?? []);
    const path = `entities.${name}`;
    return {
      id: entityNodeId(name),
      name,
      label: e.label ?? name,
      weak: e.weak ?? false,
      attrs: (e.attrs ?? []).map((a, i) => normAttr(a, name, "entity", undefined, `${path}.attrs.${i}`, keyNames, partial)),
      keys,
      partialKey: e.partialKey ?? [],
      note: e.note,
      path,
    };
  });

  const relationships: NRelationship[] = Object.entries(input.relationships ?? {}).map(([name, r]) => {
    const path = `relationships.${name}`;
    return {
      id: relationshipNodeId(name),
      name,
      label: r.label ?? name,
      identifies: r.identifies,
      ends: r.ends.map((end, index) => ({
        id: `${name}#${end.id ?? index}`,
        index,
        relationship: name,
        entity: end.entity,
        role: end.role,
        card: end.card.replace(/\s+/g, ""),
        ...parseCard(end.card),
        path: `${path}.ends.${index}`,
      })),
      attrs: (r.attrs ?? []).map((a, i) =>
        normAttr(a, name, "relationship", undefined, `${path}.attrs.${i}`, new Set(), new Set()),
      ),
      note: r.note,
      path,
    };
  });

  return {
    title: input.title,
    entities,
    relationships,
    notes: input.notes ?? [],
    specializations: input.specializations ?? [],
    locate,
  };
}

function normAttr(
  a: AttributeInput,
  owner: string,
  ownerKind: NAttribute["ownerKind"],
  parent: NAttribute | undefined,
  path: string,
  keyNames: ReadonlySet<string>,
  partial: ReadonlySet<string>,
): NAttribute {
  const spec = typeof a === "string" ? { name: a } : a;
  const id = parent ? `${parent.id}.${spec.name}` : `A:${owner}.${spec.name}`;
  const top = parent === undefined;
  const attr: NAttribute = {
    id,
    name: spec.name,
    label: ("label" in spec && spec.label) || spec.name,
    owner,
    ownerKind,
    parent: parent?.id,
    parts: [],
    multivalued: ("multivalued" in spec && spec.multivalued) || false,
    derived: ("derived" in spec && spec.derived) || false,
    key: top && keyNames.has(spec.name),
    partial: top && partial.has(spec.name),
    path,
  };
  const parts = "parts" in spec ? spec.parts : undefined;
  attr.parts = (parts ?? []).map((p, i) => normAttr(p, owner, ownerKind, attr, `${path}.parts.${i}`, keyNames, partial));
  return attr;
}

/** Depth-first list of an owner's attributes including composite parts. */
export function flattenAttrs(attrs: readonly NAttribute[]): NAttribute[] {
  return attrs.flatMap((a) => [a, ...flattenAttrs(a.parts)]);
}
