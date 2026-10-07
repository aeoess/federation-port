// refund-execution/0.1 envelope profile on the unchanged core. action.args carries the whole
// handoff, so the runtime's action digest binds the nested arguments and every handoff reference.
// Uses only new components, a new local execution simulator and synthetic keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Runtime, sha256 } from '../src/runtime/index.ts'
import { BOUNDARY, createOperator } from '../sim/operator.ts'
import type { Operator } from '../sim/operator.ts'
import { APPROVED_REFUND, TARGET_TEMPLATE } from '../sim/profile.ts'
import { argumentsDigest, startExecutionSimulator } from '../sim/refund-execution-0.1/simulator.ts'
import type { ExecutionSimulator } from '../sim/refund-execution-0.1/simulator.ts'
import { ADMISSION, EXECUTOR, REQUIRED_CLAIMS, WORKFLOW, refundExecutionPolicy } from '../sim/refund-execution-0.1/policy.ts'
import { ROOT, opId, pinFromDisk, tmp } from './helpers.ts'

const reasonsOf = (r: { status: string } & Record<string, unknown>) => (r.reasons as string[] | undefined) ?? []

interface ProfileEnv { sim: ExecutionSimulator; operator: Operator; rt: Runtime; apiKey: string; dir: string; close(): Promise<void> }

async function setupProfile(o: { requirePic?: boolean } = {}): Promise<ProfileEnv> {
  const apiKey = randomBytes(24).toString('hex')
  const dir = tmp('fp-re01-')
  const sim = await startExecutionSimulator({ apiKey, dbPath: join(dir, 'sim.db') })
  const operator = createOperator()
  const policy = refundExecutionPolicy({
    admissionPin: pinFromDisk(join(ROOT, 'adapters/refund-execution-0.1-admission')),
    executorPin: pinFromDisk(join(ROOT, 'adapters/refund-execution-0.1-execution')),
    boundary: BOUNDARY, boundaryPublicKey: operator.boundaryPublicKey, targetTemplate: TARGET_TEMPLATE, executionUrl: sim.url,
  })
  if (o.requirePic) policy.workflows[WORKFLOW].required_claims.push({ component: ADMISSION, claim: 'pic.verified' })
  const rt = await Runtime.create({ policy, dbPath: join(dir, 'port.db'), secrets: { execution_api_key: apiKey } })
  const env: ProfileEnv = { sim, operator, rt, apiKey, dir, async close() { env.rt.close(); await env.sim.close() } }
  return env
}

type Tuple = { payment_id: string; currency: string; amount_minor: number }

/** A handoff for one new operation with a fresh approval issued for `approved`. */
function submission(env: ProfileEnv, args: Tuple = { ...APPROVED_REFUND }, approved: Tuple = { ...APPROVED_REFUND }) {
  const a = env.operator.issue(approved)
  const operation_id = opId()
  const handoff = {
    schema: 'refund-execution/0.1', operation_id, tool: 'refund',
    arguments: { payment_id: args.payment_id, currency: args.currency, amount_minor: args.amount_minor },
    approval_ref: a.approval_id,
    pic_evidence_ref: `pic-correlation:synthetic:${operation_id}`,
    aps_evidence_ref: `aps-admission:${sha256(a.evidence)}`,
  }
  return { a, handoff, req: { workflow: WORKFLOW, operation_id, approval_id: a.approval_id, action: { tool: 'refund', args: handoff }, evidence: { [ADMISSION]: a.evidence } } }
}

const withArgs = (req: ReturnType<typeof submission>['req'], patch: Record<string, unknown>) =>
  ({ ...req, action: { tool: 'refund', args: { ...req.action.args, ...patch } } })

/** Delivers a handoff straight to the simulator, as a duplicated or replayed network delivery would. */
async function deliver(env: ProfileEnv, path: 'execute' | 'reconcile', handoff: unknown, url = env.sim.url) {
  const res = await fetch(`${url}/refund-execution/0.1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.apiKey}` }, body: JSON.stringify(handoff),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

test('RE-a one operation, one effect, provider_confirmed; native result bytes recoverable from the store', async () => {
  const env = await setupProfile()
  try {
    const { req, handoff } = submission(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'provider_confirmed', JSON.stringify(r))
    const effects = env.sim.effects()
    assert.equal(effects.length, 1)
    assert.deepEqual([effects[0].payment_id, effects[0].currency, effects[0].amount_minor], ['pay_A', 'EUR', 4000])
    assert.equal((r as { provider_ref?: string }).provider_ref, effects[0].effect_ref)
    const prov = env.rt.provenance(req.operation_id) as any
    assert.deepEqual(prov.admissions[0].claims.filter((c: any) => c.requirement === 'required').map((c: any) => [c.claim, c.status]),
      REQUIRED_CLAIMS.map(c => [c, 'established']))
    const stored = env.rt.store.evidence(req.operation_id, EXECUTOR, 'execute:1')!
    assert.equal(env.sim.sent.length, 1)
    assert.deepEqual(Buffer.from(stored), Buffer.from(env.sim.sent[0].bytes))
    const native = JSON.parse(Buffer.from(stored).toString('utf8'))
    assert.equal(native.schema, 'refund-execution-result/0.1')
    assert.equal(native.operation_id, req.operation_id)
    assert.equal(native.status, 'observed_success')
    assert.equal(native.effect_ref, effects[0].effect_ref)
    assert.equal(native.arguments_digest, argumentsDigest(handoff.arguments))
    assert.ok(typeof native.attempt_id === 'string' && native.attempt_id.length > 0)
  } finally { await env.close() }
})

test('RE-b duplicate delivery produces no second effect', async () => {
  const env = await setupProfile()
  try {
    const { req, handoff } = submission(env)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    // Port-level resubmission of a confirmed operation replays without dispatch.
    const again = await env.rt.submit(req)
    assert.equal(again.status, 'provider_confirmed')
    assert.equal((again as { replayed?: boolean }).replayed, true)
    assert.equal(env.sim.executeRequests, 1)
    // The same handoff delivered twice more, concurrently, straight to the endpoint.
    const [d1, d2] = await Promise.all([deliver(env, 'execute', handoff), deliver(env, 'execute', handoff)])
    const first = env.sim.effects()[0]
    for (const d of [d1, d2]) {
      assert.equal(d.status, 200)
      assert.equal(d.body.status, 'observed_success')
      assert.equal(d.body.effect_ref, first.effect_ref)
    }
    assert.notEqual(d1.body.attempt_id, d2.body.attempt_id)
    assert.equal(env.sim.effects().length, 1)
    assert.equal(env.sim.duplicatesSuppressed, 2)
  } finally { await env.close() }
})

test('RE-c retry with changed nested arguments refused; one effect total', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'pre_dispatch_failure', count: 1 })
    const { req, handoff } = submission(env)
    assert.equal((await env.rt.submit(req)).status, 'failed')
    const before = env.sim.executeRequests + env.sim.reconcileRequests
    for (const patch of [{ amount_minor: 3900 }, { amount_minor: 4100 }, { payment_id: 'pay_B' }, { currency: 'USD' }]) {
      const r = await env.rt.submit(withArgs(req, { arguments: { ...handoff.arguments, ...patch } }))
      assert.equal(r.status, 'refused', JSON.stringify(patch))
      assert.deepEqual(reasonsOf(r), ['operation_id_reused_for_different_action'], JSON.stringify(patch))
    }
    assert.equal(env.sim.executeRequests + env.sim.reconcileRequests, before)
    // The endpoint's own binding also fails closed for the same operation id with other arguments.
    const direct = await deliver(env, 'execute', { ...handoff, arguments: { ...handoff.arguments, amount_minor: 3900 } })
    assert.equal(direct.status, 409)
    assert.equal(env.sim.effects().length, 0)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    assert.equal(env.sim.effects().length, 1)
    assert.equal(env.sim.effects()[0].amount_minor, 4000)
  } finally { await env.close() }
})

test('RE-d retry with changed approval_ref, pic_evidence_ref or aps_evidence_ref refused, each separately; one effect total', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'pre_dispatch_failure', count: 1 })
    const { req } = submission(env)
    assert.equal((await env.rt.submit(req)).status, 'failed')
    const before = env.sim.executeRequests + env.sim.reconcileRequests
    const other = env.operator.issue(APPROVED_REFUND)
    const cases: [string, ReturnType<typeof withArgs>][] = [
      ['approval_ref', withArgs(req, { approval_ref: other.approval_id })],
      ['approval_ref with matching approval_id and evidence', { ...withArgs(req, { approval_ref: other.approval_id }), approval_id: other.approval_id, evidence: { [ADMISSION]: other.evidence } }],
      ['pic_evidence_ref', withArgs(req, { pic_evidence_ref: 'pic-correlation:synthetic:other' })],
      ['aps_evidence_ref', withArgs(req, { aps_evidence_ref: 'aps-admission:other' })],
    ]
    for (const [name, changed] of cases) {
      const r = await env.rt.submit(changed)
      assert.equal(r.status, 'refused', `${name}: ${JSON.stringify(r)}`)
      assert.deepEqual(reasonsOf(r), ['operation_id_reused_for_different_action'], name)
    }
    assert.equal(env.sim.executeRequests + env.sim.reconcileRequests, before)
    assert.equal(env.rt.store.approvalConsumedBy(other.approval_id), undefined)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    assert.equal(env.sim.effects().length, 1)
  } finally { await env.close() }
})

test('RE-e pre-dispatch failure gives failed retriable; the retry succeeds with one effect', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'pre_dispatch_failure', count: 1 })
    const { req } = submission(env)
    const r1 = await env.rt.submit(req)
    assert.equal(r1.status, 'failed', JSON.stringify(r1))
    assert.equal(env.rt.store.getOperation(req.operation_id)!.retriable, 1)
    assert.equal(env.sim.effects().length, 0)
    const native1 = JSON.parse(Buffer.from(env.rt.store.evidence(req.operation_id, EXECUTOR, 'execute:1')!).toString('utf8'))
    assert.equal(native1.status, 'observed_failure')
    assert.equal(native1.effect_ref, null)
    const r2 = await env.rt.submit(req)
    assert.equal(r2.status, 'provider_confirmed', JSON.stringify(r2))
    assert.equal(env.sim.effects().length, 1)
    // Attempt 2 reconciled first (no effect recorded), then dispatched once.
    assert.equal(env.sim.reconcileRequests, 1)
    assert.equal(env.sim.executeRequests, 2)
    const prov = env.rt.provenance(req.operation_id) as any
    assert.deepEqual(prov.attempts.map((a: any) => [a.outcome, a.retriable]), [['failed', 1], ['provider_confirmed', 0]])
  } finally { await env.close() }
})

test('RE-f response lost after the effect gives unknown; a later retry reconciles to provider_confirmed with no second effect', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'drop_after_commit', count: 1 })
    const { req, handoff } = submission(env)
    const r1 = await env.rt.submit(req)
    assert.equal(r1.status, 'unknown', JSON.stringify(r1))
    assert.equal(env.sim.effects().length, 1)
    const effect = env.sim.effects()[0]
    const r2 = await env.rt.submit(req)
    assert.equal(r2.status, 'provider_confirmed', JSON.stringify(r2))
    assert.equal((r2 as { provider_ref?: string }).provider_ref, effect.effect_ref)
    assert.equal(env.sim.effects().length, 1)
    assert.equal(env.sim.executeRequests, 1)
    assert.equal(env.sim.reconcileRequests, 1)
    const native2 = JSON.parse(Buffer.from(env.rt.store.evidence(req.operation_id, EXECUTOR, 'execute:2')!).toString('utf8'))
    assert.equal(native2.status, 'observed_success')
    assert.match(native2.attempt_id, /\/reconcile\//)
    // The binding and the effect survive an endpoint restart on the same store file.
    await env.sim.close()
    env.sim = await startExecutionSimulator({ apiKey: env.apiKey, dbPath: join(env.dir, 'sim.db') })
    const rec = await deliver(env, 'reconcile', handoff)
    assert.equal(rec.body.status, 'observed_success')
    assert.equal(rec.body.effect_ref, effect.effect_ref)
    assert.equal(env.sim.effects().length, 1)
  } finally { await env.close() }
})

test('RE-f2 unresolved after a committed effect gives unknown; the retry confirms with no second effect', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'unresolved_after_commit', count: 1 })
    const { req } = submission(env)
    const r1 = await env.rt.submit(req)
    assert.equal(r1.status, 'unknown', JSON.stringify(r1))
    assert.equal(env.rt.store.getOperation(req.operation_id)!.state, 'unknown')
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    assert.equal(env.sim.effects().length, 1)
    assert.equal(env.sim.executeRequests, 1)
  } finally { await env.close() }
})

test('RE-g a result with the wrong arguments_digest is not mapped to success', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'wrong_arguments_digest', count: 1 })
    const { req } = submission(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'unknown', JSON.stringify(r))
    assert.match(String((r as { reason?: string }).reason), /result_invalid:arguments_digest_differs/)
    assert.equal(env.rt.store.getOperation(req.operation_id)!.state, 'unknown')
    // The native bytes are still kept for inspection.
    const native = JSON.parse(Buffer.from(env.rt.store.evidence(req.operation_id, EXECUTOR, 'execute:1')!).toString('utf8'))
    assert.equal(native.status, 'observed_success')
  } finally { await env.close() }
})

test('RE-h a result naming a different operation_id is not mapped to success', async () => {
  const env = await setupProfile()
  try {
    env.sim.setFault({ mode: 'wrong_operation_id', count: 1 })
    const { req } = submission(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'unknown', JSON.stringify(r))
    assert.match(String((r as { reason?: string }).reason), /result_invalid:operation_id_differs/)
    assert.equal(env.rt.store.getOperation(req.operation_id)!.state, 'unknown')
  } finally { await env.close() }
})

test('RE-i the PIC claim is reported not_established with a reason, never established', async () => {
  const env = await setupProfile()
  try {
    const { req } = submission(env)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    const prov = env.rt.provenance(req.operation_id) as any
    const pic = prov.admissions[0].claims.find((c: any) => c.claim === 'pic.verified')
    assert.equal(pic.requirement, 'optional')
    assert.equal(pic.status, 'not_established')
    assert.match(pic.reason, /^pic_verification_not_implemented/)
    // Directly, over a valid handoff, a malformed one and one without a PIC reference.
    const check = env.rt.component(ADMISSION)!.adapter.check!
    const s = submission(env)
    const base = { operation_id: s.req.operation_id, workflow: WORKFLOW, approval_id: s.a.approval_id, evidence: s.a.evidence, now: new Date().toISOString() }
    const { pic_evidence_ref: _omit, ...noPic } = s.handoff
    for (const args of [s.handoff, { ...s.handoff, schema: 'other' }, noPic]) {
      const out = await check({ ...base, action: { tool: 'refund', args } })
      const c = out.claims.find(x => x.claim === 'pic.verified')!
      assert.equal(c.status, 'not_established')
      assert.ok(c.reason && c.reason.startsWith('pic_verification_not_implemented'))
    }
  } finally { await env.close() }
  // A workflow that requires PIC therefore admits nothing.
  const strict = await setupProfile({ requirePic: true })
  try {
    const r = await strict.rt.submit(submission(strict).req)
    assert.equal(r.status, 'refused')
    assert.ok(reasonsOf(r).some(x => x.startsWith(`required_claim_not_established:${ADMISSION}#pic.verified:pic_verification_not_implemented`)), JSON.stringify(r))
    assert.equal(strict.sim.executeRequests, 0)
  } finally { await strict.close() }
})

test('RE-j OPEN POLICY QUESTION (from the contract, not a decision): second distinct approval for the same tuple; records current behaviour, asserts only that it is deterministic', async t => {
  const runOnce = async () => {
    const env = await setupProfile()
    try {
      const r1 = await env.rt.submit(submission(env).req)
      const r2 = await env.rt.submit(submission(env).req)
      return { first: r1.status, second: r2.status, second_reasons: reasonsOf(r2), effects: env.sim.effects().length }
    } finally { await env.close() }
  }
  const a = await runOnce()
  const b = await runOnce()
  t.diagnostic(`observed today, not a policy decision: ${JSON.stringify(a)}`)
  assert.deepEqual(a, b)
})

test('a retry of a provider_confirmed operation with changed SubmitRequest.evidence is refused, not replayed', async () => {
  const env = await setupProfile()
  try {
    const { req } = submission(env)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    const replaced = { ...req, evidence: { [ADMISSION]: new TextEncoder().encode('{"not":"the admitted approval evidence"}') } }
    const r = await env.rt.submit(replaced)
    assert.equal(r.status, 'refused', JSON.stringify(r))
    assert.deepEqual((r as { reasons: string[] }).reasons, ['operation_evidence_changed'])
    // The same evidence still replays the confirmed result.
    const again = await env.rt.submit(req)
    assert.equal(again.status, 'provider_confirmed')
  } finally { await env.close() }
})
