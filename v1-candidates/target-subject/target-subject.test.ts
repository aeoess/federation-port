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
const { CLAIM_STATUSES } = await import('../../src/contract/types.ts')

type Result = { claim: string; status: string; reason?: string; subject?: unknown }
type Match = 'invalid_subject' | 'not_evaluated' | 'missing_subject' | 'mismatched' | 'matched'

/** Section 3: an opaque, non-empty sequence of Unicode scalar values. In JavaScript, a non-empty string with no lone surrogates. */
export const validTarget = (t: unknown): t is string => typeof t === 'string' && t !== '' && !/\p{Cs}/u.test(t)

/** Sections 2 and 3 on a target: "required" workflow, before any component check. An absent target and an invalid one are different refusals. */
/** Section 2: a member is present only as an OWN property, whatever its value — undefined is invalid the same as null. An inherited
 *  property never counts, and the runtime reads through the property's own descriptor so an accessor is never invoked: an own getter
 *  (even one that throws) is invalid, not a value to read. */
// A capture that throws (for example a Proxy whose getOwnPropertyDescriptor or getPrototypeOf trap throws) fails closed:
// it is reported as a present member that cannot be captured, never as an exception out of the helper.
function readMember(o: object, k: string): { present: boolean; accessor: boolean; value: unknown } {
  let d: PropertyDescriptor | undefined
  try { d = Object.getOwnPropertyDescriptor(o, k) } catch { return { present: true, accessor: true, value: undefined } }
  if (!d) return { present: false, accessor: false, value: undefined }
  if ('get' in d || 'set' in d) return { present: true, accessor: true, value: undefined }
  return { present: true, accessor: false, value: d.value }
}
/** Section 2 for the result's own members. The v0 contract types claim, status and reason as strings (src/contract/types.ts
 *  ClaimResult), so only a primitive string is captured. Any other value, a plain object or array included, fails capture, so a
 *  record never holds a reference the component can change after it returns. claim and status are required, reason is optional. */
const capturedString = (m: { present: boolean; accessor: boolean; value: unknown }): m is { present: true; accessor: false; value: string } =>
  m.present && !m.accessor && typeof m.value === 'string'
/** Section 2: a plain object has Object.prototype or null as its prototype (so not an array, a Date, or an object built on another prototype). */
export const isPlain = (v: unknown): v is object => {
  if (typeof v !== 'object' || v === null) return false
  let p: object | null
  try { p = Object.getPrototypeOf(v) } catch { return false }
  return p === Object.prototype || p === null
}

export function admitRuntimeTarget(req: { target?: unknown }): string | null {
  const m = readMember(req, 'target')
  if (!m.present) return 'no_runtime_target'
  return !m.accessor && validTarget(m.value) ? null : 'invalid_target'
}

/** Section 5, steps 1 to 6 in order, for a claim declared binds: "target". Returns the recorded claim and target_match. */
export function targetMatch(r: Result, runtimeTarget: string): { claim: Result; target_match: Match } {
  // Section 2 capture: claim, status, reason, subject and subject.target are each read once, through their own descriptors.
  // The returned record is built from those captured values, never the component's object, so later mutation cannot change it.
  // The refusal record holds only values captured as strings: a claim that is not one is left out, never copied by reference.
  const cm = readMember(r, 'claim')
  const claim = capturedString(cm) ? cm.value : undefined
  const invalidSubject = { claim: { ...(claim === undefined ? {} : { claim }), status: 'unavailable', reason: 'adapter_protocol_violation:subject' } as Result, target_match: 'invalid_subject' as const }
  if (claim === undefined) return invalidSubject
  const st = readMember(r, 'status')
  if (!capturedString(st)) return invalidSubject
  const rm = readMember(r, 'reason')
  if (rm.present && !capturedString(rm)) return invalidSubject
  const sm = readMember(r, 'subject')
  let t: string | undefined
  if (sm.present) {
    if (sm.accessor || !isPlain(sm.value)) return invalidSubject
    const tm = readMember(sm.value as object, 'target')
    if (tm.present) {
      if (tm.accessor || !validTarget(tm.value)) return invalidSubject
      t = tm.value as string
    }
  }
  const record: Result = { claim, status: st.value }
  if (rm.present) record.reason = rm.value as string
  if (sm.present) record.subject = t === undefined ? {} : { target: t }
  // v0 rule 3 (spec/CONTRACT.md, src/runtime normalizeCheckOutput): a captured status string outside the four v0 statuses makes
  // the claim unavailable. Section 5 then reaches step 3, since the claim is not established.
  if (!(CLAIM_STATUSES as readonly string[]).includes(st.value)) {
    return { claim: { ...record, status: 'unavailable', reason: 'adapter_protocol_violation:status' }, target_match: 'not_evaluated' }
  }
  if (st.value !== 'established') return { claim: record, target_match: 'not_evaluated' }
  if (t === undefined) return { claim: record, target_match: 'missing_subject' }
  return { claim: record, target_match: t === runtimeTarget ? 'matched' : 'mismatched' }
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

// aeoess review on #6 (section 2 at 5296a2e, then capture step at 18c102f): presence means an own property, whatever its value
// (undefined is invalid the same as null); inherited never counts; members are read through their own descriptor, so an accessor
// is never invoked (an own getter, even one that throws, is invalid rather than a value to read).
test('section 2: inherited, prototype-polluted, non-plain and undefined members', () => {
  const A = 'https://api.example.com/a2a'
  const est = (subject: unknown): Result => ({ claim: TGT, status: 'established', subject })
  assert.equal(targetMatch(est(Object.create({ target: A })), A).target_match, 'invalid_subject', 'subject built on another prototype')
  assert.equal(targetMatch(est(new Date(0)), A).target_match, 'invalid_subject', 'Date subject is not a plain object')
  assert.equal(targetMatch(est({ target: undefined }), A).target_match, 'invalid_subject', 'own target set to undefined is invalid, not absent')
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

// aeoess review on #6 at 315a9b0 (second round, five more cases against the capture step at 18c102f).
test('section 2 capture step: own-undefined subject, own-undefined runtime target, and accessors never invoked', () => {
  const A = 'https://api.example.com/a2a'
  const est = (subject: unknown): Result => ({ claim: TGT, status: 'established', subject })
  assert.equal(targetMatch({ claim: TGT, status: 'established', subject: undefined }, A).target_match, 'invalid_subject', 'own subject set to undefined is invalid, not absent')
  assert.equal(admitRuntimeTarget({ target: undefined }), 'invalid_target', 'own runtime target set to undefined is invalid, not absent')
  assert.equal(targetMatch(est({ get target() { return A } }), A).target_match, 'invalid_subject', 'an own getter is never invoked, so it cannot match')
  assert.equal(targetMatch(est({ get target() { throw new Error('must not be called') } }), A).target_match, 'invalid_subject', 'a throwing getter must not be invoked, and must not make targetMatch throw')
})

// aeoess follow-up after #6: the corners left open in the merge comment, one test per guard so each can be checked by mutation.
const A2 = 'https://api.example.com/a2a'
test('capture: status is read through its descriptor, an accessor is invalid and never invoked', () => {
  let calls = 0
  const r = { claim: TGT, subject: { target: A2 } } as Result
  Object.defineProperty(r, 'status', { get() { calls++; return 'established' }, enumerable: true })
  assert.equal(targetMatch(r, A2).target_match, 'invalid_subject')
  assert.equal(calls, 0, 'the status getter is never invoked')
})
test('capture: an own status set to undefined is invalid, not absent', () => {
  assert.equal(targetMatch({ claim: TGT, status: undefined as unknown as string, subject: { target: A2 } }, A2).target_match, 'invalid_subject')
})
test('capture: the claim member is read through its descriptor, a throwing claim getter is invalid and never invoked', () => {
  let calls = 0
  const r = { status: 'established', subject: { target: A2 } } as unknown as Result
  Object.defineProperty(r, 'claim', { get() { calls++; throw new Error('must not be called') }, enumerable: true })
  assert.equal(targetMatch(r, A2).target_match, 'invalid_subject')
  assert.equal(calls, 0, 'the claim getter is never invoked')
})
test('capture: a throwing getOwnPropertyDescriptor trap fails closed on the subject, the request and the result', () => {
  const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap') } })
  assert.equal(targetMatch({ claim: TGT, status: 'established', subject: trap }, A2).target_match, 'invalid_subject')
  assert.equal(admitRuntimeTarget(trap as { target?: unknown }), 'invalid_target')
  assert.equal(targetMatch(trap as Result, A2).target_match, 'invalid_subject')
})
test('capture: a throwing getPrototypeOf trap makes the subject not plain', () => {
  const trap = new Proxy({ target: A2 }, { getPrototypeOf() { throw new Error('trap') } })
  assert.equal(targetMatch({ claim: TGT, status: 'established', subject: trap }, A2).target_match, 'invalid_subject')
})
test('capture: the returned record is built from captured values, so mutating the result afterwards changes nothing', () => {
  const r: Result = { claim: TGT, status: 'established', subject: { target: A2 } }
  const m = targetMatch(r, A2)
  r.status = 'failed'
  ;(r.subject as { target: string }).target = 'https://b.example/a2a'
  assert.notEqual(m.claim, r)
  assert.equal(m.claim.status, 'established')
  assert.deepEqual(m.claim.subject, { target: A2 })
  assert.equal(m.target_match, 'matched')
  assert.equal(meetsRequired(m).decision, 'admit')
})

// Day 238, after babyblueviper1 on #7 at 7f31646: claim, status and reason as objects or other non-strings, on both paths.
// Each record is checked for no object values and for not changing when the component mutates what it returned.
const noObjects = (rec: unknown) => Object.values(rec as object).every(v => typeof v !== 'object' || v === null)
for (const member of ['claim', 'status', 'reason'] as const) {
  for (const [label, bad] of [['object', { x: 1 }], ['array', ['established']], ['String object', new String('established')], ['number', 1], ['null', null], ['boolean', true]] as const) {
    test(`capture: ${member} as ${label} is invalid_subject, refusal record holds no caller object`, () => {
      const r: Record<string, unknown> = { claim: TGT, status: 'established', reason: 'ok', subject: { target: A2 } }
      r[member] = bad
      const m = targetMatch(r as unknown as Result, A2)
      assert.equal(m.target_match, 'invalid_subject')
      assert.ok(noObjects(m.claim), JSON.stringify(m.claim))
      const before = JSON.stringify(m)
      if (bad !== null && typeof bad === 'object') (bad as Record<string, unknown>).x = 2
      r.claim = 'changed'; r.status = 'not_established'
      assert.equal(JSON.stringify(m), before, 'refusal record unchanged after the component mutates its result')
    })
  }
}
test('capture: claim or status absent is invalid_subject, reason absent is allowed', () => {
  assert.equal(targetMatch({ status: 'established', subject: { target: A2 } } as unknown as Result, A2).target_match, 'invalid_subject')
  assert.equal(targetMatch({ claim: TGT, subject: { target: A2 } } as unknown as Result, A2).target_match, 'invalid_subject')
  assert.equal(targetMatch({ claim: TGT, status: 'established', subject: { target: A2 } }, A2).target_match, 'matched')
})
test('capture: accepted record does not change when the component mutates its result, its subject or the subject target', () => {
  const subject = { target: A2 }
  const r: Record<string, unknown> = { claim: TGT, status: 'established', reason: 'ok', subject }
  const m = targetMatch(r as unknown as Result, A2)
  assert.equal(m.target_match, 'matched')
  const before = JSON.stringify(m)
  subject.target = 'https://other.example/'; r.claim = 'x'; r.status = 'failed'; r.reason = 'y'; r.subject = { target: 'z' }
  assert.equal(JSON.stringify(m), before)
  assert.notEqual(m.claim.subject, subject, 'the record holds a new subject object, not the component one')
})
test('capture: reason as an accessor is invalid and never invoked', () => {
  let calls = 0
  const r = { claim: TGT, status: 'established', subject: { target: A2 } } as Result
  Object.defineProperty(r, 'reason', { get() { calls++; return 'ok' }, enumerable: true })
  assert.equal(targetMatch(r, A2).target_match, 'invalid_subject')
  assert.equal(calls, 0)
})
test('capture: an unknown status string is unavailable under v0 rule 3, not invalid_subject', () => {
  const m = targetMatch({ claim: TGT, status: 'establishd', reason: 'ok', subject: { target: A2 } }, A2)
  assert.equal(m.target_match, 'not_evaluated')
  assert.deepEqual([m.claim.status, m.claim.reason], ['unavailable', 'adapter_protocol_violation:status'])
  assert.equal(meetsRequired(m).refusal, `required_claim_unavailable:${TGT}`)
})
test('capture: a revoked Proxy as the result, and a Proxy as the status, fail closed without throwing', () => {
  const { proxy, revoke } = Proxy.revocable({ claim: TGT, status: 'established', subject: { target: A2 } }, {})
  revoke()
  assert.equal(targetMatch(proxy as Result, A2).target_match, 'invalid_subject')
  assert.equal(targetMatch({ claim: TGT, status: new Proxy({}, {}) as unknown as string, subject: { target: A2 } }, A2).target_match, 'invalid_subject')
})

// Outside check (babyblueviper1, #7 review): object-valued members are not capturable as strings, so they are invalid,
// and nothing in the returned record aliases a caller object.
test('capture: an object-valued status is invalid_subject, not not_evaluated, and the record holds no caller object', () => {
  const st = { v: 'established' }
  const m = targetMatch({ claim: TGT, status: st as unknown as string, subject: { target: A2 } }, A2)
  assert.equal(m.target_match, 'invalid_subject')
  st.v = 'mutated'
  assert.notEqual(m.claim.status as unknown, st)
  assert.equal(typeof m.claim.status, 'string')
})
test('capture: an object-valued claim or reason is invalid_subject, never matched', () => {
  const reason = { why: 'a' }
  for (const r of [
    { claim: { k: 1 }, status: 'established', subject: { target: A2 } },
    { claim: TGT, status: 'established', reason, subject: { target: A2 } },
  ]) {
    const m = targetMatch(r as unknown as Result, A2)
    assert.equal(m.target_match, 'invalid_subject')
    assert.equal(meetsRequired(m).decision === 'admit', false)
    assert.ok(typeof m.claim.claim === 'string' || m.claim.claim === undefined)
    assert.notEqual(m.claim.reason as unknown, reason)
  }
})
