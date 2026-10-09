import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(mode === "test" ? "./" : "./src/viewer", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/viewer", import.meta.url)),
    emptyOutDir: true,
  },
}));
