import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModel } from "../src/core/normalize.js";

describe("viewer-focus fixtures", () => {
  it("normalizes binary relationship fixture with explicit end ids and unrelated entity", () => {
    const yaml = readFileSync(new URL("./fixtures/viewer-focus/binary.er.yaml", import.meta.url), "utf8");
    const { model, diagnostics } = parseModel(yaml);

    expect(diagnostics).toEqual([]);
    expect(model).toBeDefined();

    expect(model!.entities.map((e) => e.id)).toEqual(["E:MEMBER", "E:CLUB", "E:ARCHIVE"]);
    expect(model!.relationships.map((r) => r.id)).toEqual(["R:JOINS"]);

    const joins = model!.relationships[0]!;
    expect(joins.ends).toHaveLength(2);
    expect(joins.ends[0]).toMatchObject({
      id: "JOINS#member",
      entity: "MEMBER",
      role: undefined,
      min: 0,
      max: "N",
    });
    expect(joins.ends[1]).toMatchObject({
      id: "JOINS#club",
      entity: "CLUB",
      role: undefined,
      min: 1,
      max: "N",
    });

    expect(joins.attrs).toHaveLength(1);
    expect(joins.attrs[0]!.id).toBe("A:JOINS.Since");

    const archive = model!.entities.find((e) => e.id === "E:ARCHIVE");
    expect(archive).toBeDefined();
    expect(archive?.name).toBe("ARCHIVE");
  });

  it("normalizes recursive relationship fixture with roles, explicit end ids and unrelated entity", () => {
    const yaml = readFileSync(new URL("./fixtures/viewer-focus/recursive.er.yaml", import.meta.url), "utf8");
    const { model, diagnostics } = parseModel(yaml);

    expect(diagnostics).toEqual([]);
    expect(model).toBeDefined();

    expect(model!.entities.map((e) => e.id)).toEqual(["E:EMPLOYEE", "E:ROOM"]);
    expect(model!.relationships.map((r) => r.id)).toEqual(["R:SUPERVISION"]);

    const supervision = model!.relationships[0]!;
    expect(supervision.ends).toHaveLength(2);
    expect(supervision.ends[0]).toMatchObject({
      id: "SUPERVISION#supervisor",
      entity: "EMPLOYEE",
      role: "supervisor",
      min: 0,
      max: "N",
    });
    expect(supervision.ends[1]).toMatchObject({
      id: "SUPERVISION#report",
      entity: "EMPLOYEE",
      role: "report",
      min: 0,
      max: 1,
    });

    expect(supervision.attrs).toHaveLength(1);
    expect(supervision.attrs[0]!.id).toBe("A:SUPERVISION.Since");

    const room = model!.entities.find((e) => e.id === "E:ROOM");
    expect(room).toBeDefined();
    expect(room?.name).toBe("ROOM");
  });

  it("normalizes ternary relationship fixture with explicit end ids and unrelated entity", () => {
    const yaml = readFileSync(new URL("./fixtures/viewer-focus/ternary.er.yaml", import.meta.url), "utf8");
    const { model, diagnostics } = parseModel(yaml);

    expect(diagnostics).toEqual([]);
    expect(model).toBeDefined();

    expect(model!.entities.map((e) => e.id)).toEqual(["E:HOST", "E:TOPIC", "E:ROOM", "E:SUPPLIER"]);
    expect(model!.relationships.map((r) => r.id)).toEqual(["R:BOOKS"]);

    const books = model!.relationships[0]!;
    expect(books.ends).toHaveLength(3);
    expect(books.ends[0]).toMatchObject({
      id: "BOOKS#host",
      entity: "HOST",
      role: undefined,
      min: 0,
      max: "N",
    });
    expect(books.ends[1]).toMatchObject({
      id: "BOOKS#topic",
      entity: "TOPIC",
      role: undefined,
      min: 0,
      max: "N",
    });
    expect(books.ends[2]).toMatchObject({
      id: "BOOKS#room",
      entity: "ROOM",
      role: undefined,
      min: 0,
      max: "N",
    });

    expect(books.attrs).toHaveLength(1);
    expect(books.attrs[0]!.id).toBe("A:BOOKS.StartsAt");

    const supplier = model!.entities.find((e) => e.id === "E:SUPPLIER");
    expect(supplier).toBeDefined();
    expect(supplier?.name).toBe("SUPPLIER");
  });
});
