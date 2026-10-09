# Candidate v1 target-subject vectors

Candidate tests for sections 2, 3 and 5 of the v1 draft in [#5](https://github.com/aeoess/federation-port/pull/5) (`spec/CONTRACT-v1-target.md`): the runtime target on a `target: "required"` workflow, and the structured subject a target-bound claim reports. They sit next to `../target-coverage`, are not part of contract v0 or any other version, and change nothing under `src/`.

The candidate rules are in `target-subject.test.ts`: `validTarget()` (section 3), `admitRuntimeTarget()` (sections 2 and 3, before any component runs), `targetMatch()` (section 5, steps 1 to 6 in order) and `meetsRequired()` (the refusal for a required target-bound claim).

## Section 5, one case per step

Component cases run `invinoveritas/verdict-check` 0.4.0 on the given inputs. Synthetic cases are results that component never returns (C1 checks this), standing in for another component's output.

| case | step | source | result | target_match | decision |
|---|---|---|---|---|---|
| S1 | 1 | synthetic | established, `subject` is `null`, an array or a string | `invalid_subject`, claim `unavailable` (`adapter_protocol_violation:subject`) | refuse |
| S1b | 1 | synthetic | not established, `subject: null` (steps 1 and 2 come before step 3) | `invalid_subject` | refuse |
| S2 | 2 | synthetic | established, `subject.target` empty, lone high surrogate, lone low surrogate, a number | `invalid_subject` | refuse |
| S3 | 3 | component | action and verdict name A, runtime target B: `not_established`, subject A | `not_evaluated` | refuse, the claim's own refusal |
| S4 | 4 | synthetic | established with no `subject` (the 0.3.0 shape, target only in `reason`), and `subject: {}` | `missing_subject` | refuse, `no_reported_subject` |
| S5 | 5 | synthetic | established, subject A, runtime B; and subject `A/`, runtime A | `mismatched` | refuse, `reported_target_is_not_the_runtime_target` |
| S6 | 6 | component | action and verdict name the runtime target, including a 218-character one | `matched` | admit |

## Runtime target (sections 2 and 3)

On a `target: "required"` workflow, checked before any component runs. Each case also runs the component on the same request, to show it would not establish the target claim even if a runtime skipped the check.

| case | `SubmitRequest.target` | runtime | component (action and verdict name A) |
|---|---|---|---|
| R-missing | absent | `no_runtime_target` | `no_runtime_target` |
| R-null | `null` | `invalid_target` | `no_runtime_target` |
| R-empty | `""` | `invalid_target` | `verdict_target_is_not_the_runtime_target` |
| R-lone-high | ends in a lone `\uD800` | `invalid_target` | `verdict_target_is_not_the_runtime_target` |
| R-lone-low | starts with a lone `\uDC00` | `invalid_target` | `verdict_target_is_not_the_runtime_target` |
| R-valid | A | passes | established, subject A |

H1 to H3 put an invalid target (empty, lone high, lone low surrogate) inside the hashed action: the verdict still covers the action, and the target claim is `not_established` with `target_not_valid` and no subject. D1 shows why section 3 matters for section 6: `sha256()` over UTF-8 encodes a lone surrogate as the bytes of U+FFFD, so without validation `target_digest` would be the same for `x\uD800` and the valid target `x\uFFFD`.

## Readings these vectors take where the draft is silent

- **`null` target.** Treated as present and not valid (`invalid_target`), not as absent (`no_runtime_target`).
- **The claim's own refusal.** Written as `required_claim_<status>:<claim>`, as in `../target-coverage`.

## Run it

    ./v1-candidates/target-subject/reproduce.sh

It fetches the component at its pinned commit, checks the sealed artifact digest, confirms `src/` is unchanged, regenerates `vectors.json` and checks it is byte-identical, then runs the tests. Expected: `tests 18, pass 18, fail 0`. Against verdict-check 0.3.0, S3, S6, H1 to H3 and C1 fail, since 0.3.0 reports no structured subject.

## Limits

- The verdicts are signed with the same BIP-340 test key as `../target-coverage`, derived from a fixed string, not the production invinoveritas key.
- The rules here are candidates for review, written from the draft text. They do not cover retries, `target_digest` in the store, `operation_exists`, optional claims, same-id claims from different components, or a request changed while a check is pending.
