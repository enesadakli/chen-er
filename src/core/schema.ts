import { z } from "zod";

/**
 * Structural schema of a `.er.yaml` model (version 1).
 *
 * This file is the single source of truth for the model format. It only checks
 * shape; semantic rules (unknown references, weak entity rules, ...) live in
 * `lint/`. `scripts/gen-schema.ts` exports it as `schema/er.schema.json`.
 */

/** "min..max" where max is a non-negative integer or N (also accepts M and *). */
export const Cardinality = z
  .string()
  .regex(/^\s*\d+\s*\.\.\s*(\d+|[NnMm*])\s*$/, 'cardinality must look like "0..1", "1..N" or "5..N"')
  .describe('(min,max) participation of the entity at this end, e.g. "1..1", "0..N", "1..3".');

export const Identifier = z
  .string()
  .min(1)
  .regex(/^[\p{L}_][\p{L}\p{N}_-]*$/u, "identifiers start with a letter or _ and contain letters, digits, _ or -");

export const AttributeObject = z
  .object({
    name: Identifier.describe("Attribute name, unique within its owner."),
    label: z.string().optional().describe("Display text if different from name."),
    get parts() {
      return z.array(Attribute).min(2).optional().describe("Component attributes: makes this a composite attribute.");
    },
    multivalued: z.boolean().optional().describe("Drawn as a double ellipse."),
    derived: z.boolean().optional().describe("Drawn as a dashed ellipse."),
  })
  .strict();

export const Attribute: z.ZodType<string | z.infer<typeof AttributeObject>> = z.union([Identifier, AttributeObject]);

export const Entity = z
  .object({
    label: z.string().optional(),
    weak: z.boolean().optional().describe("Weak entity: needs an identifying relationship and a partial key."),
    attrs: z.array(Attribute).optional(),
    keys: z
      .array(z.array(Identifier).min(1))
      .optional()
      .describe("Candidate keys. [[A], [B]] = two single keys; [[A, B]] = one composite key."),
    partialKey: z.array(Identifier).min(1).optional().describe("Partial key of a weak entity (drawn with a dashed underline)."),
    note: z.string().optional(),
  })
  .strict();

export const RelationshipEnd = z
  .object({
    id: Identifier.optional().describe("Stable end id; required to tell the ends of a recursive relationship apart."),
    entity: Identifier,
    role: z.string().optional().describe("Role name, required when the same entity appears at more than one end."),
    card: Cardinality,
  })
  .strict();

export const Relationship = z
  .object({
    label: z.string().optional(),
    identifies: Identifier.optional().describe("Makes this an identifying relationship for the named weak entity; the other ends are its owners."),
    ends: z.array(RelationshipEnd).min(2).describe("Two ends = binary, three or more = n-ary (one diamond)."),
    attrs: z.array(Attribute).optional(),
    note: z.string().optional(),
  })
  .strict();

export const Specialization = z
  .object({
    supertype: Identifier,
    subtypes: z.array(Identifier).min(1),
    disjointness: z.enum(["disjoint", "overlapping"]),
    completeness: z.enum(["total", "partial"]),
  })
  .strict();

export const Model = z
  .object({
    version: z.literal(1),
    title: z.string().optional(),
    entities: z.record(Identifier, Entity),
    relationships: z.record(Identifier, Relationship).optional(),
    notes: z.array(z.string()).optional().describe("Free text printed under the diagram."),
    specializations: z
      .array(Specialization)
      .optional()
      .describe("Reserved for EER. Version 1 does not draw these and reports a diagnostic if present."),
  })
  .strict();

export type ModelInput = z.infer<typeof Model>;
export type EntityInput = z.infer<typeof Entity>;
export type RelationshipInput = z.infer<typeof Relationship>;
export type AttributeInput = z.infer<typeof Attribute>;

/** Pins file next to a model: `model.er.layout.json`. Coordinates are node centers in diagram units (px). */
export const LayoutFile = z
  .object({
    version: z.literal(1),
    engine: z.enum(["layered", "stress", "simple"]).optional(),
    pins: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).default({}),
    /**
     * Soft positions: the last accepted layout (node id → center). Unlike pins they are hints, not
     * constraints; incremental layout keeps them so a drag or a model edit changes as little as possible.
     */
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).optional(),
  })
  .strict();
export type LayoutFileInput = z.infer<typeof LayoutFile>;
