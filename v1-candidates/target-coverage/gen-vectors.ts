// Generates vectors.json. Deterministic: BIP-340 test key derived from a fixed string, zero aux randomness, fixed created_at.
// Run from the repo root: node --experimental-strip-types v1-candidates/target-coverage/gen-vectors.ts
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
const A = 'https://a.example/a2a', B = 'https://b.example/a2a'
const act = (target?: string) => ({ tool: 'refund', args: { payment_id: 'pay_A', amount_minor: 4000, currency: 'EUR', ...(target ? { target } : {}) } })
const COV = 'invinoveritas.verdict_covers_action', TGT = 'invinoveritas.verdict_covers_target'
const reqTarget = [{ claim: TGT, binds: 'target' }], reqAction = [{ claim: COV, binds: 'action' }]

const cases = [
  { id: 'T1', name: 'target_in_hash_matches_runtime_target',
    description: 'The reviewed action names target A, the verdict covers that action, the runtime dispatches to A.',
    action: act(A), runtime_target: A, evidence: verdictOn(act(A)), requirements: reqTarget,
    expected: { claims: { [COV]: 'established', [TGT]: 'established' }, reported_target: A, decision: 'admit' } },
  { id: 'T2', name: 'cross_target_reuse',
    description: 'A verdict issued on the action for target A is presented for the same action sent to target B. The hash differs, so nothing is covered.',
    action: act(B), runtime_target: B, evidence: verdictOn(act(A)), requirements: reqTarget,
    expected: { claims: { [COV]: 'not_established', [TGT]: 'not_established' }, reason: 'verdict_is_for_a_different_action', decision: 'refuse' } },
  { id: 'T3', name: 'signed_target_A_runtime_target_B',
    description: 'The action and its verdict both name A, so the action is covered, but the runtime dispatches to B. The target-bound requirement fails.',
    action: act(A), runtime_target: B, evidence: verdictOn(act(A)), requirements: reqTarget,
    expected: { claims: { [COV]: 'established', [TGT]: 'not_established' }, reason: 'verdict_target_is_not_the_runtime_target', decision: 'refuse' } },
  { id: 'T4', name: 'no_runtime_target',
    description: 'The action and verdict name A, the workflow declares no runtime target. A target-bound requirement cannot be established.',
    action: act(A), runtime_target: null, evidence: verdictOn(act(A)), requirements: reqTarget,
    expected: { claims: { [COV]: 'established', [TGT]: 'not_established' }, reason: 'no_runtime_target', decision: 'refuse' } },
  { id: 'T4b', name: 'no_runtime_target_action_bound_only',
    description: 'Same inputs as T4, but the workflow requires only the action-bound claim: today\'s v0 behaviour, admitted, with no target guarantee.',
    action: act(A), runtime_target: null, evidence: verdictOn(act(A)), requirements: reqAction,
    expected: { claims: { [COV]: 'established', [TGT]: 'not_established' }, decision: 'admit' } },
  { id: 'T5', name: 'target_not_in_hashed_action',
    description: 'The reviewed action carries no target. The runtime dispatches to A. The verdict covers the action and says nothing about A.',
    action: act(), runtime_target: A, evidence: verdictOn(act()), requirements: reqTarget,
    expected: { claims: { [COV]: 'established', [TGT]: 'not_established' }, reason: 'target_not_in_hashed_action', decision: 'refuse' } },
  { id: 'T6', name: 'action_bound_claim_offered_for_target_requirement',
    description: 'The workflow requires target binding but the policy names only the action-bound claim as binding the target. An action-bound claim alone does not satisfy a target-bound requirement, even when the action contains the target.',
    action: act(A), runtime_target: A, evidence: verdictOn(act(A)), requirements: [{ claim: COV, binds: 'target' }],
    expected: { claims: { [COV]: 'established', [TGT]: 'established' }, decision: 'refuse', refusal: 'claim_does_not_bind_target' } },
]
const out = { schema: 'federation-port/v1-candidate/target-coverage', status: 'candidate, not part of any contract version',
  component: 'invinoveritas/verdict-check',
  component_coverage: { 'invinoveritas.verdict_authentic': 'context', [COV]: 'action', 'invinoveritas.verdict_permits_action': 'action', [TGT]: 'target' },
  component_config: { pubkey: PUB, accept_verdicts: ['approve'], max_age_s: 315360000 },
  now: '2026-10-09T12:00:00.000Z', key_note: 'Verdicts are signed with a BIP-340 test key derived from a fixed string; not the production invinoveritas key.',
  cases }
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${cases.length} cases, test pubkey ${PUB}`)
