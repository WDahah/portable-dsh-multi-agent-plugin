# Native read-only token benchmark

## Result

**Two-worker execution did not save tokens in this experiment.** Parallel workers plus integration consumed **92.2% more total tokens than a single agent**, or **44.2% more tokens per accepted result** under the stated output requirements. Parallel was **23.5% faster than sequential workers** on average, but **62.5% slower than a single agent**.

This is a small, descriptive experiment on three code-inspection workloads, not a general prediction for multi-agent work or a before/after comparison of plugin versions.

| Approach | Trials | Accepted | Total tokens | Mean tokens/trial | Tokens/accepted¹ | Mean seconds/trial |
|---|---:|---:|---:|---:|---:|---:|
| Single | 9 | 6 | 159,564 | 17,729 | 26,594 | 18.0 |
| Sequential + integration | 9 | 9 | 309,635 | 34,404 | 34,404 | 38.2 |
| Parallel + integration | 9 | 8 | 306,683 | 34,076 | 38,335 | 29.2 |

¹ All consumed tokens, including unsuccessful answers, divided by accepted results. Failed answers were not retried, replaced or excluded. This metric is not an automatic-retry simulation.

[Download the 27 per-trial measurements](benchmarks/native-readonly-trials.csv). The published CSV contains aggregate measurements and acceptance flags, not session identities, account information, machine paths or private logs. Elapsed time is rounded to milliseconds; summary values were computed from the original unrounded values.

## Snapshot and execution

- Actual working-tree `createAgentDispatcher`, `createBatchRunner`, selector and findings parser from the **pre-review-fix v1.14.0 snapshot**, over base commit `7f00ba0`.
- That snapshot's manifest SHA256 was `128cd2ebce4859e0cfdae7a5a0ac24d01f7374975e7fdf5bfe7f03017bf80417`. It was not a standalone committed release. Subsequent review fixes changed failure reporting and documentation; the live experiment was **not rerun** on those fixes.
- Windows, Node.js 26.9.0, native DSH spawn backend through a temporary authenticated local measurement bridge. The installed orchestrator was not upgraded for the measurement.
- Every child used **Codex `gpt-5.6-luna`, medium effort**, one delegated round and requested maximum 8,192 output tokens per model call. This is a moving model alias, not a pinned backend version or financial cap.
- Read-only tool allowlist: `read`, `glob`, `grep`. Native structured-output finalization was also observed and counted. No write/command/network tools were exposed to workers.

### Comparison conditions

1. **Single:** one child reads both named files and answers all four questions.
2. **Sequential:** two children inspect one file each, using the batch worker prompts/schema through the actual dispatcher; a third child integrates their findings.
3. **Parallel:** the actual batch runner runs those two workers concurrently; a third child performs the same integration.

The two multi-agent conditions have identical worker prompts, model, effort and scopes. All 18 paired worker prompts were compared against their saved assignments and matched exactly. Integrators were instructed not to reread source, and their observed tools were limited to structured-output finalization.

Decomposition was supplied as deterministic input; there was no planning model. The batch API itself only collects findings. The experiment deliberately added and counted an integration call for comparable final answers. No reviewer/revision model was included in any treatment; acceptance was assessed externally.

Three workloads × three conditions × three repetitions produced **27 trials**, **63 distinct native children** and **108 observed model calls**. A delegated round is not necessarily one model call.

Trials did not overlap with one another. Only the two workers within a parallel trial overlapped. Condition order rotated across workload and repetition using these orders: single/sequential/parallel, sequential/parallel/single, parallel/single/sequential.

## Workloads and acceptance

Each final answer had to contain exactly four findings, one per question, with accurate file:line evidence and no unresolved uncertainty. Workers used the same bounded JSON schema, which allows up to five findings; that general schema does not enforce the stricter task-specific count by itself.

| Workload | Sources | Questions |
|---|---|---|
| Contracts | `src/worker-result.mjs`, `src/verdict.mjs` | Finding/evidence bounds; status/uncertainty rejection rules; declared verdict states; contradictory verified verdict handling |
| Routing | `src/routes.mjs`, `src/qualification.mjs` | Deterministic spread and reviewer preference; escalation/economy policy; evidence lifetime/ownership; record-store serialization scope |
| Lifecycle | `src/agent-dispatch.mjs`, `src/batch.mjs` | Admission limits/busy behavior; cancellation and duplicate IDs; uncertain batch recovery; commitments versus returned children and unknown usage |

All sources fit within a single child's context. These are bounded inspection tasks, not implementation, unrestricted research, cross-agent negotiation or a large-repository exploration benchmark.

### Per-workload results

| Workload | Approach | Accepted | Mean tokens | Mean seconds |
|---|---|---:|---:|---:|
| Contracts | Single | 3/3 | 14,144 | 14.0 |
| Contracts | Sequential | 3/3 | 28,814 | 36.0 |
| Contracts | Parallel | 3/3 | 28,880 | 22.2 |
| Routing | Single | 1/3 | 18,074 | 19.3 |
| Routing | Sequential | 3/3 | 36,668 | 39.8 |
| Routing | Parallel | 3/3 | 36,637 | 29.6 |
| Lifecycle | Single | 2/3 | 20,970 | 20.7 |
| Lifecycle | Sequential | 3/3 | 37,730 | 39.0 |
| Lifecycle | Parallel | 2/3 | 36,711 | 35.9 |

### Failed answers

- `routing-single-1` and `routing-single-3` answered only the routing questions and omitted the two qualification/storage questions while declaring complete.
- `lifecycle-single-3` answered only the dispatcher questions and omitted both batch questions while declaring complete.
- `lifecycle-parallel-3` answered the substance correctly but split one question into two findings, returning five instead of exactly four.

Acceptance was scored by the interactive parent against source-grounded expected answers. It was **not blind or independently adjudicated**. An independent Fable methodology audit checked the accounting and framing, not all semantic labels.

Small samples make acceptance-adjusted figures sensitive: changing three accepts to two increases that cell's tokens/accepted by 50% without changing consumption. If the formatting-only parallel failure were accepted on substance, parallel would score 9/9 at **34,076 tokens per accepted result**, still **28.1% above** the strict single-agent figure. That alternative does not replace the stated contract score.

## Accounting

The temporary bridge read benchmark child-session assistant-call usage and tool-name records. This telemetry is **not included in the shipped plugin's native child-result interface**: its native usage fields remain unknown. Direct-model task accounting is a different execution path.

Checks confirmed:

- **108/108 observed model calls** had provider-reported usage, exactly one usage event per call.
- Native step-start counts matched call counts in every child.
- No recorded assistant failure attempts in the scored trials; no child session reused across trials.
- Same route/model, unchanged source hashes and no integrator file reads.

For the measured Codex adapter, cached input is subtracted from its `inputTokens` field and reported separately. The calculation was:

```text
total = uncached input + cached input + output
```

Reasoning tokens are already a subset of output and are **not added again**. Cache writes were not reported for this route. These are provider-reported tokens, not byte-based estimates or inferred subscription quota units.

| Approach | Uncached input | Cached input | Output | Reasoning subset of output | Total |
|---|---:|---:|---:|---:|---:|
| Single | 118,773 | 35,840 | 4,951 | 2,167 | 159,564 |
| Sequential | 196,141 | 103,936 | 9,558 | 2,887 | 309,635 |
| Parallel | 210,695 | 86,016 | 9,972 | 3,171 | 306,683 |

Total scored-trial consumption: **775,882 tokens**. Monetary cost is unknown. Parallel's 1.0% lower total than sequential is a small observed difference, not evidence that concurrency itself reduces tokens.

Latency is monotonic elapsed trial execution time, including child startup, provider time, tool execution, integration, journal writes, bridge telemetry reads and child disposal. Parallel timing also includes reading its saved assignments. Subsequent report generation and acceptance evaluation are excluded.

## Exclusions and limitations

- **Not the entire experiment's bill:** outer conversation, task design, measurement infrastructure, qualification, pilots, Fable reviews and external evaluation are excluded from treatment totals. Two known pilots separately used 8,230 and 14,151 tokens; total experimental overhead was not fully tallied.
- **No billing-complete retry claim:** adapter/provider activity below the exposed session records may not carry visible usage. The measurement driver also wrote trial files only after usage validation; a late telemetry/bridge failure could leave partial cost unrecorded. No such failure occurred in the completed scored matrix.
- **Setup failures were not scored trials:** the temporary bridge initially omitted a required cancellation signal, causing two local setup attempts to fail before returning child IDs. It was repaired before the measured matrix. They are not evidence of zero provider spend.
- **Quality failures were retained:** the first missing-answer trial paused the run for inspection. The driver was then changed to retain quality failures and continue only the remaining trials, without changing prompts or rerunning completed trials. This is a disclosed procedural change, not a discarded warm-up.
- **Cache and load were uncontrolled:** counting cached tokens at full weight preserves the token measure, but cache carry-over, provider load and network variation affect latency. Rotating order mitigates rather than eliminates those effects.
- **Limited generalization:** one model/effort, three deliberately splittable workloads, three repetitions each and unblinded scoring do not establish statistical significance, provider-wide performance or a break-even point for larger tasks.
- **Partial reproducibility:** the CSV permits independent aggregate arithmetic, not a complete rerun or independent semantic audit. Private session logs, local instrumentation and account configuration are intentionally not distributed. Source pairs, questions, topology, model settings and snapshot identity are documented above.

## Practical conclusion

Use a single agent as the token-efficient default for small inspections like these. Consider parallel workers when useful specialization or independent scopes justify their extra startup/context/integration cost, or when time relative to sequential specialists matters. Test larger realistic tasks before claiming a break-even point.

A smaller parent conversation, cheaper route, or faster parallel run is **not equivalent to fewer total tokens**. Historical parent-context ratios and estimated savings are not substitutes for whole-task accounting.
