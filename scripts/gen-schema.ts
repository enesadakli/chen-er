/** Writes schema/er.schema.json from the zod model. Run: npm run gen:schema */
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Model } from "../src/core/schema.js";

const schema = z.toJSONSchema(Model, { target: "draft-2020-12", io: "input" });
mkdirSync("schema", { recursive: true });
writeFileSync(
  "schema/er.schema.json",
  JSON.stringify({ $id: "https://github.com/enesadakli/chen-er/schema/er.schema.json", title: "chen-er model", ...schema }, null, 2) + "\n",
);
console.log("schema/er.schema.json");
