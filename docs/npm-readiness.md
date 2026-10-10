# chen-er 0.4.0 package verification

Checked on 2026-10-10 with Node.js 24.21.0 and npm 11.19.0. The npm package
is `chen-erd`; the project, repository and MCP client key remain `chen-er`.
The manifest declares version 0.4.0 and three commands: `chen` and `chen-erd`
(both `bin/chen.js`), and `chen-er-mcp` (`bin/chen-mcp.js`).

The tarball builds and its contents pass the packaging checks. Release
verification is incomplete: the clean install was blocked by registry DNS,
and the CLI still prints 0.1.0. No publication, login, tag, dependency or
manifest change was performed in this lane.

## Pack listing

`npm run build` succeeded, then `npm pack --json --cache <temporary-cache>
--pack-destination <temporary-directory>` produced `chen-erd-0.4.0.tgz`.
The candidate has 166 files, approximately 1.21 MB packed / 2.52 MB unpacked
(decimal MB; documentation edits can change the exact byte counts).

| Area | Files | Contents |
| --- | ---: | --- |
| `dist` | 128 | Compiled CLI, MCP, application/core modules, declarations and viewer assets |
| `docs` | 25 | Reference, reports, mapping examples, release history and diagram images |
| `assets` | 3 | Bundled Inter fonts and license |
| `bin` | 2 | CLI and MCP launchers |
| `examples` | 3 | Top-level public `.er.yaml` models |
| `schema` | 1 | JSON Schema |
| `skills` | 1 | ER diagram workflow |
| Root | 3 | README, LICENSE and package.json |

The listing contains no `test/`, `bench/`, `src/`, `.github/`, results or
`*.er.agent.json`; private examples are absent. All three bin targets exist.
Both README image references resolve inside the extracted package:
`docs/company-project.png` and `docs/ternary.png`.

## Verification transcript

Temporary root: `/private/tmp/chen-erd-verify.7gCZ2h`.

| Command/check | Observed result |
| --- | --- |
| `npm run build` | Exit 0; TypeScript compilation and Vite viewer build succeeded |
| `npm pack --json --cache <tmp>/cache --pack-destination <tmp>` | Exit 0; `chen-erd-0.4.0.tgz`, 166 files |
| Fresh directory: `npm init -y` | Exit 0 |
| `npm install <tmp>/chen-erd-0.4.0.tgz --cache <tmp>/cache --fetch-retries=0 --fetch-timeout=15000 --no-audit --no-fund` | Exit 1; `ENOTFOUND registry.npmjs.org` fetching `@modelcontextprotocol/sdk` |
| Tarball exclusions and README images | Passed |
| `node bin/chen.js --version` in the built checkout | Exit 0, prints `0.1.0` |
| `npx tsc --noEmit` | Exit 0 |
| `npx vitest run` | Exit 0; 54 files passed, 801 tests passed, 3 skipped (804 total) |

The first sandboxed build and test attempts failed with `EPERM` writing Vite's
config cache under the shared `node_modules` symlink. Both succeeded when rerun
with the required cache access. Dependencies were not installed in this worktree.

Per the lane's network-block rule, installation testing stopped at step 3a.
The following checks were **not run from a fresh tarball install**:

- `npx chen --version` and `npx chen-erd --version` (expected 0.4.0).
- `npx chen render <copied example>` (expected SVG).
- `npx chen report <copied example>` (expected Markdown and sibling SVG).
- MCP stdio `initialize` and `tools/list`, including the exact command
  `npx -y -p chen-erd chen-er-mcp`.

The five expected MCP tools are `get_schema`, `lint_er`, `render_er`, `map_er`
and `report_er`. Their registrations are present in source; this does not
replace the pending installed-package handshake.

## Remaining release checks

The maintainer must replace the hard-coded `.version("0.1.0")` at
`src/cli/index.ts:9` with the package version (0.4.0), rebuild and repeat both
installed aliases. The compiled `dist/cli/index.js` contains the same stale
literal. This lane owns documentation only, so it did not change source.
`chen init` starter comments in `src/app/render.ts` contain no install hints
and need no package-name change. No schema or geometry contract change is needed.

On a machine with registry access (or a populated dependency cache), repeat the
build/pack and clean install with a temporary npm cache, then run inside that
fresh installation:

```sh
npx chen --version
npx chen-erd --version
cp node_modules/chen-erd/examples/ternary.er.yaml model.er.yaml
npx chen render model.er.yaml
npx chen report model.er.yaml
```

Verify the written SVG and report Markdown. To test the documented MCP command
against that local tarball installation, save this as `verify-mcp.mjs` in the
same temporary project and run `node verify-mcp.mjs`. The SDK client sends
`initialize` during `connect`; `listTools` sends `tools/list`.

```js
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "package-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "-p", "chen-erd", "chen-er-mcp"],
});
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ["get_schema", "lint_er", "map_er", "render_er", "report_er"]);
  console.log("initialize: OK; tools/list:", names.join(", "));
} finally {
  await client.close();
}
```

Set `npm_config_cache` to the same temporary cache if needed. Confirm this
runs against the installed `chen-erd@0.4.0`, then review the final pack listing.
Registry installation, other operating systems and interactive viewer behavior
remain outside this recorded verification.
