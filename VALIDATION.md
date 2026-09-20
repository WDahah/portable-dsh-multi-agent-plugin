# Portable package validation

## Package identity and scope

- Package version: **1.0.0**.
- Build identifier: **portable-multi-agent-1**.
- Origin: portable core derived from the current native multi-agent system, with **seven core modules** and a host-injected factory integration.
- Source, scripts, tests and existing documentation were frozen before this validation record and the integrity manifest were added.
- Minimum required Node.js version: **22**. This requirement is not a claim that Node.js 22 or Linux was tested.

## Validation evidence

The coordinating parent reported the following final results for the frozen portable source:

- `npm test`: **61 passed, 0 failed, 0 skipped**, duration **4494 ms**.
- An isolated Cordis environment with the actual Tools registry successfully mounted the factory integration, registered **nine tools**, and disposed it successfully.
- A moved copy in a path containing spaces passed `prepareSetup` and `doctor` checks using the actual host module, **without applying** a host configuration change.
- Two independent read-only reviews passed after the latest control-path fix.

Source-runtime versions recorded for those checks:

| Component | Version or range |
| --- | --- |
| Node.js tested | `26.8.2` |
| DSH Tools tested | `0.1.5-rc.2` |
| Cordis peer requirement | `^4.0.2` |

The Cordis peer range is a dependency compatibility requirement, not a claim that every version in that range was tested. This final packaging step does not rerun the already completed test suite; it runs `node scripts/verify.mjs` after writing the manifest. The coordinating agent's final handoff records that command's outcome.

## Transfer boundaries

This portable validation did **not** make model/network calls, transfer accounts, or change the current host profile. Earlier paid operational tests belonged to the source system; they were **not repeated for this portable build** and do not establish destination-machine qualification.

No `.local`, `node_modules`, state, credentials or test-fixture directories were present in the final package enumeration. The coordinating parent's scan for original-machine information and original-repository dependencies found none. Only portable package-relative paths are recorded in the manifest.

The destination must provide its own compatible host dependencies, owner-scoped state and credentials. Source-machine accounts, sessions, entitlements and qualification records are not transferable evidence. Perform fresh route/effort qualification on the destination; qualification evidence has a **24-hour lifetime**. Provider availability, billing, operating-system compatibility and model capabilities must be assessed there.

## Integrity and limits

`portable-manifest.json` uses schema version 1 and lists every regular package file recursively, including this document, with its POSIX-relative path and lowercase SHA-256 hash. Only the manifest itself is excluded from its own file list. The count is taken from the actual enumeration, not an assumed package size.

SHA-256 hashes detect changes relative to this manifest; they do **not** authenticate the publisher or protect against coordinated replacement of files and manifest. A successful manifest verification must not be treated as proof that no unlisted files exist. The verifier's coverage is the files it checks against the recorded manifest; review the destination directory separately for unexpected files.

This document makes no new licensing grant, open-source license claim, cross-platform certification, or guarantee that the destination can dispatch a particular model. Follow the included setup and usage documentation, and keep secrets and generated machine-local state outside the transferable package.
