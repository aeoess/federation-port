// A confirmation is final even when it arrives after another worker took over the attempt's
// lease, and adapter reasons stored in provenance are bounded. Reproduces the outside contract
// probes CP-F1 and CP-F3 (REMORA-research, integrations/federation-port/contract-probes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Runtime } from '../src/runtime/index.ts'
import { APPROVED_REFUND } from '../sim/profile.ts'
import { APS, EXEC, opId, request, restart, setup } from './helpers.ts'
import type { ExecuteOp, ExecuteOutput } from '../src/contract/types.ts'

test('E1 a confirmation from an attempt whose lease another worker took over is final: the operation is confirmed, not failed', async () => {
  const env = await setup()
  try {
    const T0 = new Date(Date.now() - 1000)
    const nowA = new Date(T0.getTime() + 500)
    await restart(env, env.policy, () => nowA)
    const a = env.operator.issue(APPROVED_REFUND, { issuedAt: T0, ttlMs: 60_000 })
    const req = { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: a.evidence } }
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(ok => { release = ok }), inside = new Promise<void>(ok => { entered = ok })
    const ca = env.rt.component(EXEC)!
    const originalA = ca.adapter.execute!.bind(ca.adapter)
    ca.adapter.execute = async op => { entered(); await gate; return originalA(op) }
    const fromA = env.rt.submit(req)
    await inside
    // Worker B, 2.5 s ahead (clock skew), finds the lease expired; its own request never arrives.
    const rtB = await Runtime.create({ policy: env.policy, dbPath: env.dbPath, secrets: { provider_api_key: env.apiKey }, clock: () => new Date(nowA.getTime() + 2_500) })
    rtB.component(EXEC)!.adapter.execute = async () => ({ outcome: 'failed', retriable: true, reason: 'provider_unreachable', evidence: new Uint8Array() })
    // B's own attempt never reached the provider, but attempt 1 is still running and may have:
    // the operation is unknown, not failed.
    assert.equal((await rtB.submit(req)).status, 'unknown')
    release()
    const resultA = await fromA
    assert.equal(resultA.status, 'provider_confirmed', JSON.stringify(resultA))
    assert.equal(rtB.store.getOperation(req.operation_id)!.state, 'provider_confirmed')
    // After the deadline the operation replays its confirmation; it is not closed as failed.
    const rtC = await Runtime.create({ policy: env.policy, dbPath: env.dbPath, secrets: { provider_api_key: env.apiKey }, clock: () => new Date(Date.parse(a.valid_until) + 1) })
    const later = await rtC.submit(req)
    assert.equal(later.status, 'provider_confirmed')
    assert.equal((later as { replayed?: boolean }).replayed, true)
    assert.equal(env.provider.refunds.length, 1)
    rtB.close(); rtC.close()
  } finally { await env.close() }
})

test('E2 a claim reason is stored cut to 120 characters, in the result and in provenance', async () => {
  const env = await setup()
  try {
    const c = env.rt.component(APS)!
    const original = c.adapter.check!.bind(c.adapter)
    c.adapter.check = async input => {
      const out = await original(input)
      return { ...out, claims: out.claims.map((x, i) => i === 0 ? { ...x, status: 'not_established' as const, reason: 'r'.repeat(100_000) } : x) }
    }
    const { req } = request(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'refused')
    const claim = (env.rt.provenance(req.operation_id) as { admissions: { claims: { reason?: string }[] }[] }).admissions[0].claims[0]
    assert.equal(claim.reason, 'r'.repeat(120))
    assert.ok(JSON.stringify(env.rt.provenance(req.operation_id)).length < 10_000)
  } finally { await env.close() }
})

test('E3 a lost response, then an outage, then the deadline: the operation stays unknown and resolves to the refund, never closes as failed', async () => {
  const env = await setup()
  let providerUp = true
  try {
    const T0 = new Date(Date.now() - 1000)
    await restart(env, env.policy, () => new Date(T0.getTime() + 500))
    const a = env.operator.issue(APPROVED_REFUND, { issuedAt: T0, ttlMs: 60_000 })
    const req = { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: a.evidence } }
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    // The provider goes down: the retry honestly reports failed and retriable for itself, but
    // attempt 1 may have reached the provider, so the operation stays unknown.
    providerUp = false
    await env.provider.close()
    const retry = await env.rt.submit(req)
    assert.equal(retry.status, 'unknown', JSON.stringify(retry))
    assert.deepEqual(env.rt.store.attempts(req.operation_id).map(x => x.outcome), ['unknown', 'failed'])
    // Past the deadline an unknown operation is retried with the same key, not closed.
    await restart(env, env.policy, () => new Date(Date.parse(a.valid_until) + 1))
    const stillDown = await env.rt.submit(req)
    assert.equal(stillDown.status, 'unknown')
    assert.notEqual((stillDown as { reason?: string }).reason, 'approval_expired_before_retry')
    assert.equal(env.rt.store.getOperation(req.operation_id)!.retriable, 1)
  } finally { if (providerUp) await env.close(); else env.rt.close() }
})

/** Replace the executor's outcome on chosen attempts; other attempts reach the real provider. */
function scriptExecutor(env: Awaited<ReturnType<typeof setup>>, outcomes: Record<number, ExecuteOutput>): void {
  const c = env.rt.component(EXEC)!
  const original = c.adapter.execute!.bind(c.adapter)
  c.adapter.execute = async (op: ExecuteOp) => outcomes[op.attempt] ?? original(op)
}

test('E4 after an unknown attempt, a non-retriable failure does not end the operation as failed', async () => {
  // e.g. a provider that answers a replayed key with 409 "already refunded", which the
  // simulator executor maps to failed and not retriable
  const env = await setup()
  try {
    const { req } = request(env)
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    scriptExecutor(env, { 2: { outcome: 'failed', retriable: false, reason: 'provider_409', evidence: new Uint8Array() } })
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'unknown', JSON.stringify(r))
    const row = env.rt.store.getOperation(req.operation_id)!
    assert.equal(row.state, 'unknown')
    assert.equal(row.retriable, 1)
    assert.deepEqual(env.rt.store.attempts(req.operation_id).map(x => x.outcome), ['unknown', 'failed'])
  } finally { await env.close() }
})

test('E5 an executor reason is stored and returned cut to 120 characters', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    scriptExecutor(env, { 1: { outcome: 'failed', retriable: false, reason: 'x'.repeat(100_000), evidence: new Uint8Array() } })
    const r = await env.rt.submit(req)
    assert.equal((r as { reason?: string }).reason, 'x'.repeat(120))
    assert.equal(env.rt.store.attempts(req.operation_id)[0].reason, 'x'.repeat(120))
    assert.ok(JSON.stringify(env.rt.provenance(req.operation_id)).length < 10_000)
  } finally { await env.close() }
})

test('E6 lost response, outage, recovery: the same key reaches the provider, exactly one refund, provider_confirmed', async () => {
  const env = await setup()
  try {
    const T0 = new Date(Date.now() - 1000)
    await restart(env, env.policy, () => new Date(T0.getTime() + 500))
    const a = env.operator.issue(APPROVED_REFUND, { issuedAt: T0, ttlMs: 60_000 })
    const req = { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: a.evidence } }
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    // The outage: attempt 2 cannot reach the provider. The provider keeps its state.
    scriptExecutor(env, { 2: { outcome: 'failed', retriable: true, reason: 'provider_unreachable', evidence: new Uint8Array() } })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    // Recovery, after the deadline: an unknown operation is retried with the same key.
    await restart(env, env.policy, () => new Date(Date.parse(a.valid_until) + 1))
    const done = await env.rt.submit(req)
    assert.equal(done.status, 'provider_confirmed', JSON.stringify(done))
    assert.equal(env.provider.refunds.length, 1)
    assert.equal(env.provider.refunds[0].idempotency_key, req.operation_id)
    assert.deepEqual(env.rt.store.attempts(req.operation_id).map(x => x.outcome), ['unknown', 'failed', 'provider_confirmed'])
  } finally { await env.close() }
})

