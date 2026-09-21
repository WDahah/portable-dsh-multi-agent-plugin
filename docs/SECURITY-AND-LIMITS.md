# Security and limits

Read this before installing into a host, authenticating providers or allowing project writes.

## Permissions and installation

- This is a native DSH/Cordis plugin. It connects to real host services and is not a security boundary against malicious code.
- Keep normal host permissions, sandbox restrictions, approvals and provider terms. **No budget approval workflow** does not mean permission to bypass those controls.
- Identify the active **user-owned host patch**, back it up, then merge the generated insertion. Never overwrite unrelated configuration, edit shipped presets or blindly remove a colliding plugin. Identify the exact old row and rollback mapping before disabling it under user authority.
- Setup writes only `.local/entry.mjs` and `.local/host-patch.yml`; it does not activate a profile. Doctor and `npm test` are offline and do not prove live provider access.
- After copying, `node scripts/verify.mjs` checks listed file hashes against `portable-manifest.json`. It detects missing/modified listed files, not unlisted extra files. This is not a signature or proof of authenticity; trust the source of both code and manifest.
- No credentials, authenticated accounts or previous qualification state are bundled. Authenticate through the approved host UI/official flow. Do not put API keys in chat, copy clipboard secrets, or transfer another machine's account/state directories.

## Project scope and agent tools

Start with explicit read paths and `allowed_tools:["read","glob","grep"]`. For implementation, name writable files and acceptance tests; add `write`/`edit` only with authority. Add `pwsh` only when needed and permitted. Tool availability is not authority to alter unrelated files, run arbitrary commands, delete data, or access a network.

The native dispatcher uses an absolute `maxDepth:1` and expects a root caller. Read-only unfinished work may continue in a new child. A tool set that can change files or run commands does not automatically continue because completed side effects may be repeated. Same-child memory, autonomous nested delegation, and durable native-assignment resume are not promised.

## Qualification scope

Live evidence is exact to provider/model/effort and **owner/root agent session**, with a **24-hour expiry**. Qualify in the same session that dispatches the project. New projects/sessions or changed mappings need fresh evidence; old-machine successes are not transferable. Registration alone does not prove entitlement, availability, tool support or reliability.

A failed probe stays unavailable; do not forge qualification JSON, promote synthetic fixtures, silently alias another model, or uninstall a provider to hide a failure. Automatic requalification is not claimed. Basic smoke verifies limited text/tool behavior, not broad competence, confidentiality or an immutable backend identity.

The `vision` role needs a passed image probe; the `domain` role needs domain evidence; confidential/restricted data needs an operator attestation. Each is requested through `orchestrator_qualify` (see [USAGE.md](USAGE.md)), and none is granted by basic smoke alone.

An attestation records a named human claim and its written basis, and widens routing policy only. It is **not** a capability proof, an entitlement check, a compliance control, or a privacy certification, and this plugin cannot verify that its author was authorized to make it. A stored record whose policy exceeds ordinary smoke without an attestation is refused as tampered. Confidential and restricted data still require whatever controls your environment actually demands; recording an attestation does not create them.

Capability probes consume real quota like any other probe. An image probe writes its generated PNGs through the host attachment service, so those bytes follow that service's ordinary retention.

## Persistence and recovery

Original prompts and visible outputs are **plaintext** in the state directory. Restrict filesystem access, minimize sensitive content and choose a fresh absolute private directory. Do not copy task/qualification state to manufacture readiness elsewhere. Checksums detect corruption, not a malicious writer who controls the directory.

Nothing prunes stored records automatically: assignments, direct tasks, and qualification evidence persist until you remove them, including evidence that has already expired. Use `orchestrator_list` to see what is held and `orchestrator_forget` to delete it. Deletion is permanent, refuses a record that is currently in flight, and is the only way to clear plaintext prompts and outputs from a state directory that keeps growing.

State directories and files are created with POSIX modes `0700`/`0600`. **Windows ignores those modes**, so the state directory inherits the parent folder's ACL instead. On Windows, place it outside shared or synchronized locations and restrict it explicitly, for example:

```powershell
icacls "<state directory>" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
```

The implementation assumes one trusted coordinator. Exclusive revisions and file synchronization do not provide distributed transactions, guaranteed remote exactly-once delivery, or power-loss durability. An abrupt interruption can lose an uncheckpointed text tail. Redacted diagnostics are in memory only; unavailable diagnostics are not proof of a provider cause.

Uncertain transport/usage states, cancelled requests and recovered in-flight attempts are **not blindly replayed**. A task ID cannot be reset to avoid this rule. Safe settled direct continuation is different from retrying an unknown attempt. Partial output cannot recover text the provider never returned.

## Budgets and technical bounds

**$1 is a soft estimated target, not a spending ceiling.** Authorized requests can finish over target without a per-call financial approval. Usage may consume paid or subscription quota; no universal hard invoice cap is enforced.

Historical API rate estimates are not current invoices. Subscription/native-agent costs may be unknown; zero known-cost subtotal with `costUnknown:true` does not mean free execution. Reasoning counts must not be charged twice. Provider middleware may perform authentication refresh or internal retries, so one engine attempt is not universally one HTTP request.

Direct tasks have a 15-minute wall-clock deadline beginning at **plan time**, default3/max8 rounds, bounded context/output and requested output-token limits. Native tasks also have bounded rounds/time/context. Adapter behavior can differ; do not equate a requested token limit with proven upstream enforcement. Cancellation is cooperative and cannot prove billing stopped.

Concurrency is deliberately small. Per owner session, **at most 2 qualifications and 2 native delegation/compaction assignments run at once** (`QUALIFICATION_BUSY`, `DELEGATION_BUSY`). Batch workers share those native slots and may wait in an internal FIFO queue of at most 8 pending reservations (`DELEGATION_QUEUE_FULL`); ordinary delegation and compaction still refuse rather than queue. One batch per owner accepts 2–8 independent read-only tasks. Slots remain owned until child result and disposal settle, even after cancellation. This is not a host-wide/provider-wide rate limit: qualification and direct execution do not share the native admission pool.

Direct tasks still enforce one run per task ID (`CONCURRENT_TASK`), with at most 64 owner sessions and 64 loaded tasks (`OWNER_CAPACITY`, `TASK_CAPACITY`), not a shared direct-call semaphore. Batch limits bound task fan-out, not model calls inside each child or total tokens. Batch output is collected worker data, not a policy-approved merge. Writes, dependency scheduling and automatic recovery/replay are outside the batch interface. Scope strings cannot narrow the filesystem sandbox; the host tool allowlist enforces read-only tools, while path selection remains a task instruction.

## Output acceptance

A completed model turn is not proof that an answer or code is correct. Review generated changes and run project-specific checks under normal permissions. Raw concatenation of continuation rounds can omit a newline or other separator; inspect round boundaries when exact formatting matters. Adding a separator is not a universal repair for truncated words or structured data.

This package does not create a new license grant or claim an open-source license not supplied elsewhere. Consult the actual package/host/provider licensing information. Report offline tests, generated candidate files, runtime activation, live qualification and real task results separately—never collapse them into an unsupported “fully ready everywhere” claim.
