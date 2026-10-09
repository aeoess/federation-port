// Generates vectors.json. Deterministic: BIP-340 test key derived from a fixed string, zero aux randomness, fixed created_at.
// Run from the repo root: node --experimental-strip-types v1-candidates/target-subject/gen-vectors.ts
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
type Pt = [bigint, bigint] | null
const md = (a: bigint, m = P) => ((a % m) + m) % m
const pw = (b: bigint, e: bigint): bigint => { let r = 1n; b = md(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n } return r }
const ad = (a: Pt, b: Pt): Pt => {
  if (a === null) return b; if (b === null) return a
  if (a[0] === b[0] && md(a[1] + b[1]) === 0n) return null
  const l = a[0] === b[0] && a[1] === b[1] ? md(3n * a[0] * a[0] * pw(2n * a[1], P - 2n)) : md((b[1] - a[1]) * pw(b[0] - a[0], P - 2n))
  const x = md(l * l - a[0] - b[0]); return [x, md(l * (a[0] - x) - a[1])]
}
const ml = (p: Pt, k: bigint): Pt => { let r: Pt = null; for (let i = 255; i >= 0; i--) { r = ad(r, r); if ((k >> BigInt(i)) & 1n) r = ad(r, p) } return r }
const G: Pt = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n]
const b32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex')
const int = (b: Uint8Array) => BigInt('0x' + Buffer.from(b).toString('hex'))
const th = (tag: string, ...parts: Uint8Array[]) => { const t = createHash('sha256').update(tag).digest(); const h = createHash('sha256').update(t).update(t); for (const x of parts) h.update(x); return h.digest() }
function sign(sk: bigint, msg: Buffer): Buffer {
  const Pk = ml(G, sk)!; const d = Pk[1] % 2n === 0n ? sk : N - sk
  const t = Buffer.from(b32(d).map((v, i) => v ^ th('BIP0340/aux', Buffer.alloc(32))[i]))
  const k0 = md(int(th('BIP0340/nonce', t, b32(Pk[0]), msg)), N); const R = ml(G, k0)!; const k = R[1] % 2n === 0n ? k0 : N - k0
  const e = md(int(th('BIP0340/challenge', b32(R[0]), b32(Pk[0]), msg)), N)
  return Buffer.concat([b32(R[0]), b32(md(k + e * d, N))])
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SK = md(int(createHash('sha256').update('federation-port v1 target-coverage test key').digest()), N)
const PUB = b32(ml(G, SK)![0]).toString('hex')
function verdictOn(action: unknown) {
  const ev: any = { pubkey: PUB, created_at: 1791504000, kind: 30078, tags: [['schema', 'invinoveritas.verdict_proof.v1']],
                    content: JSON.stringify({ artifact_hash: sha(canonical(action)), verdict: 'approve' }) }
  ev.id = sha(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
  ev.sig = sign(SK, Buffer.from(ev.id, 'hex')).toString('hex')
  return ev
}
const A = 'https://a.example/a2a', B = 'https://b.example/a2a', LONG = 'https://a.example/' + 'x'.repeat(200)
const act = (target?: string) => ({ tool: 'refund', args: { payment_id: 'pay_A', amount_minor: 4000, currency: 'EUR', ...(target !== undefined ? { target } : {}) } })
const TGT = 'invinoveritas.verdict_covers_target', X = 'x.covers_target'
const fromComponent = (action: unknown, runtime_target: string, evidence = verdictOn(action)) => ({ source: 'component', action, runtime_target, evidence })
const synthetic = (result: Record<string, unknown>, runtime_target: string) => ({ source: 'synthetic', runtime_target, result })

// Section 5: one case per step, in the draft's order. "component" cases run invinoveritas/verdict-check on the inputs; "synthetic"
// cases are results our component never returns (asserted in the test), standing in for another component's output.
const subject_cases = [
  { id: 'S1', step: 1, name: 'subject_not_a_plain_object',
    description: 'An established target-bound claim whose subject is null, an array or a string. The claim becomes unavailable and target_match is invalid_subject.',
    variants: [null, [A], A].map(subject => synthetic({ claim: X, status: 'established', subject }, A)),
    expected: { claim_status: 'unavailable', claim_reason: 'adapter_protocol_violation:subject', target_match: 'invalid_subject', decision: 'refuse', refusal: `required_claim_unavailable:${X}` } },
  { id: 'S1b', step: 1, name: 'subject_checked_before_status',
    description: 'The same malformed subject on a claim that is not established. Steps 1 and 2 come before step 3, so it is still a protocol violation, not not_evaluated.',
    variants: [synthetic({ claim: X, status: 'not_established', subject: null }, A)],
    expected: { claim_status: 'unavailable', claim_reason: 'adapter_protocol_violation:subject', target_match: 'invalid_subject', decision: 'refuse', refusal: `required_claim_unavailable:${X}` } },
  { id: 'S2', step: 2, name: 'subject_target_not_a_valid_target',
    description: 'subject.target is present but not a valid target (section 3): empty, a lone high surrogate, a lone low surrogate, a number.',
    variants: ['', 'https://a.example/\uD800', 'https://a.example/\uDC00', 42].map(t => synthetic({ claim: X, status: 'established', subject: { target: t } }, A)),
    expected: { claim_status: 'unavailable', claim_reason: 'adapter_protocol_violation:subject', target_match: 'invalid_subject', decision: 'refuse', refusal: `required_claim_unavailable:${X}` } },
  { id: 'S3', step: 3, name: 'claim_not_established',
    description: 'The action and its verdict name A, the runtime target is B. Our component compares too, so it returns not_established with subject A. The runtime does not compare: not_evaluated, and the claim\'s own refusal.',
    variants: [fromComponent(act(A), B)],
    expected: { claim_status: 'not_established', component_reason: 'verdict_target_is_not_the_runtime_target', component_subject: { target: A }, target_match: 'not_evaluated', decision: 'refuse', refusal: `required_claim_not_established:${TGT}` } },
  { id: 'S4', step: 4, name: 'subject_missing',
    description: 'An established target-bound claim with no subject, in the shape verdict-check 0.3.0 returns (the target only as subject:target=<value> in reason). A v1 runtime reads only subject (section 8), so this is missing_subject.',
    variants: [synthetic({ claim: TGT, status: 'established', reason: `subject:target=${A}` }, A), synthetic({ claim: X, status: 'established', subject: {} }, A)],
    expected: { claim_status: 'established', target_match: 'missing_subject', decision: 'refuse', refusal: 'no_reported_subject' } },
  { id: 'S5', step: 5, name: 'subject_target_differs',
    description: 'A component that only reports (as an endpoint walk does) returns established with subject A while the runtime target is B. Exact string, so the trailing slash is a different target too.',
    variants: [synthetic({ claim: X, status: 'established', subject: { target: A } }, B), synthetic({ claim: X, status: 'established', subject: { target: A + '/' } }, A)],
    expected: { claim_status: 'established', target_match: 'mismatched', decision: 'refuse', refusal: 'reported_target_is_not_the_runtime_target' } },
  { id: 'S6', step: 6, name: 'subject_target_equals_runtime_target',
    description: 'The action and its verdict name the runtime target. Our component returns established with subject.target, including a 218-character target that the 120-unit reason would only carry as a digest.',
    variants: [fromComponent(act(A), A), fromComponent(act(LONG), LONG)],
    expected: { claim_status: 'established', target_match: 'matched', decision: 'admit' } },
]

// Sections 2 and 3: the runtime target on a target: "required" workflow. Checked before any component runs. The component layer
// shows our component would not establish on these inputs either.
const target_cases = [
  { id: 'R-missing', name: 'no_runtime_target', runtime_target: { absent: true }, expected: { refusal: 'no_runtime_target', component_reason: 'no_runtime_target' } },
  { id: 'R-null', name: 'null_runtime_target', runtime_target: { value: null }, expected: { refusal: 'invalid_target', component_reason: 'no_runtime_target' } },
  { id: 'R-empty', name: 'empty_runtime_target', runtime_target: { value: '' }, expected: { refusal: 'invalid_target', component_reason: 'verdict_target_is_not_the_runtime_target' } },
  { id: 'R-lone-high', name: 'lone_high_surrogate', runtime_target: { value: 'https://a.example/a2a\uD800' }, expected: { refusal: 'invalid_target', component_reason: 'verdict_target_is_not_the_runtime_target' } },
  { id: 'R-lone-low', name: 'lone_low_surrogate', runtime_target: { value: '\uDC00https://a.example/a2a' }, expected: { refusal: 'invalid_target', component_reason: 'verdict_target_is_not_the_runtime_target' } },
  { id: 'R-valid', name: 'valid_runtime_target_control', runtime_target: { value: A }, expected: { refusal: null, component_reason: `subject:target=${A}` } },
].map(c => ({ ...c, action: act(A), evidence: verdictOn(act(A)) }))

// A target inside the hashed action that is not valid: our component never reports it as a subject.
const hashed_invalid = ['', 'https://a.example/\uD800', 'https://a.example/\uDC00'].map((t, i) => ({ id: `H${i + 1}`, action: act(t), evidence: verdictOn(act(t)), runtime_target: t,
  expected: { status: 'not_established', reason: 'target_not_valid', subject: null } }))

const out = { schema: 'federation-port/v1-candidate/target-subject', status: 'candidate, not part of any contract version',
  draft: 'aeoess/federation-port#5 spec/CONTRACT-v1-target.md, sections 2, 3 and 5',
  component: 'invinoveritas/verdict-check',
  component_coverage: { 'invinoveritas.verdict_authentic': 'context', 'invinoveritas.verdict_covers_action': 'action', 'invinoveritas.verdict_permits_action': 'action', [TGT]: 'target' },
  component_config: { pubkey: PUB, accept_verdicts: ['approve'], max_age_s: 315360000 },
  synthetic_coverage: { [X]: 'target' },
  now: '2026-10-09T12:00:00.000Z', key_note: 'Verdicts are signed with a BIP-340 test key derived from a fixed string; not the production invinoveritas key.',
  subject_cases, target_cases, hashed_invalid }
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${subject_cases.length} subject cases, ${target_cases.length} target cases, ${hashed_invalid.length} hashed-invalid cases, test pubkey ${PUB}`)
