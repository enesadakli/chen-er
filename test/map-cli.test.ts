import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mapCommand } from "../src/cli/commands.js";
import { mapText } from "../src/app/map.js";
import { mappingSql } from "../src/core/map/index.js";
import { exampleModel } from "../src/mcp/tools.js";

let dir: string, path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-map-"));
  path = join(dir, "library.er.yaml");
  writeFileSync(path, exampleModel);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("CLI command supports every format, explicit output and placeholder types", async () => {
  for (const format of ["text", "md", "sql", "json"] as const) {
    const out = join(dir, `mapping.${format}`);
    const result = await mapCommand(path, { format });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const written = await mapCommand(path, { format, out, defaultType: "VARCHAR(40)" });
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toBe(out);
    const contents = readFileSync(out, "utf8");
    if (format === "json") expect(JSON.parse(contents).relations).toHaveLength(2);
    else if (format === "sql") expect(contents).toContain("VARCHAR(40)");
    else expect(contents).toContain("Step 2:");
    if (format === "text") expect(contents).toContain("[PK]");
    if (format === "md") expect(contents).toContain("<u>");
  }
});

it("CLI refuses lint errors without writing output and returns model error exit code", async () => {
  writeFileSync(path, exampleModel.replace("entity: BOOK", "entity: MISSING"));
  const out = join(dir, "keep.sql");
  writeFileSync(out, "keep");
  const result = await mapCommand(path, { format: "sql", out });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("[unknown-entity]");
  expect(readFileSync(out, "utf8")).toBe("keep");
  const json = await mapCommand(path, { format: "json" });
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stdout).diagnostics[0].severity).toBe("error");
  expect((await mapCommand(join(dir, "missing"))).exitCode).toBe(2);
});

it("CLI rejects invalid types and overwriting the input model", async () => {
  expect((await mapCommand(path, { format: "sql", defaultType: "TEXT; DROP TABLE BOOK" })).exitCode).toBe(2);
  expect((await mapCommand(path, { out: path })).exitCode).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(exampleModel);
});

it("registers chen map with actual flags and preserves process exit codes", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "map", path, ...args], { encoding: "utf8" });
  for (const format of ["text", "md", "sql", "json"]) {
    const result = run(["--format", format]);
    expect(result.status, result.stderr).toBe(0);
    if (format === "json") expect(JSON.parse(result.stdout).relations).toHaveLength(2);
    if (format === "sql") expect(result.stdout).toContain("CREATE TABLE");
  }
  expect(run(["--format", "wrong"]).status).toBe(2);
  const out = join(dir, "actual.sql");
  expect(run(["--format", "sql", "--default-type", "INTEGER", "--out", out]).status).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("INTEGER NOT NULL");
  writeFileSync(path, exampleModel.replace("entity: BOOK", "entity: MISSING"));
  expect(run([]).status).toBe(1);
});

it.each(["campus", "ternary"])("generated %s SQL executes with real FK/PK constraints", (name) => {
  const mapping = mapText(readFileSync(`bench/fixtures/${name}.er.yaml`, "utf8")).mapping!;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(mappingSql(mapping));
    const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()!;
    expect(count.n).toBe(mapping.relations.length);
    if (name === "campus") {
      db.exec("INSERT INTO HOSPITAL (HospitalId) VALUES ('h');");
      expect(() => db.exec("INSERT INTO WARD (WardCode) VALUES ('w');")).toThrow(/NOT NULL/);
      expect(() => db.exec("INSERT INTO WARD (WardCode, HOSPITAL_HospitalId) VALUES ('w','missing');")).toThrow(/FOREIGN KEY/);
      db.exec("INSERT INTO WARD (WardCode, HOSPITAL_HospitalId) VALUES ('w','h');");
      expect(() => db.exec("INSERT INTO WARD (WardCode, HOSPITAL_HospitalId) VALUES ('w','h');")).toThrow(/UNIQUE/);
    }
  } finally { db.close(); }
});

it("optional 1:1 SQL allows absent links but rejects duplicate present links", () => {
  const mapping = mapText(`version: 1
entities:
  CLINIC: {attrs: [ClinicId], keys: [[ClinicId]]}
  PERMIT: {attrs: [PermitId], keys: [[PermitId]]}
relationships:
  LICENSED_BY:
    ends: [{entity: CLINIC, card: 0..1}, {entity: PERMIT, card: 0..1}]
`).mapping!;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(mappingSql(mapping));
    db.exec("INSERT INTO CLINIC (ClinicId) VALUES ('c1'), ('c2');");
    db.exec("INSERT INTO PERMIT (PermitId) VALUES ('p');");
    db.exec("UPDATE CLINIC SET PERMIT_PermitId = 'p' WHERE ClinicId = 'c1';");
    expect(() => db.exec("UPDATE CLINIC SET PERMIT_PermitId = 'p' WHERE ClinicId = 'c2';")).toThrow(/UNIQUE/);
  } finally { db.close(); }
});
