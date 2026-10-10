import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const html = readFileSync(join(siteDir, "index.html"), "utf8");
const optional = new Set(["assets/demo.gif"]);

type Ref = { tag: string; attr: string; value: string };

function references(source: string): Ref[] {
  const refs: Ref[] = [];
  for (const tag of source.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    for (const attr of tag[2]!.matchAll(/\s(src|href|data-demo)\s*=\s*"([^"]*)"/g)) {
      refs.push({ tag: tag[1]!.toLowerCase(), attr: attr[1]!, value: attr[2]! });
    }
  }
  return refs;
}

const isExternal = (value: string) => /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");

function resolveLocal(value: string): string {
  const path = decodeURIComponent(value.split("#")[0]!.split("?")[0]!);
  const target = normalize(join(siteDir, path === "" || path.endsWith("/") ? `${path}index.html` : path));
  const rel = relative(siteDir, target);
  expect(rel.startsWith(".."), `${value} leaves site/`).toBe(false);
  return target;
}

describe("demo site", () => {
  const refs = references(html);

  it("references the expected local files", () => {
    expect(refs.length).toBeGreaterThan(10);
    expect(refs.some((ref) => ref.value === "assets/demo.gif")).toBe(true);
  });

  it("resolves every relative src and href to a file under site/", () => {
    const missing: string[] = [];
    for (const ref of refs) {
      if (isExternal(ref.value) || ref.value.startsWith("#")) continue;
      expect(ref.value.startsWith("/"), `${ref.value} must be relative for a project sub-path`).toBe(false);
      const path = ref.value.split("#")[0]!.split("?")[0]!;
      if (optional.has(path)) continue;
      const target = resolveLocal(ref.value);
      if (!existsSync(target) || !statSync(target).isFile()) missing.push(`${ref.tag} ${ref.attr}="${ref.value}"`);
    }
    expect(missing).toEqual([]);
  });

  it("resolves in-page anchors", () => {
    for (const ref of refs.filter((item) => item.value.startsWith("#"))) {
      expect(html.includes(`id="${ref.value.slice(1)}"`), ref.value).toBe(true);
    }
  });

  it("resolves url() references in the stylesheet", () => {
    const css = readFileSync(join(siteDir, "style.css"), "utf8");
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const value = match[1]!;
      expect(isExternal(value), `${value} is external`).toBe(false);
      expect(existsSync(resolveLocal(value)), value).toBe(true);
    }
  });

  it("contains no http:// URLs", () => {
    expect(html).not.toMatch(/http:\/\//i);
  });

  it("loads scripts, styles, fonts and frames only from the site itself", () => {
    for (const tag of html.matchAll(/<(script|link|iframe|img|source|video|audio|embed|object)\b([^>]*)>/gi)) {
      for (const attr of tag[2]!.matchAll(/\s(src|href|srcset|data)\s*=\s*"([^"]*)"/g)) {
        expect(isExternal(attr[2]!), `<${tag[1]} ${attr[1]}="${attr[2]}">`).toBe(false);
      }
    }
    expect(html).not.toMatch(/@import|fonts\.googleapis|cdn\.|unpkg|jsdelivr/i);
  });
});
