<!--
Thanks for contributing. CONTRIBUTING.md has the full detail; this is the short form.
-->

## What changes, and why

<!-- The problem first. A diff shows what moved, not what was wrong. -->

## How you verified it

<!--
Say what you actually ran, not what should pass. If a claim here is a projection
rather than a measurement, please label it as one — an earlier release shipped a
token estimate that was wrong because it was never measured.
-->

- [ ] `npm test` passes
- [ ] `node scripts/manifest.mjs --check` passes (run `node scripts/manifest.mjs` after changing tracked files)
- [ ] `node demo.mjs` still runs, if routing or verdict logic changed

## Checklist

- [ ] New behaviour has tests, including the refusal path where one exists
- [ ] Records written by earlier versions still load, or the change is documented in `CHANGELOG.md`
- [ ] Docs updated if the tool surface or an argument changed
- [ ] No claim of capability, safety, or cost that the code does not enforce
