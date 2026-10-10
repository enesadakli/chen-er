import type { MappingForeignKey, MappingRelation, MappingResult } from "./types.js";

export type MappingFormat = "text" | "md" | "sql" | "json";

/** Stable dependency order; cycles are completed with ALTER TABLE in SQL. */
export function dependencyOrder(relations: readonly MappingRelation[]): MappingRelation[] {
  const remaining = [...relations];
  const ordered: MappingRelation[] = [];
  const done = new Set<string>();
  while (remaining.length) {
    const ready = remaining.findIndex((r) => r.foreignKeys.every((fk) => fk.references.relation === r.name || done.has(fk.references.relation)));
    const [next] = remaining.splice(ready < 0 ? 0 : ready, 1);
    ordered.push(next!);
    done.add(next!.name);
  }
  return ordered;
}

const escapeMd = (s: string) => s.replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
function readable(result: MappingResult, md: boolean): string {
  const escape = md ? escapeMd : (s: string) => s;
  const blocks = result.relations.map((r) => {
    const orderedColumns = [...r.primaryKey.map((name) => r.columns.find((c) => c.name === name)!), ...r.columns.filter((c) => !r.primaryKey.includes(c.name))];
    const columns = orderedColumns.map((c) => r.primaryKey.includes(c.name)
      ? md ? `<u>${escape(c.name)}</u>` : `${c.name} [PK]`
      : escape(c.name));
    return [
      `${escape(r.name)}(${columns.join(", ")})`,
      ...r.foreignKeys.map((fk) => `${fk.columns.map(escape).join(", ")} → ${escape(fk.references.relation)}(${fk.references.columns.map(escape).join(", ")})${fk.columns.every((n) => r.columns.find((c) => c.name === n)?.notNull) ? " [NOT NULL]" : ""}`),
      ...r.uniqueKeys.map((key) => `UNIQUE(${key.map(escape).join(", ")})`),
      ...r.steps.map((step) => `Step ${step.step}: ${escape(step.reason)}`),
    ].join(md ? "  \n" : "\n");
  });
  if (result.notes.length) blocks.push(`Notes:\n\n${result.notes.map((n) => `- ${escape(n)}`).join("\n")}`);
  return blocks.join("\n\n") + "\n";
}
export const mappingMarkdown = (result: MappingResult) => readable(result, true);
export const mappingText = (result: MappingResult) => readable(result, false);

// Common SQL keywords, including names used by popular dialects. Quoting preserves unusual names.
const reserved = new Set(("ALL ALTER AND AS ASC AUTHORIZATION BEGIN BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS FALSE FETCH FOR FOREIGN FROM FULL GROUP HAVING IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIMIT MATCH NATURAL NOT NULL OFFSET ON ONLY OR ORDER OUTER PRIMARY REFERENCES RIGHT ROW SELECT TABLE THEN TRUE UNION UNIQUE UPDATE USER USING VALUES VIEW WHEN WHERE WITH").split(" "));
export const quoteIdentifier = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reserved.has(name.toUpperCase())
  ? name : `"${name.replace(/"/g, '""')}"`;
const names = (columns: string[]) => columns.map(quoteIdentifier).join(", ");
const fkSql = (fk: MappingForeignKey) => `FOREIGN KEY (${names(fk.columns)}) REFERENCES ${quoteIdentifier(fk.references.relation)} (${names(fk.references.columns)})`;
const comment = (s: string) => s.replace(/[\r\n]+/g, " ");

export function mappingSql(result: MappingResult, defaultType = "TEXT"): string {
  // A type declaration, never an arbitrary SQL fragment. Allow e.g. VARCHAR(100), DECIMAL(10,2).
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(?:\[\])?$/.test(defaultType) || /\b(?:NOT|NULL|DEFAULT|REFERENCES|CHECK|PRIMARY|UNIQUE|CONSTRAINT)\b/i.test(defaultType)) {
    throw new Error("Default type must be a SQL type name with optional size/precision; SQL clauses are not allowed.");
  }
  const created = new Set<string>();
  const deferred: string[] = [];
  const blocks = ["-- Types are placeholders: the ER model declares no data types. Review before execution."];
  for (const relation of dependencyOrder(result.relations)) {
    created.add(relation.name);
    const inline = relation.foreignKeys.filter((fk) => {
      if (created.has(fk.references.relation)) return true;
      deferred.push(`ALTER TABLE ${quoteIdentifier(relation.name)} ADD ${fkSql(fk)};`);
      return false;
    });
    blocks.push([
      ...relation.steps.map((s) => `-- Step ${s.step}: ${comment(s.reason)}`),
      `CREATE TABLE ${quoteIdentifier(relation.name)} (`,
      [
        ...relation.columns.map((c) => `${quoteIdentifier(c.name)} ${defaultType}${c.notNull ? " NOT NULL" : ""}`),
        `PRIMARY KEY (${names(relation.primaryKey)})`,
        ...relation.uniqueKeys.map((key) => `UNIQUE (${names(key)})`),
        ...inline.map(fkSql),
      ].map((s) => `  ${s}`).join(",\n"),
      ");",
    ].join("\n"));
  }
  if (deferred.length) blocks.push("-- Cyclic dependencies: add these foreign keys after all tables exist. Requires ALTER TABLE ADD FOREIGN KEY support.\n" + deferred.join("\n"));
  if (result.notes.length) blocks.push(result.notes.map((n) => `-- Note: ${comment(n)}`).join("\n"));
  return blocks.join("\n\n") + "\n";
}
export function formatMapping(result: MappingResult, format: MappingFormat = "text", defaultType?: string): string {
  switch (format) {
    case "text": return mappingText(result);
    case "md": return mappingMarkdown(result);
    case "sql": return mappingSql(result, defaultType);
    case "json": return JSON.stringify(result, null, 2) + "\n";
    default: throw new Error("Format must be text, md, sql or json.");
  }
}
