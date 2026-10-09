# Candidate v1 target-coverage vectors

Candidate tests for the v1 target-coverage direction in [aeoess/agent-governance-vocabulary#177](https://github.com/aeoess/agent-governance-vocabulary/issues/177). They are not part of contract v0 or any other version, and change nothing under `src/`. v0 has no `CheckInput.target`, so these vectors pass the target as that proposed field.

Each case has two layers:

1. **Component.** Given the action, the evidence and `CheckInput.target`, the component reports these claim statuses and, on an established target-bound claim, the subject it read from its verified evidence (`subject:target=<value>`, carried in the reason while there is no subject field).
2. **Runtime.** `decide()` in `target-coverage.test.ts` is the candidate rule: a requirement is met only if the claim is established and the component declares it binds what the requirement asks for (a missing declaration fails closed). For a target-bound requirement the workflow must declare a target, and the reported subject must equal it, exact string. The runtime does the comparison; the component only reports.

| case | action names | verdict issued on | runtime target | requirement | result |
|---|---|---|---|---|---|
| T1 target in hash | A | action(A) | A | target-bound | admit, reported target A |
| T2 cross-target reuse | B | action(A) | B | target-bound | refuse, `verdict_is_for_a_different_action` |
| T3 signed A, runtime B | A | action(A) | B | target-bound | refuse, `verdict_target_is_not_the_runtime_target` |
| T4 no runtime target | A | action(A) | none | target-bound | refuse, `no_runtime_target` |
| T4b no runtime target | A | action(A) | none | action-bound only | admit (v0 behaviour, no target guarantee) |
| T5 target not in hash | nothing | action() | A | target-bound | refuse, `target_not_in_hashed_action` |
| T6 action-bound claim for a target requirement | A | action(A) | A | target-bound on `verdict_covers_action` | refuse, `claim_does_not_bind_target` |

R1 tests `decide()` alone, with no component: an established claim reporting A does not satisfy runtime target B, a claim with no reported subject does not satisfy a target requirement, and an undeclared coverage fails closed.

The component under test is `invinoveritas/verdict-check` 0.3.0, which reads `CheckInput.target` when present and otherwise falls back to config `declared_target` (the v0 stand-in). Against 0.2.0, which only reads config, T1, T3, T4 and T6 fail, so the vectors tell the two apart.

## Run it

    ./v1-candidates/target-coverage/reproduce.sh

It fetches the component at its pinned commit, checks the sealed artifact digest, confirms `src/` is unchanged, regenerates `vectors.json` and checks it is byte-identical, then runs the tests. Expected: `tests 8, pass 8, fail 0`.

## Limits

- The verdicts are signed with a BIP-340 test key derived from a fixed string (`gen-vectors.ts`), not the production invinoveritas key. Real verdicts from the live key are exercised by the component's own suite.
- These cover target binding by an action-bound evidence source only. An endpoint-coverage source (a signed walk, a signed scan) reports its subject differently; the same `decide()` applies to it. Joint cases with NENRIN's walk, as offered in #177, would sit next to these.
- Nothing here addresses executor enforcement: whether the executor dispatches to the declared target is a separate question.
