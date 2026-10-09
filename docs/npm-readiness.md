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

## Before a release

Build, run the required typecheck/tests, regenerate documentation and review the final pack listing. `prepublishOnly` runs for publication; `npm pack` itself still needs an explicit build. Confirm the README images, model reference and examples ship after applying the allowlist. Test the actual tarball installation and `chen serve` on a clean environment before publication. The current built checkout was checked; a clean tarball installation remains a release task.
