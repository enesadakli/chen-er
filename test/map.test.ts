import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { mapText } from "../src/app/map.js";
import { normalize } from "../src/core/normalize.js";
import { mapModel, mappingMarkdown, mappingSql, type MappingResult } from "../src/core/map/index.js";
import type { ModelInput } from "../src/core/schema.js";

const entity = (name: string) => ({ attrs: [name, "Description"], keys: [[name]] });
function mapping(input: Omit<ModelInput, "version">): MappingResult {
  const result = mapModel(normalize({ version: 1, ...input }));
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.mapping).toBeDefined();
  return result.mapping!;
}
const table = (result: MappingResult, name: string) => result.relations.find((r) => r.name === name)!;
const binary = (a: string, b: string) => mapping({
  entities: { CLINIC: entity("ClinicId"), VISIT: entity("VisitId") },
  relationships: { RECEIVES: { ends: [{ entity: "CLINIC", card: a }, { entity: "VISIT", card: b }], attrs: ["ReceivedOn"] } },
});

describe("ER-to-relational mapping", () => {
  it("step 1 flattens composite keys, preserves alternate keys, omits derived attributes", () => {
    const result = mapping({ entities: { SHOP: {
      attrs: [{ name: "Address", parts: ["City", "Street"] }, "Registration", { name: "Age", derived: true }],
      keys: [["Address"], ["Registration"]],
    } } });
    const shop = table(result, "SHOP");
    expect(shop.step).toBe(1);
    expect(shop.primaryKey).toEqual(["Address_City", "Address_Street"]);
    expect(shop.uniqueKeys).toEqual([["Registration"]]);
    expect(shop.columns.every((c) => c.notNull)).toBe(true);
    expect(result.notes.join("\n")).toContain("A:SHOP.Age: derived attribute omitted");
  });

  it("step 2 builds nested weak owners in dependency order and carries identifying attrs", () => {
    const result = mapping({ entities: {
      PAGE: { weak: true, attrs: ["PageNo"], partialKey: ["PageNo"] },
      VOLUME: { weak: true, attrs: ["VolumeNo"], partialKey: ["VolumeNo"] },
      BOOK: entity("BookId"),
    }, relationships: {
      PAGE_OF: { identifies: "PAGE", ends: [{ entity: "PAGE", card: "1..1" }, { entity: "VOLUME", card: "0..N" }], attrs: ["PrintedOn"] },
      VOLUME_OF: { identifies: "VOLUME", ends: [{ entity: "BOOK", card: "0..N" }, { entity: "VOLUME", card: "1..1" }] },
    } });
    expect(result.relations.map((r) => r.name)).toEqual(["BOOK", "VOLUME", "PAGE"]);
    expect(table(result, "PAGE").primaryKey).toEqual(["VOLUME_BOOK_BookId", "VOLUME_VolumeNo", "PageNo"]);
    expect(table(result, "PAGE").columns.some((c) => c.name === "PrintedOn")).toBe(true);
    expect(table(result, "VOLUME").foreignKeys[0]!.references.columns).toEqual(["BookId"]);
  });

  it("step 2 supports a jointly identifying owner set", () => {
    const result = mapping({ entities: {
      SHOP: entity("ShopId"), ITEM: entity("ItemId"),
      STOCK: { weak: true, attrs: ["Batch"], partialKey: ["Batch"] },
    }, relationships: { STOCK_OF: { identifies: "STOCK", ends: [
      { entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "0..N" }, { entity: "STOCK", card: "1..1" },
    ] } } });
    expect(table(result, "STOCK").primaryKey).toEqual(["SHOP_ShopId", "ITEM_ItemId", "Batch"]);
    expect(table(result, "STOCK").foreignKeys).toHaveLength(2);
  });

  it.each([
    ["0..1", "1..1", "VISIT", true, false],
    ["1..1", "0..1", "CLINIC", true, false],
    ["0..1", "0..1", "CLINIC", false, true],
    ["1..1", "1..1", "CLINIC", true, true],
  ])("step 3 chooses the total end or breaks a tie (%s, %s)", (a, b, destination, notNull, tie) => {
    const result = binary(a, b);
    const out = table(result, destination);
    expect(out.steps.at(-1)!.step).toBe(3);
    const fk = out.foreignKeys[0]!;
    expect(out.uniqueKeys).toContainEqual(fk.columns);
    expect(out.columns.find((c) => c.name === fk.columns[0])!.notNull).toBe(notNull);
    expect(out.columns.some((c) => c.name === "ReceivedOn")).toBe(true);
    expect(out.steps.at(-1)!.reason.includes("lexical order")).toBe(tie);
    expect(mappingSql(result)).toContain(`UNIQUE (${fk.columns.join(", ")})`);
  });

  it.each([["0..N", "1..1"], ["1..3", "0..1"], ["0..M", "0..1"], ["0..*", "0..1"]])(
    "step 4 pins own-end participation: CLINIC %s VISIT %s puts FK on VISIT", (a, b) => {
      const result = binary(a, b);
      expect(table(result, "CLINIC").foreignKeys).toEqual([]);
      const visit = table(result, "VISIT");
      expect(visit.steps.at(-1)!.step).toBe(4);
      expect(visit.foreignKeys[0]!.references.relation).toBe("CLINIC");
      expect(visit.columns.find((c) => c.name === "CLINIC_ClinicId")!.notNull).toBe(b === "1..1");
    },
  );

  it("step 4 also pins reversed end order and reports unenforceable owner participation", () => {
    const result = binary("1..1", "1..N");
    expect(table(result, "CLINIC").foreignKeys[0]!.references.relation).toBe("VISIT");
    expect(result.notes.join("\n")).toContain("RECEIVES#1 (E:VISIT 1..N)");
  });

  it("step 5 uses both PKs and relationship attrs, and reports finite bounds", () => {
    const result = binary("2..3", "0..N");
    const out = table(result, "RECEIVES");
    expect(out.step).toBe(5);
    expect(out.primaryKey).toEqual(["CLINIC_ClinicId", "VISIT_VisitId"]);
    expect(out.foreignKeys).toHaveLength(2);
    expect(out.columns.some((c) => c.name === "ReceivedOn")).toBe(true);
    expect(result.notes.join("\n")).toContain("finite maximum 3");
    expect(result.notes.join("\n")).toContain("minimum participation 2");
  });

  it("step 6 maps multivalued composite values and relationship-owned values", () => {
    const result = mapping({ entities: {
      SHOP: { attrs: ["ShopId", { name: "Contact", multivalued: true, parts: ["Kind", "Number"] }], keys: [["ShopId"]] },
      ITEM: entity("ItemId"),
    }, relationships: { SELLS: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "0..N" }], attrs: [{ name: "Tags", multivalued: true }] } } });
    expect(table(result, "SHOP_Contact").primaryKey).toEqual(["SHOP_ShopId", "Contact_Kind", "Contact_Number"]);
    expect(table(result, "SELLS_Tags").primaryKey).toEqual(["SELLS_SHOP_ShopId", "SELLS_ITEM_ItemId", "Tags"]);
    expect(table(result, "SHOP").columns.some((c) => c.name.startsWith("Contact"))).toBe(false);
    expect(table(result, "SELLS_Tags").step).toBe(6);
  });

  it("step 7 excludes max=1 end FKs from PK but keeps all FKs and marks the convention", () => {
    const result = mapping({ entities: { SHOP: entity("ShopId"), ITEM: entity("ItemId"), COURIER: entity("CourierId") },
      relationships: { DELIVERS: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "1..N" }, { entity: "COURIER", card: "0..1" }] } } });
    const out = table(result, "DELIVERS");
    expect(out.step).toBe(7);
    expect(out.primaryKey).toEqual(["SHOP_ShopId", "ITEM_ItemId"]);
    expect(out.foreignKeys).toHaveLength(3);
    expect(out.uniqueKeys).toEqual([["COURIER_CourierId"]]);
    expect(out.reason).toContain("max=1 ends excluded");
    expect(result.notes.join("\n")).toContain("functional-dependency assumption");
  });

  it("step 7 handles all-to-one ends without inventing an empty PK", () => {
    const result = mapping({ entities: { SHOP: entity("ShopId"), ITEM: entity("ItemId"), COURIER: entity("CourierId") },
      relationships: { DELIVERS: { ends: ["SHOP", "ITEM", "COURIER"].map((name) => ({ entity: name, card: "0..1" })) } } });
    expect(table(result, "DELIVERS").primaryKey).toHaveLength(3);
    expect(table(result, "DELIVERS").uniqueKeys).toHaveLength(3);
    expect(result.notes.join("\n")).toContain("many-end PK is empty");
  });

  it("step 8A inherits identity down a specialization chain and mentions alternatives", () => {
    const result = mapping({ entities: { STAFF: entity("StaffId"), CLINICIAN: { attrs: ["License"], keys: [["License"]] }, SURGEON: { attrs: ["Specialty"] } },
      specializations: [
        { supertype: "STAFF", subtypes: ["CLINICIAN"], disjointness: "disjoint", completeness: "total" },
        { supertype: "CLINICIAN", subtypes: ["SURGEON"], disjointness: "overlapping", completeness: "partial" },
      ] });
    expect(result.relations.map((r) => r.name)).toEqual(["STAFF", "CLINICIAN", "SURGEON"]);
    expect(table(result, "SURGEON").primaryKey).toEqual(["StaffId"]);
    expect(table(result, "CLINICIAN").uniqueKeys).toEqual([["License"]]);
    expect(table(result, "CLINICIAN").step).toBe(8);
    expect(result.notes.join("\n")).toContain("8B");
    expect(result.notes.join("\n")).toContain("8C");
    expect(result.notes.join("\n")).toContain("8D");
  });

  it("step 8A reuses an explicitly declared superclass PK column", () => {
    const result = mapping({ entities: { STAFF: entity("StaffId"), CLINICIAN: entity("StaffId") }, specializations: [
      { supertype: "STAFF", subtypes: ["CLINICIAN"], disjointness: "disjoint", completeness: "partial" },
    ] });
    expect(table(result, "CLINICIAN").columns.filter((c) => c.name === "StaffId")).toHaveLength(1);
    expect(table(result, "CLINICIAN").uniqueKeys).toEqual([]);
  });

  it("uses referenced end roles for recursive FK names", () => {
    const result = mapping({ entities: { STAFF: entity("StaffId") }, relationships: { SUPERVISES: { ends: [
      { id: "boss", entity: "STAFF", role: "supervisor", card: "0..N" },
      { id: "junior", entity: "STAFF", role: "trainee", card: "0..1" },
    ] }, MENTORS: { ends: [
      { entity: "STAFF", role: "mentor", card: "0..N" }, { entity: "STAFF", role: "mentee", card: "0..N" },
    ] } } });
    expect(table(result, "STAFF").foreignKeys[0]!.columns).toEqual(["supervisor_StaffId"]);
    expect(table(result, "MENTORS").primaryKey).toEqual(["mentor_StaffId", "mentee_StaffId"]);
  });

  it("suffixes table and column collisions deterministically and reports them", () => {
    const result = mapping({ entities: {
      SHOP: { attrs: ["ShopId", "ITEM_ItemId", "a_b", { name: "a", parts: ["b", "c"] }, { name: "Tags", multivalued: true }], keys: [["ShopId"]] },
      ITEM: entity("ItemId"), SHOP_Tags: entity("TagId"),
    }, relationships: {
      SELLS: { ends: [{ entity: "SHOP", card: "0..1" }, { entity: "ITEM", card: "0..N" }] },
      SHOP: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "0..N" }] },
    } });
    expect(table(result, "SHOP").columns.map((c) => c.name)).toContain("a_b_2");
    expect(table(result, "SHOP").foreignKeys[0]!.columns).toEqual(["ITEM_ItemId_2"]);
    expect(result.relations.map((r) => r.name)).toContain("SHOP_2");
    expect(result.relations.map((r) => r.name)).toContain("SHOP_Tags_2");
    expect(result.notes.filter((n) => n.includes("name collision"))).toHaveLength(4);
  });

  it("rejects invalid lint input and unrepresentable keys instead of returning partial tables", () => {
    for (const input of [
      { entities: { SHOP: { attrs: ["Name"] } } },
      { entities: { SHOP: { attrs: [{ name: "Id", derived: true }], keys: [["Id"]] } } },
      { entities: { SHOP: { attrs: [{ name: "Id", multivalued: true }], keys: [["Id"]] } } },
      { entities: { SHOP: entity("Id") }, relationships: { VISITS: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "MISSING", card: "0..1" }] } } },
    ]) {
      const result = mapText(stringify({ version: 1, ...input }));
      expect(result.mapping).toBeUndefined();
      expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    }
  });

  it("rejects specialization cycles", () => {
    for (const pairs of [[["SHOP", "ITEM"], ["ITEM", "SHOP"]]]) {
      const result = mapModel(normalize({ version: 1, entities: { SHOP: entity("ShopId"), ITEM: entity("ItemId"), COURIER: entity("CourierId") },
        specializations: pairs.map(([supertype, subtype]) => ({ supertype: supertype!, subtypes: [subtype!], disjointness: "disjoint", completeness: "partial" })) }));
      expect(result.mapping).toBeUndefined();
      expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    }
  });

  it("step 8A reuses a common ancestor key in a multiple-inheritance lattice", () => {
    const result = mapping({ entities: { STAFF: entity("StaffId"), CLINICIAN: {}, RESEARCHER: {}, SPECIALIST: {} }, specializations: [
      { supertype: "STAFF", subtypes: ["CLINICIAN", "RESEARCHER"], disjointness: "overlapping", completeness: "partial" },
      { supertype: "CLINICIAN", subtypes: ["SPECIALIST"], disjointness: "disjoint", completeness: "partial" },
      { supertype: "RESEARCHER", subtypes: ["SPECIALIST"], disjointness: "disjoint", completeness: "partial" },
    ] });
    const out = table(result, "SPECIALIST");
    expect(out.primaryKey).toEqual(["StaffId"]);
    expect(out.columns).toHaveLength(1);
    expect(out.foreignKeys.map((fk) => fk.references.relation)).toEqual(["CLINICIAN", "RESEARCHER"]);
    expect(out.foreignKeys.every((fk) => fk.columns[0] === "StaffId")).toBe(true);
  });

  it("step 8A preserves independent superclass identities as candidate keys", () => {
    const result = mapping({ entities: { CLINICIAN: entity("License"), RESEARCHER: entity("ResearcherId"), SPECIALIST: {} }, specializations: [
      { supertype: "RESEARCHER", subtypes: ["SPECIALIST"], disjointness: "disjoint", completeness: "partial" },
      { supertype: "CLINICIAN", subtypes: ["SPECIALIST"], disjointness: "disjoint", completeness: "partial" },
    ] });
    const out = table(result, "SPECIALIST");
    expect(out.primaryKey).toEqual(["License"]);
    expect(out.uniqueKeys).toEqual([["RESEARCHER_ResearcherId"]]);
    expect(out.foreignKeys).toHaveLength(2);
    expect(result.notes.join("\n")).toContain("Their correspondence is represented by the subclass row");
  });

  it("emits deferred SQL FKs for a dependency cycle and quotes identifiers safely", () => {
    const result = mapping({ entities: { ORDER: entity("Order-Id"), MEMBER: entity("MemberId") }, relationships: {
      PLACES: { ends: [{ entity: "ORDER", card: "0..1" }, { entity: "MEMBER", card: "0..N" }] },
      PREFERS: { ends: [{ entity: "ORDER", card: "0..N" }, { entity: "MEMBER", card: "0..1" }] },
    } });
    const sql = mappingSql(result, "VARCHAR(100)");
    expect(sql).toContain('CREATE TABLE "ORDER"');
    expect(sql).toContain('"Order-Id" VARCHAR(100) NOT NULL');
    expect(sql).toContain("ALTER TABLE");
    expect(sql.lastIndexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    expect(() => mappingSql(result, "TEXT); DROP TABLE MEMBER; --")).toThrow();
  });

  it("remains deterministic when entity and relationship declarations are reordered", () => {
    const input: ModelInput = { version: 1, entities: { SHOP: entity("ShopId"), ITEM: entity("ItemId") }, relationships: {
      STOCKS: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "0..1" }] },
      SELLS: { ends: [{ entity: "SHOP", card: "0..N" }, { entity: "ITEM", card: "0..N" }] },
    } };
    const reverse = { ...input, entities: Object.fromEntries(Object.entries(input.entities).reverse()), relationships: Object.fromEntries(Object.entries(input.relationships!).reverse()) };
    expect(mapModel(normalize(reverse)).mapping).toEqual(mapModel(normalize(input)).mapping);
  });

  it.each(["campus", "ternary"])("snapshots Markdown and SQL for %s", async (name) => {
    const result = mapText(readFileSync(`bench/fixtures/${name}.er.yaml`, "utf8"));
    expect(result.mapping).toBeDefined();
    await expect(mappingMarkdown(result.mapping!)).toMatchFileSnapshot(`../docs/mapping/${name}.md`);
    await expect(mappingSql(result.mapping!)).toMatchFileSnapshot(`../docs/mapping/${name}.sql`);
  });
});
