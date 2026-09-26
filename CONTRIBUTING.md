# Contributing

Thank you for helping improve the portable DSH multi-agent plugin.

## Before you start

Read [START-HERE.md](START-HERE.md) and [Security and limits](docs/SECURITY-AND-LIMITS.md). This project is a native plugin for a compatible DeepSeek Harness/Cordis host, not a standalone agent runtime.

## Development checks

Use Node.js 22 or newer. From the repository root, run:

```sh
node scripts/manifest.mjs --check
node scripts/verify.mjs
npm test
```

**When you add, remove, or change any packaged file, regenerate the integrity manifest** with `node scripts/manifest.mjs`, then review the diff and re-run `verify`. CI runs `--check` on Linux, Windows, and macOS, so a stale manifest fails the build. Regenerating is the supported way to update the manifest for a reviewed change; it is not a way to paper over an unexpected one.

Never disable the line-ending rules in `.gitattributes`. The manifest hashes exact bytes, so a checkout that translates line endings makes verification fail for everyone on that platform.

Do not commit `.local/`, `node_modules/`, state directories, credentials, provider settings, or generated machine-local files.

## Bilingual documentation

The reader-facing documents ship as bilingual pairs: the English file stays canonical and its
Chinese counterpart sits beside it — `README.md` / `README.zh.md`, `docs/USAGE.md` /
`docs/USAGE.zh.md`, and the same for `START-HERE`, `INSTALL-WITH-AI` and
`docs/SECURITY-AND-LIMITS.md`. Both languages carry equal authority, so editing one side is only
half a change until the other follows.

Each pair records the git blob hash of both sides in `<document>.i18n.yaml`. Re-record after
editing either side:

```sh
node scripts/i18n.mjs          # re-record every pair
node scripts/i18n.mjs --check  # what CI runs; fails on a missing, incomplete or stale pair
```

`npm test` enforces the rest of the contract: a pair ships both sides, each links to its
counterpart near the heading, a Chinese document links to the Chinese side of every pair it
references, command blocks are identical, and `orchestrator_*` tool names are never renamed.

Translate prose. Identifiers stay English on both sides, because they are machine contracts: tool
names, error codes, JSON field names, config keys, file paths, model and provider ids, package
names and URLs. That includes everything inside a command block — a translated shell command is
broken instruction, not a translation. A `text` block is the opposite case: it is a prompt or a
sample meant to be read, so its prose is translated and only its placeholders and commands stay
verbatim.

## Pull requests

Keep changes focused. Update the relevant documentation and examples when behavior or setup changes. Explain the user-visible result, compatibility impact, security implications, and checks you ran. Do not claim live provider qualification from offline tests.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
