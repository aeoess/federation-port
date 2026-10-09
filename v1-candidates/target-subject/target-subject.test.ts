// Candidate v1 vectors for the reported subject and the runtime target (aeoess/federation-port#5, sections 2, 3 and 5).
// Not a contract test: v0 has no CheckInput.target and no ClaimResult.subject. Three groups:
//   subject_cases  one per step of section 5, decided by the candidate targetMatch() below
//   target_cases   the runtime target on a target: "required" workflow (sections 2 and 3), checked before any component runs
//   hashed_invalid a target inside the hashed action that is not valid is never reported by the component
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const { createAdapter } = await import('../../adapters/invinoveritas-verdict/adapter.ts')

type Result = { claim: string; status: string; reason?: string; subject?: unknown }
type Match = 'invalid_subject' | 'not_evaluated' | 'missing_subject' | 'mismatched' | 'matched'

/** Section 3: an opaque, non-empty sequence of Unicode scalar values. In JavaScript, a non-empty string with no lone surrogates. */
export const validTarget = (t: unknown): t is string => typeof t === 'string' && t !== '' && !/\p{Cs}/u.test(t)

/** Sections 2 and 3 on a target: "required" workflow, before any component check. An absent target and an invalid one are different refusals. */
/** Section 2: a member is present only as an OWN property whose value is not undefined. An inherited property never counts. */
export const present = (o: object, k: string): boolean => Object.hasOwn(o, k) && (o as Record<string, unknown>)[k] !== undefined
/** Section 2: a plain object has Object.prototype or null as its prototype (so not an array, a Date, or an object built on another prototype). */
export const isPlain = (v: unknown): v is object => {
  if (typeof v !== 'object' || v === null) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

export function admitRuntimeTarget(req: { target?: unknown }): string | null {
  if (!present(req, 'target')) return 'no_runtime_target'
  return validTarget(req.target) ? null : 'invalid_target'
}

/** Section 5, steps 1 to 6 in order, for a claim declared binds: "target". Returns the recorded claim and target_match. */
export function targetMatch(r: Result, runtimeTarget: string): { claim: Result; target_match: Match } {
  const s = present(r, 'subject') ? r.subject : undefined
  if (s !== undefined && !isPlain(s)) return { claim: { claim: r.claim, status: 'unavailable', reason: 'adapter_protocol_violation:subject' }, target_match: 'invalid_subject' }
  if (s !== undefined && present(s, 'target') && !validTarget((s as { target: unknown }).target)) return { claim: { claim: r.claim, status: 'unavailable', reason: 'adapter_protocol_violation:subject' }, target_match: 'invalid_subject' }
  if (r.status !== 'established') return { claim: r, target_match: 'not_evaluated' }
  const t = s !== undefined && present(s, 'target') ? (s as { target: string }).target : undefined
  if (t === undefined) return { claim: r, target_match: 'missing_subject' }
  return { claim: r, target_match: t === runtimeTarget ? 'matched' : 'mismatched' }
}

/** A required target-bound claim meets its requirement only with matched; otherwise the refusal section 5 names. */
export function meetsRequired(m: { claim: Result; target_match: Match }): { decision: 'admit' | 'refuse'; refusal?: string } {
  if (m.target_match === 'matched') return { decision: 'admit' }
  if (m.target_match === 'missing_subject') return { decision: 'refuse', refusal: 'no_reported_subject' }
  if (m.target_match === 'mismatched') return { decision: 'refuse', refusal: 'reported_target_is_not_the_runtime_target' }
  return { decision: 'refuse', refusal: `required_claim_${m.claim.status}:${m.claim.claim}` }
}

const bytes = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)))
async function runComponent(action: unknown, evidence: unknown, runtimeTarget?: { absent?: true; value?: unknown } | string) {
  const a = createAdapter({ config: V.component_config, secrets: {}, fetch })
  const input: any = { operation_id: 'op', workflow: 'refund', action: structuredClone(action), evidence: bytes(evidence), now: V.now }
  if (typeof runtimeTarget === 'string') input.target = runtimeTarget
  else if (runtimeTarget && !runtimeTarget.absent) input.target = runtimeTarget.value
  return (await a.check!(input)).claims as Result[]
}
const TGT = 'invinoveritas.verdict_covers_target'
const reported: unknown[] = []   // every subject our component returns across this file, checked against section 5's shape at the end

for (const k of V.subject_cases) {
  test(`${k.id} step ${k.step} ${k.name}`, async () => {
    for (const v of k.variants) {
      let r: Result
      if (v.source === 'component') {
        const claims = await runComponent(v.action, v.evidence, v.runtime_target)
        r = claims.find(c => c.claim === TGT)!
        for (const c of claims) { if (c.claim !== TGT) assert.equal(c.subject, undefined, `${c.claim} must not report a subject`); else if ('subject' in c) reported.push(c.subject) }
        assert.equal(V.component_coverage[r.claim], 'target')
        if (k.expected.component_reason) assert.equal(r.reason, k.expected.component_reason)
        if (k.expected.component_subject) assert.deepEqual(r.subject, k.expected.component_subject)
      } else {
        r = v.result
        assert.equal((V.component_coverage[r.claim] ?? V.synthetic_coverage[r.claim]), 'target')
      }
      const m = targetMatch(r, v.runtime_target)
      assert.equal(m.target_match, k.expected.target_match, JSON.stringify(v))
      assert.equal(m.claim.status, k.expected.claim_status)
      if (k.expected.claim_reason) assert.equal(m.claim.reason, k.expected.claim_reason)
      const d = meetsRequired(m)
      assert.equal(d.decision, k.expected.decision)
      if (k.expected.refusal) assert.equal(d.refusal, k.expected.refusal)
    }
  })
}

for (const k of V.target_cases) {
  test(`${k.id} ${k.name}`, async () => {
    const req: { target?: unknown } = k.runtime_target.absent ? {} : { target: k.runtime_target.value }
    assert.equal(admitRuntimeTarget(req), k.expected.refusal)
    // Even if a runtime skipped the check, our component would not establish the target claim on an invalid runtime target.
    const r = (await runComponent(k.action, k.evidence, k.runtime_target)).find(c => c.claim === TGT)!
    assert.equal(r.reason, k.expected.component_reason)
    assert.equal(r.status, k.expected.refusal === null ? 'established' : 'not_established')
    if ('subject' in r) reported.push(r.subject)
  })
}

for (const k of V.hashed_invalid) {
  test(`${k.id} hashed target not valid: never reported`, async () => {
    const claims = await runComponent(k.action, k.evidence, k.runtime_target)
    assert.equal(claims.find(c => c.claim === 'invinoveritas.verdict_covers_action')!.status, 'established')
    const r = claims.find(c => c.claim === TGT)!
    assert.deepEqual([r.status, r.reason, 'subject' in r], [k.expected.status, k.expected.reason, false])
  })
}

test('C1 every subject our component returned has the section 5 shape: a plain object whose target is valid', () => {
  assert.ok(reported.length >= 4, `only ${reported.length} subjects seen`)
  for (const s of reported) {
    assert.equal(targetMatch({ claim: TGT, status: 'established', subject: s }, 'unused').target_match === 'invalid_subject', false, JSON.stringify(s))
    assert.ok(validTarget((s as { target: unknown }).target))
  }
})

test('D1 why section 3 rejects lone surrogates: sha256(target) over UTF-8 cannot tell them from U+FFFD', () => {
  // Node encodes a lone surrogate as EF BF BD, the bytes of U+FFFD. Without section 3, target_digest (section 6) would be the same
  // for "x\uD800" and the valid target "x\uFFFD", so operation_target_changed could miss that change on a retry.
  const d = (s: string) => createHash('sha256').update(s).digest('hex')
  assert.equal(d(`${'https://a.example/'}\uD800`), d(`${'https://a.example/'}\uFFFD`))
  assert.equal(validTarget('https://a.example/\uFFFD'), true)
  assert.equal(validTarget('https://a.example/\uD800'), false)
})

// aeoess review on #6 (section 2 at 5296a2e): presence means an own property whose value is not undefined; inherited never counts.
test('section 2: inherited, prototype-polluted, non-plain and undefined members', () => {
  const A = 'https://api.example.com/a2a'
  const est = (subject: unknown): Result => ({ claim: TGT, status: 'established', subject })
  assert.equal(targetMatch(est(Object.create({ target: A })), A).target_match, 'invalid_subject', 'subject built on another prototype')
  assert.equal(targetMatch(est(new Date(0)), A).target_match, 'invalid_subject', 'Date subject is not a plain object')
  assert.equal(targetMatch(est({ target: undefined }), A).target_match, 'missing_subject', 'own target set to undefined reads as absent')
  assert.equal(targetMatch(est(Object.assign(Object.create(null), { target: A })), A).target_match, 'matched', 'null-prototype object is plain')
  assert.equal(admitRuntimeTarget(Object.create({ target: A })), 'no_runtime_target', 'inherited runtime target is absent')
  const P = Object.prototype as Record<string, unknown>
  try {
    P.target = A
    assert.equal(targetMatch(est({}), A).target_match, 'missing_subject', 'Object.prototype.target must not be read as the subject target')
    assert.equal(admitRuntimeTarget({}), 'no_runtime_target', 'Object.prototype.target must not be read as the runtime target')
  } finally {
    delete P.target
  }
  assert.equal(Object.hasOwn(Object.prototype, 'target'), false, 'Object.prototype restored')
})

