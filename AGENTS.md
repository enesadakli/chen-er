# Working on chen-er

## Layout of the code
- `src/core/` is browser-safe (no `node:` imports, no I/O). `src/app/` holds the only file-system code;
  `src/cli/` and `src/mcp/` call `src/app/` services and never duplicate logic.
- Pipeline: `parseModel` (normalize.ts) → `lint` → `layout` → `renderSvg` → (`svgToPng` in app).
- `src/core/schema.ts` is the structural contract. `src/core/geometry.ts` is the geometry contract:
  units px, origin top-left, y down, boxes are top-left based, edges end on shape outlines (`anchor`).
- Node ids: `E:<Entity>`, `R:<Relationship>`, `A:<Owner>.<attr>[.<part>]`; end ids `<Rel>#<end id|index>`.
  Pins (`*.er.layout.json`) and diagnostics refer to these ids.
- Shape sizes and fonts come from `src/core/style.ts` + `src/core/text/metrics.ts` (bundled Inter).
  The renderer never computes positions; layout output is final geometry.

## Ownership
`package.json`, the lockfile, `src/core/schema.ts`, `src/core/geometry.ts` and `src/core/normalize.ts`
are owned by the maintainer. If you need a change there, describe it in your report instead of editing.

## Checks
`npm test` (vitest), `npx tsc --noEmit`, `npm run bench` (layout quality, once available).

## Commits
Plain imperative English subject, e.g. `add lint rules for weak entities`.
Never mention any AI assistant, agent or model in commit messages, PR text or code comments
(no Co-Authored-By trailers, no "generated with" lines).
