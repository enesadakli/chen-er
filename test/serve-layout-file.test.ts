import { chmodSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutPathFor, STARTER_MODEL } from "../src/app/render.js";
import { serve, type ViewerState } from "../src/app/serve.js";

let dir: string, model: string, viewer: Awaited<ReturnType<typeof serve>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chen-serve-lf-"));
  model = join(dir, "sample.er.yaml");
  writeFileSync(model, STARTER_MODEL);
  viewer = await serve(model, { port: 0 });
}, 20000);
afterEach(async () => {
  await viewer?.close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("serve layout-file diagnostic", () => {
  it("reports a failed position save as a warning", async () => {
    unlinkSync(layoutPathFor(model));
    chmodSync(dir, 0o500);
    const later = new Date(Date.now() + 5000);
    utimesSync(model, later, later);
    let found: ViewerState["diagnostics"][number] | undefined;
    for (let i = 0; i < 100 && !found; i++) {
      const state = await (await fetch(`${viewer.url}/api/state`)).json() as ViewerState;
      found = state.diagnostics.find((d) => d.rule === "layout-file");
      if (!found) await new Promise((done) => setTimeout(done, 20));
    }
    expect(found).toBeDefined();
    expect(found!.severity).toBe("warning");
    expect(found!.message).toContain("Positions not saved");
  });
});
