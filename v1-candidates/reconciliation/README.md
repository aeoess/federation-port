# Candidate v1 reconciliation for uncertain provider operations

A candidate for [#2](https://github.com/aeoess/federation-port/issues/2). It is not part of contract v0 or any other version, and changes nothing under `src/`. It runs next to the v0 `Runtime`, on the same SQLite store, in three tables of its own (`reconciliation`, `reconciliation_lookups`, `reconciliation_events`).

The model is [`formal/tla/LeaseReconcile.tla`](https://github.com/darklordVirtual/REMORA-research/blob/master/formal/tla/LeaseReconcile.tla) in REMORA-research. Each rule below matches a configuration there that holds, and each assumption the rule relies on has a configuration that is violated without it.

## The two failure cases

These come first because #2 asked for them first.

| case | what happens | result |
|---|---|---|
| F1 | attempt 1's request is held by the provider; a lookup reports `not_found`, not final; the request then settles | stays `unknown` after the lookup, then `provider_confirmed`; never `failed`. The rule this replaces (`naiveDecide`, an authoritative absence closes) would have closed it as `failed` with the refund still to come |
| F2 | a request sent before the deadline settles after it | no dispatch after the deadline (the v0 rule). The effect is recorded as `effect_after_expiry`, with `dispatched_before_expiry: true` and both instants; the operation ends `provider_confirmed` |

In the model these are `reconcile_naive_absent` (violated: `Lookup → Receive(1) → Settle(1)`) and `reconcile_effect_after_expiry` (violated: `Receive(1) → Tick → Settle(1)`). The runtime can prevent a dispatch after expiry, but it cannot prevent an effect after expiry. The candidate keeps those two facts apart.

## When `absent` closes an operation

The rule is in `decide()`. An absence closes the operation as `failed` (event `reconciled_absent`) only when all of these hold:

1. **The operator trusts this lookup.** The policy declares the provider account and key namespace, that the lookup is complete for that scope (`lookup_complete`), and that it accepts the provider's key-scoped finality (`accepts_key_finality`). The provider must report that same account and namespace. The adapter's `authoritative` flag never counts on its own.
2. **The absence is final for the key.** `final: true` with `final_scope: 'key'` means the provider guarantees that no request with this key, earlier or later, can produce an effect. The simulator does this by cancelling the key. A plain `not_found` is not final, because a request sent earlier may still settle (F1).
3. **The lookup ran inside the retention window.** A `not_found` from a provider that may have forgotten the key is not evidence.
4. **No attempt is in flight.** An attempt still running under its lease may still settle and report.

If any of these fails, the operation stays `unknown`, and the lookup row records why: `absent_not_trusted`, `absent_scope_mismatch`, `absent_not_final`, `absent_outside_retention` or `attempt_in_flight`.

A confirmation always wins: from a lookup, or from a late attempt, trusted or not. If it contradicts an absence this reconciler closed, it is recorded as `absence_contradicted` and the operation becomes `provider_confirmed`. Attempt rows are never rewritten. A provider that misreports finality makes the closure wrong (`reconcile_misreported_final`, violated). The contradiction still resolves to the confirmation (`reconcile_misreport_contradiction`, holds). Finality is a provider guarantee the operator chose to trust, and the record shows that.

## Retries and the retention window

The executor manifest declares `idempotency: { retention_ms }`. The operator may cap it (`retention_cap_ms`), and the effective window is the smaller of the two. Retention and lookup completeness are separate guarantees: retention says a replay is deduplicated, not that a lookup sees everything.

An effect-producing retry of an `unknown` operation is allowed only while

    now <= valid_until   and   now + execute_timeout_ms + 2 * max_skew_ms <= first_dispatch_at + retention_ms

under three timing assumptions, written down in `reconcile.ts`:

- **T1.** The provider remembers a key for at least `retention_ms` after it first received it, on its own clock.
- **T2.** The runtime and provider clocks differ by at most `max_skew_ms`, and `first_dispatch_at` is read before attempt 1 can reach the provider.
- **T3.** A request reaches the provider within its timeout, or never.

T3 is the one HTTP does not give you. The model shows it carries weight: without it, a retry sent inside the window can arrive after the provider forgot the key, and that is a second refund (`reconcile_unbounded_delivery`). This gap was found while writing the model. An executor that declares no retention gets no effect-producing retry of an `unknown` operation at all; the operation goes to reconciliation. A lookup obeys the same window, with `lookup_timeout_ms` in place of the execute timeout.

`retryAllowed()` is the rule. `submitWithReconciliation()` applies it in front of `rt.submit()` as a stand-in. A v1 runtime must evaluate it inside `claimDispatch`'s transaction, the same way it checks the deadline. The stand-in checks outside the claim, so it demonstrates the rule and does not enforce it.

## Status, budget and the operator

The effect state stays `unknown` until there is evidence. How the uncertainty is being handled is a separate field, `reconciliation.status`, with these values:

| status | meaning |
|---|---|
| `pending` | lookups still allowed |
| `operator_required` | there is no `reconcile`, the retention window has passed, or the lookup budget is spent |
| `resolved_confirmed` | resolved by a confirmation |
| `resolved_absent` | resolved by an accepted absence |
| `operator_resolved` | an operator decision is recorded |

`operator_required` is a reconciliation status. It is not an effect result.

The lookup budget is stored with the operation at its first lookup. A policy can tighten it later but never raise or reset it. Each lookup is reserved, and counted, in a transaction before the provider is asked. A crash between the lookup and recording its result therefore costs one unit of budget and changes nothing else, and two workers together can never exceed the budget.

An operator decision (`recordOperatorDecision`) is its own provenance entry with its own evidence digest. It does not rewrite the effect state or the attempts.

Reaching `operator_required` within a bounded number of steps needs a scheduling assumption: an operation that can be reconciled eventually is, because a caller resubmits it or the runtime sweeps (`sweep()`). Without that, nothing forces progress (`reconcile_no_scheduling`, violated). A budget that a restart can reset breaks the bound (`reconcile_volatile_budget`, violated).

## Answers to the three open questions on #2

- **Can the customer policy tighten retention?** Yes. `retention_cap_ms` caps the manifest's value. Nothing can raise it.
- **Is `reconciled_absent` a new terminal state?** No. It is `failed`, with the `reconciled_absent` event and the evidence digest. This keeps v0's four effect states. The reconciliation status says how the operation was closed.
- **Who runs reconciliation?** Both a caller and the runtime can: `reconcile(opId)` on demand, and `sweep()` over every `unknown` operation. The sweep also rechecks absences it closed while they are inside the retention window, which is how a contradiction is found.

## Run it

    ./v1-candidates/reconciliation/reproduce.sh

It confirms that `src/` is unchanged and checks the executor's sealed artifact digest. Then it runs the candidate tests (expected: `tests 17, pass 17, fail 0`) and the v0 suite next to them, to show that the candidate's tables do not disturb v0.

## Limits

- The lookup, the cancellation and the finality are the simulator's. A real provider's lookup endpoint, its completeness and its finality guarantee are what the operator's `trust` declaration covers, and the candidate cannot check them.
- `reconcile()` is read-only by declaration. As with `execute`, V0 cannot confine what an adapter does (§10). The manifest names the endpoint it uses.
- The retry rule is a stand-in outside `claimDispatch` (see above).
- The model is finite: three attempts and a lookup budget of two. "Holds" means no violation in that space.
