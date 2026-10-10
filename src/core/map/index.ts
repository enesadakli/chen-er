import { hasErrors } from "../diagnostics.js";
import { lint } from "../lint/index.js";
import { flattenAttrs, type NAttribute, type NEnd, type NModel, type NRelationship } from "../normalize.js";
import type { MappingExplanation, MappingRelation, MappingResponse, MappingResult, MappingStep } from "./types.js";
import { dependencyOrder } from "./format.js";
export type * from "./types.js";
export type { MappingFormat } from "./format.js";
export { formatMapping, mappingMarkdown, mappingText, mappingSql } from "./format.js";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T extends { name: string }>(items: readonly T[]) => [...items].sort((a, b) => compare(a.name, b.name));
const distinct = <T>(items: T[]) => [...new Set(items)];
const isMany = (end: NEnd) => end.max !== 1;

function binaryDestination(rel: NRelationship): { destination: NEnd; tied: boolean } {
  const ones = rel.ends.filter((end) => !isMany(end));
  const candidates = ones.length === 2 && ones.some((end) => end.min >= 1)
    ? ones.filter((end) => end.min >= 1) : ones;
  return {
    destination: [...candidates].sort((a, b) => compare(a.entity, b.entity) || compare(a.id, b.id))[0]!,
    tied: candidates.length > 1,
  };
}

/** Names reserved by stored attributes, including relationship attributes added later. */
function attributeNames(attributes: readonly NAttribute[], prefix = ""): string[] {
  return attributes.flatMap((attr) => {
    if (attr.derived || attr.multivalued) return [];
    const name = prefix ? `${prefix}_${attr.name}` : attr.name;
    return attr.parts.length ? attributeNames(attr.parts, name) : [name.toLowerCase()];
  });
}

/** Map normalized ER data without I/O. No partial mapping is returned for invalid input. */
export function mapModel(model: NModel): MappingResponse {
  // This diagnostic describes the renderer's capability, not an invalid EER model.
  const diagnostics = lint(model, { disable: ["unsupported-eer"] });
  const error = (path: string, message: string) => diagnostics.push({
    rule: "mapping", severity: "error", path, ...model.locate(path), message,
  });
  const parents = new Map<string, string[]>();
  model.specializations.forEach((spec, i) => {
    for (const child of spec.subtypes) {
      if (child === spec.supertype) error(`specializations.${i}`, `E:${child}: a specialization cannot be its own superclass.`);
      parents.set(child, distinct([...(parents.get(child) ?? []), spec.supertype]).sort(compare));
      if (model.entities.find((e) => e.name === child)?.weak) error(`specializations.${i}`, `E:${child}: a weak subclass has two identity sources; resolve its identity before mapping.`);
    }
  });
  for (const e of model.entities) {
    const keys = e.weak ? [e.partialKey, ...e.keys] : e.keys;
    if (!(e.weak ? e.partialKey.length : e.keys.length || parents.has(e.name))) {
      error(e.path, `${e.id}: declare ${e.weak ? "a partial key" : "a candidate key"}; mapping never invents an identifier.`);
    }
    for (const key of keys) for (const name of key) {
      const attr = e.attrs.find((a) => a.name === name);
      if (attr && flattenAttrs([attr]).some((a) => a.derived || a.multivalued)) {
        error(attr.path, `${attr.id}: a key must consist of stored, single-valued components.`);
      }
    }
    if (e.weak && model.relationships.filter((r) => r.identifies === e.name).length > 1) {
      error(e.path, `${e.id}: multiple identifying relationships leave owner identity ambiguous; use one identifying relationship with all owners.`);
    }
  }
  if (hasErrors(diagnostics)) return { diagnostics };

  const result: MappingResult = { relations: [], notes: [...model.notes] };
  const entityTables = new Map<string, MappingRelation>();
  // Plan every relationship FK before allocating any: the first of two references
  // must get a descriptive name too, including owner FKs that form a weak PK.
  type ForeignKeyPlan = { relationship: NRelationship; end: NEnd };
  const foreignKeyPlans = new Map<string, ForeignKeyPlan[]>();
  const reservedAttributes = new Map(model.entities.map((e) => [e.id, new Set(attributeNames(e.attrs))]));
  for (const rel of model.relationships) {
    let ownerId: string;
    let targets: NEnd[];
    if (rel.identifies) {
      ownerId = `E:${rel.identifies}`;
      const identified = rel.ends.find((end) => end.entity === rel.identifies);
      targets = rel.ends.filter((end) => end !== identified);
    } else if (rel.ends.length === 2 && rel.ends.some((end) => !isMany(end))) {
      const { destination } = binaryDestination(rel);
      ownerId = `E:${destination.entity}`;
      targets = rel.ends.filter((end) => end !== destination);
    } else {
      ownerId = rel.id;
      targets = rel.ends;
    }
    foreignKeyPlans.set(ownerId, [...(foreignKeyPlans.get(ownerId) ?? []), ...targets.map((end) => ({ relationship: rel, end }))]);
    reservedAttributes.set(ownerId, new Set([...(reservedAttributes.get(ownerId) ?? []), ...attributeNames(rel.attrs)]));
  }
  // A common ancestor's identity is reused across a specialization lattice.
  const identityRoots = new Map<string, string>();
  const relationNames = new Set<string>();
  const multivalued: { attr: NAttribute; owner: MappingRelation; prefix: string }[] = [];
  const note = (message: string) => { if (!result.notes.includes(message)) result.notes.push(message); };
  // SQL's unquoted identifiers are case insensitive; reserve names in that namespace too.
  const allocate = (base: string, used: Set<string>, source: string) => {
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`;
    used.add(name.toLowerCase());
    if (name !== base) note(`${source}: name collision; ${base} renamed to ${name}.`);
    return name;
  };
  const explain = (step: MappingStep, elementIds: string[], reason: string): MappingExplanation => ({ step, elementIds, reason });
  const table = (name: string, explanation: MappingExplanation) => {
    const relation: MappingRelation = {
      name: allocate(name, relationNames, explanation.elementIds.join(", ")), ...explanation,
      columns: [], primaryKey: [], uniqueKeys: [], foreignKeys: [], steps: [explanation],
    };
    result.relations.push(relation);
    return relation;
  };
  const column = (owner: MappingRelation, name: string, sourceIds: string[], notNull = false, reserved: ReadonlySet<string> = new Set()) => {
    const used = new Set([...owner.columns.map((c) => c.name.toLowerCase()), ...reserved]);
    const actual = allocate(name, used, sourceIds.join(", "));
    owner.columns.push({ name: actual, sourceIds, notNull });
    return actual;
  };
  const key = (owner: MappingRelation, names: string[], primary = false) => {
    const cols = distinct(names);
    for (const c of owner.columns) if (cols.includes(c.name)) c.notNull = true;
    if (primary) owner.primaryKey = cols;
    else if (cols.length && cols.join("\0") !== owner.primaryKey.join("\0") && !owner.uniqueKeys.some((k) => k.join("\0") === cols.join("\0"))) owner.uniqueKeys.push(cols);
  };
  const attrs = (owner: MappingRelation, attributes: NAttribute[], prefix = ""): Map<string, string[]> => {
    const mapped = new Map<string, string[]>();
    for (const attr of attributes) {
      const base = prefix ? `${prefix}_${attr.name}` : attr.name;
      if (attr.derived) {
        note(`${attr.id}: derived attribute omitted; compute it from stored data.`);
        mapped.set(attr.name, []);
      } else if (attr.multivalued) {
        multivalued.push({ attr, owner, prefix: base });
        mapped.set(attr.name, []);
      } else if (attr.parts.length) {
        mapped.set(attr.name, [...attrs(owner, attr.parts, base).values()].flat());
      } else mapped.set(attr.name, [column(owner, base, [attr.id])]);
    }
    return mapped;
  };
  const copyPk = (owner: MappingRelation, target: MappingRelation, prefix: string, sources: string[], notNull: boolean, reuse = false, reserved?: ReadonlySet<string>) => {
    const columns = target.primaryKey.map((pk) => {
      const base = prefix ? `${prefix}_${pk}` : pk;
      const existing = reuse ? owner.columns.find((c) => c.name === base) : undefined;
      if (existing) { existing.sourceIds = distinct([...existing.sourceIds, ...sources]); existing.notNull ||= notNull; return existing.name; }
      return column(owner, base, sources, notNull, reserved);
    });
    owner.foreignKeys.push({ columns, references: { relation: target.name, columns: [...target.primaryKey] }, sourceIds: sources });
    return columns;
  };
  const copyRelationshipPk = (owner: MappingRelation, target: MappingRelation, rel: NRelationship, end: NEnd, notNull: boolean) => {
    const ownerId = owner.elementIds[0]!;
    const plans = foreignKeyPlans.get(ownerId) ?? [];
    const reserved = reservedAttributes.get(ownerId) ?? new Set<string>();
    const repeatedTarget = (entity: string) => plans.filter((plan) => plan.end.entity === entity).length
      + Number(ownerId.startsWith("E:") && (parents.get(ownerId.slice(2)) ?? []).includes(entity)) > 1;
    const preferredPrefix = (plan: ForeignKeyPlan, pk: string[]) => plan.end.role || (
      repeatedTarget(plan.end.entity) || pk.some((name) => reserved.has(`${plan.end.entity}_${name}`.toLowerCase()))
        ? plan.relationship.name : plan.end.entity
    );
    let prefix = preferredPrefix({ relationship: rel, end }, target.primaryKey);
    if (!end.role && prefix === end.entity) {
      const candidates = target.primaryKey.map((pk) => `${prefix}_${pk}`.toLowerCase());
      const collides = owner.columns.some((c) => candidates.includes(c.name.toLowerCase())) || plans.some((plan) => {
        if (plan.relationship === rel && plan.end === end) return false;
        const pk = entityTables.get(plan.end.entity)?.primaryKey ?? [];
        const otherPrefix = preferredPrefix(plan, pk);
        return pk.some((name) => candidates.includes(`${otherPrefix}_${name}`.toLowerCase()));
      });
      if (collides) prefix = rel.name;
    }
    const reservedNames = new Set(reserved);
    if (!end.role) {
      // Keep explicit roles readable even when their FK is allocated later.
      for (const plan of plans) {
        if (!plan.end.role) continue;
        for (const pk of entityTables.get(plan.end.entity)?.primaryKey ?? []) {
          reservedNames.add(`${plan.end.role}_${pk}`.toLowerCase());
        }
      }
    }
    return copyPk(owner, target, prefix, [rel.id, end.id, `E:${end.entity}`], notNull, false, reservedNames);
  };
  const participation = (rel: NRelationship, enforced: Set<string>) => {
    for (const end of rel.ends) {
      if (end.min >= 1 && !enforced.has(end.id)) note(`${rel.id}, ${end.id} (E:${end.entity} ${end.card}): minimum participation ${end.min} requires an assertion or trigger; FK/NOT NULL does not ensure a referenced entity has relationship rows.`);
      if (end.min > 1 && enforced.has(end.id)) note(`${rel.id}, ${end.id}: NOT NULL enforces one participation, not minimum ${end.min}; use an assertion or trigger.`);
      if (typeof end.max === "number" && end.max > 1) note(`${rel.id}, ${end.id}: finite maximum ${end.max} is treated as many; enforce the count with an assertion or trigger.`);
    }
  };
  const building = new Set<string>();
  const buildEntity = (name: string): MappingRelation => {
    const existing = entityTables.get(name);
    if (existing) return existing;
    const e = model.entities.find((item) => item.name === name)!;
    if (building.has(name)) throw new Error(`${e.id}: cyclic identity dependency between ownership and specialization.`);
    building.add(name);
    const parentNames = parents.get(name) ?? [];
    const parent = parentNames[0];
    const identifying = e.weak ? model.relationships.find((r) => r.identifies === name)! : undefined;
    const owners = identifying?.ends.filter((end) => end !== identifying.ends.find((x) => x.entity === name)) ?? [];
    const parentTables = parentNames.map(buildEntity);
    const inherited = parentTables[0];
    const ownerTables = owners.map((end) => buildEntity(end.entity));
    const explanation = inherited
      ? explain(8, [e.id, ...parentNames.map((p) => `E:${p}`)], `${e.id} is a subclass of ${parentNames.map((p) => `E:${p}`).join(", ")}; option 8A inherits the superclass PK as its PK and FK.`)
      : identifying
        ? explain(2, [e.id, identifying.id], `${e.id} is weak, identified by ${identifying.id}; PK = owner PK(s) + partial key.`)
        : explain(1, [e.id], `${e.id} is regular; first candidate key is the PK, remaining candidate keys are UNIQUE.`);
    const out = table(e.name, explanation);
    entityTables.set(name, out);
    const own = attrs(out, e.attrs);
    const expand = (names: string[]) => names.flatMap((n) => own.get(n) ?? []);
    if (inherited) {
      const primary = copyPk(out, inherited, "", [e.id, `E:${parent}`], true, true);
      key(out, primary, true);
      const root = identityRoots.get(parent!)!;
      identityRoots.set(name, root);
      const inheritedKeys = new Map<string, string[]>([[root, primary]]);
      parentNames.slice(1).forEach((other, i) => {
        const target = parentTables[i + 1]!;
        const otherRoot = identityRoots.get(other)!;
        const shared = inheritedKeys.get(otherRoot);
        if (shared) {
          out.foreignKeys.push({ columns: [...shared], references: { relation: target.name, columns: [...target.primaryKey] }, sourceIds: [e.id, `E:${other}`] });
          for (const c of out.columns) if (shared.includes(c.name)) c.sourceIds = distinct([...c.sourceIds, `E:${other}`]);
        } else {
          const secondary = copyPk(out, target, other, [e.id, `E:${other}`], true);
          key(out, secondary);
          inheritedKeys.set(otherRoot, secondary);
          note(`${e.id}: multiple superclass identities; choose E:${parent} by lexical order for the PK, and keep E:${other}'s PK as a NOT NULL UNIQUE FK. Their correspondence is represented by the subclass row.`);
        }
      });
    }
    else if (identifying) {
      const ownerKeys = owners.flatMap((end, i) => copyRelationshipPk(out, ownerTables[i]!, identifying, end, true));
      key(out, [...ownerKeys, ...expand(e.partialKey)], true);
      attrs(out, identifying.attrs);
      participation(identifying, new Set(identifying.ends.filter((end) => end.entity === name).map((end) => end.id)));
      if (owners.length === 1 && owners[0]!.max === 1) key(out, ownerKeys);
      if (owners.length > 1) note(`${identifying.id}: joint owner identity uses all owner PKs; n-ary participation bounds beyond FK existence need assertions or triggers.`);
    } else key(out, expand(e.keys[0]!), true);
    if (!inherited) identityRoots.set(name, e.id);
    for (const candidate of (inherited || e.weak ? e.keys : e.keys.slice(1))) key(out, expand(candidate));
    if (e.note) note(`${e.id}: ${e.note}`);
    building.delete(name);
    return out;
  };
  try {
    sorted(model.entities).forEach((e) => buildEntity(e.name));
  } catch (err) {
    error("entities", err instanceof Error ? err.message : String(err));
    return { diagnostics };
  }

  for (const rel of sorted(model.relationships)) {
    if (rel.note) note(`${rel.id}: ${rel.note}`);
    if (rel.identifies) continue;
    const cards = rel.ends.map((end) => `E:${end.entity}${end.role ? `/${end.role}` : ""} ${end.card}`).join(", ");
    const ones = rel.ends.filter((end) => !isMany(end));
    if (rel.ends.length === 2 && ones.length) {
      const step = ones.length === 2 ? 3 : 4;
      const { destination, tied } = binaryDestination(rel);
      const targetEnd = rel.ends.find((end) => end !== destination)!;
      const out = entityTables.get(destination.entity)!;
      const target = entityTables.get(targetEnd.entity)!;
      const tie = tied ? "; both or neither end is total: choose the first entity/end id in lexical order" : "";
      const explanation = explain(step, [rel.id, destination.id, targetEnd.id],
        `${rel.id} is ${step === 3 ? "1:1" : "1:N"} (${cards}); FK on E:${destination.entity}${destination.role ? `/${destination.role}` : ""}, the ${step === 3 ? "chosen" : "max=1 (relational N-side)"} end${tie}.`);
      out.steps.push(explanation);
      const fk = copyRelationshipPk(out, target, rel, targetEnd, destination.min >= 1);
      if (step === 3) {
        // Optional 1:1 must retain nullable FK columns; UNIQUE does not imply NOT NULL.
        out.uniqueKeys.push(fk);
      }
      attrs(out, rel.attrs);
      if (destination.min === 0 && fk.length > 1) note(`${rel.id}: optional composite FK ${out.name}(${fk.join(", ")}) must be all NULL or all non-NULL; add MATCH FULL or a CHECK in the target SQL dialect.`);
      if (destination.min === 0 && rel.attrs.some((a) => !a.derived)) note(`${rel.id}: relationship attributes in ${out.name} are meaningful only when the FK is present; enforce that dependency with a CHECK or trigger.`);
      participation(rel, new Set(destination.min >= 1 ? [destination.id] : []));
    } else {
      const step = rel.ends.length > 2 ? 7 : 5;
      const out = table(rel.name, explain(step, [rel.id], `${rel.id} is ${step === 7 ? "n-ary" : "M:N"} (${cards}); PK = ${step === 7 ? "FKs of many ends only; max=1 ends excluded" : "all participating PKs"}.`));
      const endKeys = rel.ends.map((end) => copyRelationshipPk(out, entityTables.get(end.entity)!, rel, end, true));
      let pk = endKeys.filter((_, i) => step === 5 || isMany(rel.ends[i]!)).flat();
      if (!pk.length) {
        pk = endKeys.flat();
        out.reason = `${rel.id} is n-ary (${cards}); every end has max=1: use all FKs as PK and UNIQUE each end FK because the many-end PK would be empty.`;
        out.steps[0]!.reason = out.reason;
        note(`${rel.id}: every n-ary end has max=1, so the requested many-end PK is empty; use all FKs as PK and UNIQUE each end FK.`);
      }
      key(out, pk, true);
      if (step === 7 && ones.length) {
        ones.forEach((end) => key(out, endKeys[end.index]!));
        note(`${rel.id}: step 7 uses the requested many-end PK rule, which assumes many ends jointly determine excluded max=1 ends. Here cards count each entity's participations, not multiplicity for a fixed combination; UNIQUE on each max=1 end enforces that bound, while the PK adds a functional-dependency assumption to review.`);
      }
      attrs(out, rel.attrs);
      participation(rel, new Set());
    }
  }
  // The queue can grow when a multivalued composite contains another multivalued component.
  for (let i = 0; i < multivalued.length; i++) {
    const { attr, owner, prefix } = multivalued[i]!;
    const out = table(`${owner.name}_${prefix}`, explain(6, [attr.id, ...owner.elementIds], `${attr.id} is multivalued; PK = owner PK + stored simple value components.`));
    const ownerKeys = copyPk(out, owner, owner.name, [attr.id, ...owner.elementIds], true);
    const valueKeys = [...attrs(out, [{ ...attr, multivalued: false }]).values()].flat();
    if (!valueKeys.length) {
      error(attr.path, `${attr.id}: multivalued attribute has no stored simple value components to distinguish values.`);
      continue;
    }
    key(out, [...ownerKeys, ...valueKeys], true);
  }
  model.specializations.forEach((spec, i) => {
    const membership = spec.disjointness === "disjoint" ? "disjoint membership needs an assertion or trigger" : "overlapping membership is allowed";
    const coverage = spec.completeness === "total" ? "total coverage needs an assertion or trigger" : "partial coverage permits superclass-only rows";
    note(`specializations.${i} (E:${spec.supertype}): option 8A keeps superclass + subclass tables; ${membership}; ${coverage}. Alternatives: 8B subclass-only tables for total specialization, 8C one table with a type discriminator for disjoint subclasses, 8D one table with membership flags for overlapping subclasses.`);
  });
  result.relations = dependencyOrder(result.relations);
  return hasErrors(diagnostics) ? { diagnostics } : { mapping: result, diagnostics };
}
