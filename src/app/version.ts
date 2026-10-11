import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/app and dist/app both sit two levels below the package root.
export const packageVersion: string =
  (JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }).version;
