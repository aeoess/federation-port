# federation-port v1 draft: target coverage

Candidate text for discussion on [aeoess/agent-governance-vocabulary#177](https://github.com/aeoess/agent-governance-vocabulary/issues/177). A proposal, not adopted, and not implemented under `src/`. `spec/CONTRACT.md` (v0) is unchanged. Section numbers below refer to `spec/CONTRACT.md`.

## 1. Problem

v0 admits an action when every required claim is `established` (section 6). It never asks what each claim is about. In case C6 of the four-component composition test (`compose/v0-four-components` at `b3bdded`), the four established claims concern different subjects (the refund action, an A2A endpoint, a tool on another MCP server), and v0 admits. v1 adds the target the runtime declares for dispatch, what each claim binds, and the subject a target-bound claim reports.

## 2. When the target rules apply

- `WorkflowPolicy` gains `target: "required" | "none"`, default `"none"`.
- A workflow with `target: "none"` behaves exactly as in v0. A request to it that carries a `target` member, whatever its value, including `null`, is refused with `target_not_expected`, so a caller never believes a target was checked when none was. A policy whose `target: "none"` workflow requires a claim with `binds: "target"` is refused at load (`target_claim_without_target`).
- A workflow with `target: "required"` applies sections 3 to 6. A request to it with no `target` member is refused with `no_runtime_target`. A request whose `target` member is present but not valid (section 3), including `null`, is refused with `invalid_target`.
- A policy with a `target: "required"` workflow that has no required claim with `binds: "target"` is refused at load (`workflow_without_target_claim`). Otherwise such a workflow could admit without checking the target at all. This rule is added in this draft and was not discussed on #177.
- Presence and plain objects. A member counts as present only when it is an own property of its object and its value is not `undefined`, which is what survives JSON serialization. An inherited property never counts, and its value is never read. A plain object is a non-null object whose prototype is `Object.prototype` or `null`, so a `Date` or a class instance is not a plain object. These rules apply to the request's `target` (this section), the result's `subject` and the subject's `target` (section 5).
- The customer policy chooses which target-bound claims are required. Matching the target does not make different claims interchangeable. A walk of an endpoint, a verdict on an action at that endpoint and a check of the tool it serves are different guarantees, and none establishes anything outside its own declared semantics.

## 3. Dispatch target

- `SubmitRequest` gains an optional `target`, naming where the executor is to send the action. It sits next to `action`, never inside it. Putting it inside would change the action's hashed bytes, so an action already approved or verified would need new evidence.
- A valid `target` is an opaque, non-empty sequence of Unicode scalar values (in JavaScript, a string with no lone surrogates). Its UTF-8 encoding is used for hashing. The runtime does not normalize it, does not parse it as a URL, and never treats two different strings as the same target. Excluding lone surrogates also keeps `target_digest` (section 6) unambiguous. Encoded to UTF-8, a lone surrogate becomes the bytes of U+FFFD, so without this rule `x\uD800` and the valid target `x\uFFFD` would share a digest.
- At submission the runtime validates the target and takes an immutable copy before any component check runs, as it does for the action. That one value is used for every component check, the subject comparison, admission, the durable binding and dispatch. The runtime does not read `SubmitRequest.target` again between those steps.
- The runtime passes that value to every component as `CheckInput.target` and to the executor as `ExecuteOp.target`.

## 4. What a claim binds

- `ClaimDefinition` gains `binds: "action" | "target" | "context"`.
  - `action`: the component declares that its evidence covers the action supplied in `CheckInput.action`, under the claim's published semantics.
  - `target`: the component declares that its evidence covers a target, which it reports (section 5) and the runtime compares with the runtime target.
  - `context`: an established result holds for something other than this action or this target, for example another endpoint or an organization. It never satisfies an action or target requirement.
- The runtime checks the declared binding and the result, not the evidence. Each claim's `establishes` text should state its verification procedure, including the digest preimage where one applies.
- `ClaimRef` in the workflow policy gains `binds`. In a `target: "required"` workflow, every required claim must name `binds` in the policy, and the component's manifest must declare the same value. A mismatch or a missing declaration on either side refuses, with `claim_does_not_bind_target` for a target requirement and `claim_coverage_mismatch` otherwise. Nothing defaults.
- An action-bound claim alone does not satisfy a target-bound requirement. A target inside the hashed action can support a separate target-bound claim, if the component declares one and reports its subject.
- A required claim with `binds: "action"` or `binds: "context"` is met when it is `established` and the bindings match, as in v0. Section 5 adds the subject comparison for target-bound claims only.

## 5. Reported subject

`ClaimResult` gains `subject?: { target?: string }`. The component reports, and the runtime compares. Each target-bound claim then has two results, the component's claim status and the runtime's comparison, `target_match`. For every claim declared `binds: "target"`, the runtime sets `target_match` by these steps, in order, stopping at the first that applies.

1. `subject` is present and is not a plain object (including `null` or an array). The claim is `unavailable`, `adapter_protocol_violation:subject`, and `target_match` is `invalid_subject`.
2. `subject.target` is present and is not a valid target (section 3). Same outcome as step 1.
3. The claim is not `established`. `target_match` is `not_evaluated`.
4. `subject` or `subject.target` is absent. `target_match` is `missing_subject`.
5. `subject.target` differs from the runtime target. `target_match` is `mismatched`.
6. `subject.target` equals the runtime target. `target_match` is `matched`.

A required target-bound claim meets its requirement only with `target_match: "matched"`. Otherwise it refuses with `no_reported_subject` (missing), `reported_target_is_not_the_runtime_target` (mismatched), or the claim's own refusal (unavailable, not established). An optional target-bound claim is recorded with its status and its `target_match` and never blocks admission. An optional claim that is `established` with `mismatched` stays established as the component's result, but it does not cover the runtime target. On a claim not declared `binds: "target"`, `subject` is ignored and not recorded. The `target_match` values are proposed names, not agreed ones.

- The comparison is exact equality of the two strings. No case folding, no trailing slash, default port or percent-decoding normalization, and no Unicode normalization. `https://a.example/a2a/` does not match `https://a.example/a2a`. Both are valid targets (section 3), so this is the same as comparing their UTF-8 bytes.
- `subject` is a structured field, so it is not cut to 120 units like `reason` (section 9).

## 6. Durable binding and retries

- The operation row (`store.ts`) gains `target_digest`, which is `sha256:` followed by the lowercase hex SHA-256 of the target's UTF-8 bytes. That is `sha256(target)` in `src/runtime/canonical.ts`, not `digestJson(target)`, which would hash the JSON form with its quotes. It is SQL `NULL` when the request carries no target.
- A resubmission of a stored operation id is compared on `target_digest` right after `operation_id_reused_for_different_action`. A different target, or a target added or removed, is refused with `operation_target_changed`. The check applies on every path that treats a submission as a retry, including the one where a concurrent admission finds the row already committed (`operation_exists`).
- The runtime stores only the digest, as it does for the action. At dispatch the executor receives the target from the request being served, the original submission or a retry, after the runtime checks it against `target_digest`, as it checks the action against `action_digest`. Recovery without a resubmission would need the string itself stored, which this draft does not do.
- Provenance records `target_digest`, and for each target-bound claim its `target_match` and the digest of a valid `subject.target` in the same encoding. The structured subject is recorded by digest, not by value. A component may still put the target in `reason` as the v0 stand-in `subject:target=<value>`. In this draft a v1 runtime does not store a `reason` that starts with `subject:` for a claim that also returns a structured `subject`. Any other reason text is stored as in v0 and can still expose a target if the adapter writes one there.

## 7. What this does not establish

Three things stay separate. The component's evidence covers a subject. The runtime compares that subject with the target it declared. Where the executor actually sends the request is a third thing, and this draft establishes nothing about it.

- Where the executor actually sends the request. `ExecuteOp.target` is handed to an executor running in the runtime's own process with no confinement (section 10). An established target-bound claim means the evidence covers the runtime target, not that the network traffic went there.
- That the principal authorized the action at that target. A target-bound claim establishes coverage of the declared target under that component's claim semantics. A workflow that needs destination-specific authorization must require evidence that binds the authorization to that destination. For example, an action-bound authorization plus a walk of the target, both established, says nothing about whether the principal approved sending the action there.
- That a component's evidence really binds what its manifest declares. `binds` is the publisher's statement, pinned with the manifest.
- Anything about the target beyond what each component's own claim states, for example who operates it.
- Which tool is called at the target, or which tool definition it serves. A matching endpoint establishes neither.
- The expiry and reconciliation of uncertain operations, which is a separate discussion in [#2](https://github.com/aeoess/federation-port/issues/2).

## 8. Open questions

- **Destination authorization.** Whether v1 should define a binding that ties an authorization to a target, separate from target coverage.
- **Digest-encoded subjects.** Proposed on #177 as case J6. A component that holds only a digest of the target reports `subject.target_sha256`, and it matches when it equals the lowercase hex SHA-256 of the target's UTF-8 bytes, without the `sha256:` prefix that `target_digest` carries. Not adopted. With a structured `subject.target`, a component that holds the value does not need it. invinoveritas, so far the one component returning a structured subject, reports the value and has said it has no use for the digest form. J6 admits only with a local rewrite placed in front of `decide()`.
- **Length.** The maximum encoded length of a target and of a reported subject, and whether an oversized value is refused or makes the claim `unavailable`. Until this is settled, the text sets no bound.
- **Unknown subject members.** Whether members of `subject` other than `target` are ignored or make the claim `unavailable`.
- **Result format.** The exact shape and names of `target_match` in results and provenance.
- **At least one target claim.** Whether section 2's load rule is the right guarantee for `target: "required"`.
- **Tool coverage.** Whether a claim can bind the tool or tool definition at the target, and how that would be reported.
- **Store transition.** Adding `target_digest` changes the SQLite schema. v0 stores are at `STORE_SCHEMA_VERSION = 4` and an older store file is refused, not migrated. Whether v1 migrates v0 rows with a `NULL` target or refuses them until an explicit migration has to be decided before implementation.
- **Contract string and transition.** Whether manifests that declare `binds` use `federation-port/v1`, and whether a v1 runtime accepts the v0 stand-in in `reason`. In this draft a v1 runtime reads only `subject`, and a component may emit both while v0 runtimes are in use.

## 9. Evidence for the direction

- T1 to T6 and R1 (babyblueviper1, merged in #4): `v1-candidates/target-coverage/reproduce.sh` at `d9c8a9c` gives tests 8, pass 8, fail 0 with invinoveritas `verdict-check` 0.3.0.
- J1 to J6 (ogasurfproject-jpg): joint invinoveritas and NENRIN cases at `ogasurfproject-jpg/horizon-shield@0febb7cb`, reported 14/14 by their author on #177. Not run in this repository.
- Section 5 steps and target validation (babyblueviper1, #6): `v1-candidates/target-subject/reproduce.sh` at `59d3b8f` gives tests 18, pass 18, fail 0 with invinoveritas `verdict-check` 0.4.0, run from a clean clone. It covers every step in section 5 and a missing, `null`, empty and lone-surrogate target, as candidate rules in its own test file.
- What these cover. T1 to T6 exercise the v0 stand-in, the subject carried in `reason`, and the comparison in `decide()`. The #6 cases exercise the structured subject and target validation against candidate rules, not a runtime. None of them exercise retries, durable binding, `target_match` recorded by a runtime, section 2's activation and load rules, optional claims, claims with the same id from different components, the `operation_exists` path, or a caller changing its request object while a component check is pending. Each needs vectors before this text is adopted.

## 10. Changes this would make

| file | change |
|---|---|
| `src/contract/types.ts` | `CheckInput.target?`, `ExecuteOp.target?`, `ClaimDefinition.binds`, `ClaimResult.subject?` |
| `src/runtime/policy.ts` | `WorkflowPolicy.target`, `ClaimRef.binds` |
| `src/runtime/runtime.ts` | `SubmitRequest.target`, validation and snapshot, activation and the two load-time refusals, `target_match`, the retry check, the dispatch check, the `reason` filter |
| `src/runtime/store.ts` | `target_digest` column and `target_match` in claim records, a new schema version |
| `spec/CONTRACT.md` | sections 4, 6, 7, 9 and 10 as above |
