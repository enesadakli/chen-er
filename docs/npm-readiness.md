# npm readiness

Checked on Node.js 24.21.0 / npm 11.19.0. No publication or login was performed. No dependency or package manifest changes were made.

## Dry-run result

`npm pack --dry-run` before building listed 9 files (339,023 bytes packed): license, README, package manifest, `bin/chen.js`, three font/license assets, JSON Schema and the repository skill. `dist` did not exist, so the executable's import of `dist/cli/index.js` would fail.

After `npm run build`, the dry run listed 99 files, 741,678 bytes packed / 1,658,849 bytes unpacked:

| Area | Files |
| --- | ---: |
| `dist` | 90 |
| `assets` | 3 |
| `bin` | 1 |
| `schema` | 1 |
| `skills` | 1 |
| README, license, package manifest | 3 |

`dist` includes compiled application/core/CLI/MCP JavaScript and declarations, plus five viewer files (HTML, CSS, JavaScript and two fonts). `dist/cli/index.js` is present. Documentation images, the model reference and example YAML files are currently excluded. README links to those files therefore need the allowlist changes below for a self-contained package. These byte counts describe this checkout after building, not a future release.

The sandbox could not write the default npm cache, so the successful command used a temporary cache:

```sh
npm pack --dry-run --json --cache /private/tmp/chen-er-lane-p-npm-cache
```

## Maintainer-owned package.json changes

Add these fields/script entries:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/enesadakli/chen-er.git"
  },
  "homepage": "https://github.com/enesadakli/chen-er#readme",
  "bugs": {"url": "https://github.com/enesadakli/chen-er/issues"},
  "engines": {"node": ">=24"},
  "scripts": {
    "gen:docs": "tsx scripts/gen-docs.ts",
    "prepublishOnly": "npm run build"
  }
}
```

Merge the scripts with the existing scripts rather than replacing them. Raising `engines.node` from `>=22` to `>=24` matches the documented and tested baseline; compatibility with Node 22 was not checked.

Keep the existing executable mapping:

```json
{"bin": {"chen": "./bin/chen.js"}}
```

The executable has a Node shebang, is executable in the pack listing and loads the built CLI. No bin change is needed.

Expand the existing `files` allowlist to:

```json
{
  "files": [
    "bin",
    "dist",
    "assets",
    "schema",
    "skills",
    "docs",
    "examples/*.er.yaml",
    "README.md",
    "LICENSE"
  ]
}
```

The example glob selects only top-level public YAML models. Keep the documentation generator as source-checkout tooling; it is not needed at runtime.

## Clean tarball install (2026-10-09)

Node.js 24.21.0 / npm 11.19.0. After `npm run build`, `npm pack` produced `chen-er-0.1.0.tgz`: 111 files, 1.1 MB packed (1,096,527 bytes), 2.1 MB unpacked. Nothing from `examples/private/`, `test/` or `src/` is in the tarball; shipped examples are the three top-level `examples/*.er.yaml`, plus `docs/` (images, model reference, lint example, this file), `assets`, `schema`, `skills`, `bin`, `dist`.

The tarball was installed with `npm install <tgz>` into a fresh directory outside the repository (`npm init -y` first, temporary npm cache). Results with `npx chen`:

| Check | Result |
| --- | --- |
| `--help`, `schema`, `rules` | pass |
| `init demo.er.yaml`, `lint demo.er.yaml` | pass (exit 0) |
| `render demo.er.yaml --png` | pass; SVG (3,477 bytes) and PNG (39,111 bytes) written |
| `render node_modules/chen-er/examples/library.er.yaml -o lib.svg` | pass (10,934 bytes) |
| `serve demo.er.yaml --port 5791` | pass; page `/` 200, `/api/state` 200 (JSON), `/api/export.svg` 200 |
| MCP over stdio (`initialize`, `tools/list`) | pass; tools `get_schema`, `lint_er`, `render_er` |

Findings: the README documented the MCP server only for a source checkout (`npx tsx src/mcp/server.ts`); the package had no installed entry point for it. `dist/mcp/server.js` starts only when it is the main module, so it cannot be used through a bin symlink. `bin/chen-mcp.js` was added; it calls `startServer()` directly and works from `node_modules/chen-er/bin/chen-mcp.js`. The README now documents install and MCP for the installed package. `bin/chen-mcp.js` was added after the tarball above was packed (the `bin` directory is in `files`, so it will ship); it was verified by copying it into the installed package, not through a bin entry.

Optional maintainer change (package.json), to expose the server as a command (`npx -p chen-er chen-er-mcp`):

```json
{"bin": {"chen": "./bin/chen.js", "chen-er-mcp": "./bin/chen-mcp.js"}}
```

Not tested: installation from the registry, Node 22, Windows, `chen serve --open`, browser-side viewer interaction (pin dragging, export buttons) and the MCP `lint_er`/`render_er` calls from the installed package.

## Before a release

Build, run the required typecheck/tests, regenerate documentation and review the final pack listing. `prepublishOnly` runs for publication; `npm pack` itself still needs an explicit build. Confirm the README images, model reference and examples ship after applying the allowlist. The clean tarball installation is recorded above; repeat it for the final release candidate.
