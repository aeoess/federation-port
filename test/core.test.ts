// Core runtime cases, written before the second adapter. Uses the APS authority component,
// the simulator's execution component and a test fixture component.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Runtime, LoadError, artifactDigest, digestJson } from '../src/runtime/index.ts'
import { APPROVED_REFUND } from '../sim/profile.ts'
import { APS, APS_CLAIMS, EXEC, FIXTURE, ROOT, buildPolicy, copyComponent, opId, pinFromDisk, request, setup, tmp } from './helpers.ts'

const run = promisify(execFile)
const fixturePin = (mode: string) => pinFromDisk(join(ROOT, 'test/fixtures/fixture-check'), { config: { mode } })
const reasonsOf = (r: { status: string } & Record<string, unknown>) => (r.reasons as string[] | undefined) ?? []

test('C01 exact EUR 40.00 pay_A request: admitted, one refund, one usage row per component', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 1)
    assert.deepEqual(env.provider.refunds[0].amount_minor, 4000)
    const usage = env.rt.store.usage(req.operation_id)
    assert.deepEqual(usage.map(u => [u.component, u.calls, u.outcome]), [[APS, 1, 'evaluated'], [EXEC, 1, 'provider_confirmed']])
    const prov = env.rt.provenance(req.operation_id) as any
    assert.equal(prov.state, 'provider_confirmed')
    assert.equal(prov.admissions.length, 1)
    assert.equal(prov.admissions[0].decision, 'admitted')
    assert.deepEqual(prov.admissions[0].claims.map((c: any) => c.status), APS_CLAIMS.map(() => 'established'))
    assert.deepEqual(prov.admissions[0].components.map((c: any) => c.id), [APS, EXEC])
    assert.equal(prov.attempts.length, 1)
    // Native evidence bytes are kept byte-for-byte, provenance holds only their digest.
    const stored = env.rt.store.evidence(req.operation_id, APS, 'check:0')!
    assert.deepEqual(Buffer.from(stored), Buffer.from(req.evidence[APS]))
    const json = JSON.stringify(prov)
    for (const leak of ['pay_A', 'amount_minor', 'EUR', env.apiKey]) assert.ok(!json.includes(leak), `provenance leaks ${leak === env.apiKey ? 'secret' : leak}`)
  } finally { await env.close() }
})

for (const [name, args] of [
  ['amount 3900', { ...APPROVED_REFUND, amount_minor: 3900 }],
  ['amount 4100', { ...APPROVED_REFUND, amount_minor: 4100 }],
  ['payment pay_B', { ...APPROVED_REFUND, payment_id: 'pay_B' }],
  ['currency USD', { ...APPROVED_REFUND, currency: 'USD' }],
] as const) {
  test(`C02 altered ${name}: refused before any provider request`, async () => {
    const env = await setup()
    try {
      // v2: approval for the exact refund, args altered.
      const { req } = request(env, { ...args })
      const r = await env.rt.submit(req)
      assert.equal(r.status, 'refused')
      assert.ok(reasonsOf(r).some(x => x.includes('approval.binds_exact_action')), JSON.stringify(r))
      // v1: the worker also presents an action-ref input recomputed for the altered args.
      const a = env.operator.issue(APPROVED_REFUND)
      const forgedInput = env.operator.issue(args as unknown as typeof APPROVED_REFUND).input
      const mixed = new TextEncoder().encode(JSON.stringify({ input: forgedInput, approval: a.approval }))
      const r2 = await env.rt.submit({ ...req, operation_id: opId(), approval_id: a.approval_id, evidence: { [APS]: mixed } })
      assert.equal(r2.status, 'refused')
      assert.ok(reasonsOf(r2).some(x => x.includes('approval.binds_exact_action:action_ref_mismatch')), JSON.stringify(r2))
      assert.equal(env.provider.requests, 0)
      assert.equal(env.rt.store.countDispatches(), 0)
    } finally { await env.close() }
  })
}

test('C03 missing, invalid, foreign, expired and narrow authority: refused, nothing consumed', async () => {
  const env = await setup()
  try {
    const base = request(env).req
    const noId = await env.rt.submit({ ...base, operation_id: opId(), approval_id: undefined })
    assert.deepEqual(reasonsOf(noId), ['approval_id_missing'])

    const noEvidence = await env.rt.submit({ ...base, operation_id: opId(), evidence: {} })
    assert.equal(noEvidence.status, 'refused')
    assert.ok(reasonsOf(noEvidence).every(x => x.startsWith('required_claim_not_established') && x.endsWith('no_approval_evidence')))

    const forged = env.operator.issue(APPROVED_REFUND, { forge: true })
    const rf = await env.rt.submit({ ...base, operation_id: opId(), approval_id: forged.approval_id, evidence: { [APS]: forged.evidence } })
    assert.ok(reasonsOf(rf).some(x => x.startsWith(`required_claim_not_established:${APS}#approval.signature_valid:approval_invalid`)), JSON.stringify(rf))

    const garbage = await env.rt.submit({ ...base, operation_id: opId(), evidence: { [APS]: new TextEncoder().encode('{not json') } })
    assert.ok(reasonsOf(garbage).every(x => x.startsWith('required_claim_failed')))

    const other = env.operator.issue({ ...APPROVED_REFUND, payment_id: 'pay_B' })
    const ro = await env.rt.submit({ ...base, operation_id: opId(), approval_id: other.approval_id, evidence: { [APS]: other.evidence } })
    assert.ok(reasonsOf(ro).some(x => x.includes('approval.binds_exact_action')))

    const idSwap = await env.rt.submit({ ...base, operation_id: opId(), approval_id: other.approval_id })
    assert.ok(reasonsOf(idSwap).some(x => x.includes('approval.id_matches_request')))

    const expired = env.operator.issue(APPROVED_REFUND, { issuedAt: new Date(Date.now() - 120_000), ttlMs: 60_000 })
    const re = await env.rt.submit({ ...base, operation_id: opId(), approval_id: expired.approval_id, evidence: { [APS]: expired.evidence } })
    assert.deepEqual(reasonsOf(re), [`required_claim_not_established:${APS}#approval.unexpired:approval_expired`])

    const narrow = env.operator.issue(APPROVED_REFUND, { verdict: 'narrow', constraints: ['refund:requires-second-operator-confirmation'] })
    const rn = await env.rt.submit({ ...base, operation_id: opId(), approval_id: narrow.approval_id, evidence: { [APS]: narrow.evidence } })
    assert.deepEqual(reasonsOf(rn), [`required_claim_unsupported:${APS}#approval.permit_verdict:verdict:narrow`])

    assert.equal(env.provider.requests, 0)
    // Refusals consume nothing: the untouched base approval still admits once.
    const ok = await env.rt.submit(base)
    assert.equal(ok.status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 1)
  } finally { await env.close() }
})

test('C04 repeated admission: same approval under a new operation id refused; same operation id replays without dispatch', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    const again = await env.rt.submit({ ...req, operation_id: opId() })
    assert.deepEqual(reasonsOf(again), ['approval_already_consumed'])
    const replay = await env.rt.submit(req)
    assert.equal(replay.status, 'provider_confirmed')
    assert.equal((replay as any).replayed, true)
    assert.equal(env.provider.requests, 1)
    assert.equal(env.provider.refunds.length, 1)
    assert.equal(env.rt.store.countDispatches(), 1)
    const changed = await env.rt.submit({ ...req, action: { tool: 'refund', args: { ...APPROVED_REFUND, amount_minor: 3900 } } })
    assert.deepEqual(reasonsOf(changed), ['operation_id_reused_for_different_action'])
  } finally { await env.close() }
})

test('C05 concurrent submissions of one approval in one process: exactly one dispatch', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    const rs = await Promise.all(Array.from({ length: 12 }, () => env.rt.submit({ ...req, operation_id: opId() })))
    assert.equal(rs.filter(r => r.status === 'provider_confirmed').length, 1)
    assert.equal(rs.filter(r => r.status === 'refused' && reasonsOf(r)[0] === 'approval_already_consumed').length, 11)
    assert.equal(env.provider.refunds.length, 1)
    assert.equal(env.rt.store.countDispatches(), 1)
  } finally { await env.close() }
})

test('C06 concurrent submissions of one approval from 6 OS processes sharing the store: exactly one dispatch', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    const job = join(tmp(), 'job.json')
    const evidence = Object.fromEntries(Object.entries(req.evidence).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
    writeFileSync(job, JSON.stringify({ policy: env.policy, dbPath: env.dbPath, goAt: Date.now() + 1500, request: { ...req, evidence } }))
    const worker = join(ROOT, 'test/fixtures/concurrent-worker.ts')
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      run(process.execPath, ['--disable-warning=ExperimentalWarning', worker, job, String(i)], { env: { ...process.env, FP_PROVIDER_KEY: env.apiKey } })))
    const rs = outs.map(o => JSON.parse(o.stdout))
    assert.equal(rs.filter(r => r.status === 'provider_confirmed').length, 1, JSON.stringify(rs))
    assert.equal(rs.filter(r => r.status === 'refused' && r.reasons[0] === 'approval_already_consumed').length, 5, JSON.stringify(rs))
    assert.equal(env.provider.refunds.length, 1)
    assert.equal(env.provider.requests, 1)
  } finally { await env.close() }
})

test('C07 tool definition changed after pinning (declared): load refused, or submit refused before dispatch', async () => {
  const env = await setup()
  try {
    // (a) the execution component's manifest on disk now declares a different tool definition.
    const dir = copyComponent('sim/executor')
    const pinned = pinFromDisk(dir, { config: { base_url: env.provider.url } })
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.tools[0].input_schema.properties.amount_minor.minimum = 0
    m.tools[0].input_schema.additionalProperties = true
    writeFileSync(mp, JSON.stringify(m, null, 2))
    const policy = buildPolicy(env.operator, env.provider.url, { overrides: { [EXEC]: pinned } })
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'manifest_changed')

    // (b) a loaded component starts describing a different tool after pinning.
    const exec = env.rt.component(EXEC)!
    const original = exec.adapter.describe
    const drifted = structuredClone(original())
    drifted.tools![0].description = 'Refund any amount.'
    exec.adapter.describe = () => drifted
    const { req } = request(env)
    const r = await env.rt.submit(req)
    assert.deepEqual(reasonsOf(r), [`manifest_changed_since_pin:${EXEC}`])
    assert.equal(env.provider.requests, 0)
    exec.adapter.describe = original
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
  } finally { await env.close() }
})

test('C08 required component down: refused; optional component down: proceeds with claim recorded unevaluated', async () => {
  for (const mode of ['down', 'hang']) {
    const env = await setup({ extraComponents: { [FIXTURE]: fixturePin(mode) },
      required: [...APS_CLAIMS.map(claim => ({ component: APS, claim })), { component: FIXTURE, claim: 'fixture.ok' }] })
    try {
      const { req } = request(env)
      const r = await env.rt.submit(req)
      assert.equal(r.status, 'refused')
      assert.ok(reasonsOf(r).some(x => x.startsWith(`required_claim_unavailable:${FIXTURE}#fixture.ok:component_unavailable`)), JSON.stringify(r))
      assert.equal(env.provider.requests, 0)
    } finally { await env.close() }
  }
  const env = await setup({ extraComponents: { [FIXTURE]: fixturePin('down') }, optional: [{ component: FIXTURE, claim: 'fixture.ok' }] })
  try {
    const { req } = request(env)
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'provider_confirmed')
    const claims = (env.rt.provenance(req.operation_id) as any).admissions[0].claims
    assert.deepEqual(claims.find((c: any) => c.component === FIXTURE), {
      component: FIXTURE, claim: 'fixture.ok', requirement: 'optional', status: 'unevaluated', reason: 'component_unavailable:fixture_component_down' })
  } finally { await env.close() }
})

test('C09 provider response lost after the side effect: unknown, then retry with the same operation id gives one refund and one usage record', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    const first = await env.rt.submit(req)
    assert.equal(first.status, 'unknown')
    assert.equal(env.provider.refunds.length, 1) // the side effect happened
    const second = await env.rt.submit(req)
    assert.equal(second.status, 'provider_confirmed')
    assert.equal(second.provider_ref, env.provider.refunds[0].refund_id)
    assert.equal(env.provider.refunds.length, 1)
    const execUsage = env.rt.store.usage(req.operation_id).filter(u => u.component === EXEC)
    assert.equal(execUsage.length, 1)
    assert.equal(execUsage[0].calls, 2)
    assert.equal(execUsage[0].outcome, 'provider_confirmed')
    assert.equal(env.rt.store.usage(req.operation_id).length, 2)
    const prov = env.rt.provenance(req.operation_id) as any
    assert.deepEqual(prov.attempts.map((a: any) => a.outcome), ['unknown', 'provider_confirmed'])
    assert.equal(prov.admissions.length, 1)
  } finally { await env.close() }
})

test('C10 slow response past the timeout is unknown, retry confirms the same refund; outage is failed-retriable', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    env.provider.setFault({ mode: 'slow', count: 1, delay_ms: 1500 })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 1)

    const env2 = request(env, { ...APPROVED_REFUND, payment_id: 'pay_B' }, { ...APPROVED_REFUND, payment_id: 'pay_B' }).req
    env.provider.setFault({ mode: 'outage', count: 1 })
    const out = await env.rt.submit(env2)
    assert.equal(out.status, 'failed')
    assert.equal(env.provider.refunds.length, 1)
    assert.equal((await env.rt.submit(env2)).status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 2)

    const env3 = request(env, { ...APPROVED_REFUND, payment_id: 'pay_B', amount_minor: 100 }, { ...APPROVED_REFUND, payment_id: 'pay_B', amount_minor: 100 }).req
    env.provider.setFault({ mode: 'slow', count: 1, delay_ms: 200 })
    assert.equal((await env.rt.submit(env3)).status, 'provider_confirmed')
    assert.equal(env.rt.store.usage(env3.operation_id).find(u => u.component === EXEC)!.calls, 1)
  } finally { await env.close() }
})

test('C11 privilege escalation in a manifest refused at load', async () => {
  const env = await setup()
  try {
    // A new version of the authority component asks for the provider secret and network access.
    const dir = copyComponent('adapters/aps-authority')
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.artifact.version = '0.2.0'
    m.privileges_requested = ['secret:provider_api_key']
    m.data_destinations = ['http://127.0.0.1:*']
    writeFileSync(mp, JSON.stringify(m, null, 2))
    const oldPin = env.policy.components[APS]
    // Old pin kept: the changed manifest no longer matches.
    let policy = buildPolicy(env.operator, env.provider.url, { overrides: { [APS]: { ...oldPin, path: dir } } })
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'manifest_changed')
    // Customer re-pins the new version but does not widen the grant.
    const repinned = { ...pinFromDisk(dir), config: oldPin.config, privileges_granted: [], destinations_allowed: [] }
    policy = buildPolicy(env.operator, env.provider.url, { overrides: { [APS]: repinned } })
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'privileges_exceed_grant')
    // Grant widened for privileges only: destinations still refused.
    policy = buildPolicy(env.operator, env.provider.url, { overrides: { [APS]: { ...repinned, privileges_granted: ['secret:provider_api_key'] } } })
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'destinations_exceed_grant')
  } finally { await env.close() }
})

test('C12 artifact changed after pinning refused at load', async () => {
  const env = await setup()
  try {
    const dir = copyComponent('adapters/aps-authority')
    const pin = { ...pinFromDisk(dir), config: env.policy.components[APS].config }
    writeFileSync(join(dir, 'adapter.ts'), readFileSync(join(dir, 'adapter.ts'), 'utf8') + '\n// changed\n')
    const policy = buildPolicy(env.operator, env.provider.url, { overrides: { [APS]: pin } })
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'artifact_digest_mismatch')
    // Resealed manifest, old pin: still refused.
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.artifact.digest = artifactDigest(dir, m.artifact.files)
    writeFileSync(mp, JSON.stringify(m))
    assert.notEqual(digestJson(m), pin.manifest_digest)
    await assert.rejects(Runtime.create({ policy, dbPath: join(tmp(), 'p.db'), secrets: { provider_api_key: env.apiKey } }),
      (e: unknown) => e instanceof LoadError && e.code === 'manifest_changed')
  } finally { await env.close() }
})

test('C13 evidence rule: no cross-component mapping, no missing check turned into success, no undeclared claims', async () => {
  // Fixture declares a claim named approval.signature_valid and reports it established.
  // The policy requires the APS component's claim of that name; the APS check gets no evidence.
  let env = await setup({ extraComponents: { [FIXTURE]: fixturePin('ok') }, optional: [{ component: FIXTURE, claim: 'approval.signature_valid' }] })
  try {
    const { req } = request(env)
    const r = await env.rt.submit({ ...req, evidence: { [FIXTURE]: req.evidence[APS] } })
    assert.equal(r.status, 'refused')
    assert.ok(reasonsOf(r).includes(`required_claim_not_established:${APS}#approval.signature_valid:no_approval_evidence`), JSON.stringify(r))
  } finally { await env.close() }

  for (const [mode, expect] of [['empty', 'claim_not_reported'], ['undeclared', null], ['bad_status', 'adapter_protocol_violation:status'], ['not_bytes', 'adapter_protocol_violation:shape']] as const) {
    env = await setup({ extraComponents: { [FIXTURE]: fixturePin(mode) },
      required: [{ component: APS, claim: 'approval.signature_valid' }, { component: FIXTURE, claim: 'fixture.ok' }] })
    try {
      const { req } = request(env)
      const r = await env.rt.submit(req)
      if (expect === null) {
        // Declared claim counted; the undeclared one is ignored, never surfaced as a claim.
        assert.equal(r.status, 'provider_confirmed')
        const claims = (env.rt.provenance(req.operation_id) as any).admissions[0].claims
        assert.ok(!JSON.stringify(claims).includes('something.else'))
      } else {
        assert.equal(r.status, 'refused', mode)
        assert.deepEqual(reasonsOf(r), [`required_claim_unavailable:${FIXTURE}#fixture.ok:${expect}`])
      }
    } finally { await env.close() }
  }
})

test('C14 consumption survives a runtime restart on the same store', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    assert.equal((await env.rt.submit(req)).status, 'unknown')
    env.rt.close()
    const rt2 = await Runtime.create({ policy: env.policy, dbPath: env.dbPath, secrets: { provider_api_key: env.apiKey } })
    try {
      assert.deepEqual(reasonsOf(await rt2.submit({ ...req, operation_id: opId() }) as any), ['approval_already_consumed'])
      assert.equal((await rt2.submit(req)).status, 'provider_confirmed')
      assert.equal(env.provider.refunds.length, 1)
    } finally { rt2.close() }
  } finally { await env.provider.close() }
})

test('C15 args outside the pinned tool schema refused before checks', async () => {
  const env = await setup()
  try {
    const { req } = request(env, { ...APPROVED_REFUND, amount_minor: '4000', note: 'x' })
    const r = await env.rt.submit(req)
    assert.deepEqual(reasonsOf(r).sort(), ['args_schema:$.amount_minor:type', 'args_schema:$.note:additional'])
    assert.equal(env.rt.store.usage(req.operation_id).length, 0)
  } finally { await env.close() }
})
