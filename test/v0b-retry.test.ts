// V0b, defect 2 and acceptance 3: an operation id is bound to the workflow, tenant, policy,
// component pins and execution configuration it was admitted under. A retry reuses them or is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CustomerPolicy, WorkflowPolicy } from '../src/runtime/index.ts'
import { startProvider } from '../sim/provider.ts'
import { APPROVED_REFUND } from '../sim/profile.ts'
import { APS, EXEC, FIXTURE, ROOT, pinFromDisk, request, restart, setup } from './helpers.ts'

const reasonsOf = (r: { status: string } & Record<string, unknown>) => (r.reasons as string[] | undefined) ?? []
const fixturePin = (mode: string) => pinFromDisk(join(ROOT, 'test/fixtures/fixture-check'), { config: { mode } })

// ---- Defect 2: workflow switching on retry ----

test('D2a retry of an operation under a different workflow is refused; the original operation still recovers', async () => {
  const env = await setup({ extraComponents: { [FIXTURE]: fixturePin('down') } })
  try {
    const policy = structuredClone(env.policy)
    policy.workflows.strict = { ...policy.workflows.refund, required_claims: [...policy.workflows.refund.required_claims, { component: FIXTURE, claim: 'fixture.ok' }] }
    await restart(env, policy)
    env.policy = policy
    env.provider.setFault({ mode: 'outage', count: 1 })
    const { req } = request(env)
    assert.equal((await env.rt.submit(req)).status, 'failed')
    const switched = await env.rt.submit({ ...req, workflow: 'strict' })
    assert.equal(switched.status, 'refused', JSON.stringify(switched))
    assert.deepEqual(reasonsOf(switched), ['operation_workflow_mismatch'])
    const fresh = await env.rt.submit({ ...request(env).req, workflow: 'strict' })
    assert.equal(fresh.status, 'refused')
    assert.equal(env.provider.refunds.length, 0)
    const recovered = await env.rt.submit(req)
    assert.equal(recovered.status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 1)
    assert.equal(env.rt.store.getOperation(req.operation_id)!.workflow, 'refund')
  } finally { await env.close() }
})

test('D2b retry after the policy, workflow definition, executor configuration or a component pin changed is refused by name', async () => {
  const variants: [string, (p: CustomerPolicy, alt: { url: string }) => void, string][] = [
    ['policy id', p => { p.policy_id = 'customer-policy-v0-test-2' }, 'operation_context_changed:policy_id'],
    ['workflow definition', p => { (p.workflows.refund as WorkflowPolicy).check_timeout_ms = 400 }, 'operation_context_changed:workflow_definition'],
    ['executor configuration', (p, alt) => { p.components[EXEC].config = { base_url: alt.url } }, `operation_context_changed:component_config:${EXEC}`],
    ['checker version', p => {
      // Inside the repo so the copy resolves agent-passport-system from node_modules.
      mkdirSync(join(ROOT, 'test/.tmp'), { recursive: true })
      const dir = join(mkdtempSync(join(ROOT, 'test/.tmp/aps-')), 'c')
      cpSync(join(ROOT, 'adapters/aps-authority'), dir, { recursive: true })
      const mp = join(dir, 'manifest.json')
      const m = JSON.parse(readFileSync(mp, 'utf8'))
      m.artifact.version = '9.9.9'
      writeFileSync(mp, JSON.stringify(m, null, 2) + '\n')
      p.components[APS] = pinFromDisk(dir, { config: p.components[APS].config })
    }, `operation_context_changed:component_pin:${APS}`],
  ]
  for (const [name, change, code] of variants) {
    const env = await setup()
    const alt = await startProvider({ apiKey: env.apiKey })
    try {
      env.provider.setFault({ mode: 'outage', count: 1 })
      const { req } = request(env)
      assert.equal((await env.rt.submit(req)).status, 'failed')
      const original = env.policy
      const changed = structuredClone(original)
      change(changed, alt)
      await restart(env, changed)
      const r = await env.rt.submit(req)
      assert.equal(r.status, 'refused', `${name}: ${JSON.stringify(r)}`)
      assert.ok(reasonsOf(r).includes(code), `${name}: ${JSON.stringify(r)}`)
      assert.equal(alt.requests, 0, name)
      await restart(env, original)
      assert.equal((await env.rt.submit(req)).status, 'provider_confirmed', name)
      assert.equal(env.provider.refunds.length, 1, name)
    } finally { await env.close(); await alt.close() }
  }
  rmSync(join(ROOT, 'test/.tmp'), { recursive: true, force: true })
})

// ---- Acceptance 3: retry with a changed request ----

test('A3 retry with changed payment, amount, currency, tenant or workflow refused; recovery keeps the original operation', async () => {
  const env = await setup()
  try {
    const policy = structuredClone(env.policy)
    policy.workflows.refund_alt = { ...policy.workflows.refund }
    await restart(env, policy)
    env.policy = policy
    env.provider.setFault({ mode: 'outage', count: 1 })
    const { req: base } = request(env)
    const req = { ...base, tenant: 'tenant-a' }
    assert.equal((await env.rt.submit(req)).status, 'failed')
    const stored = env.rt.store.getOperation(req.operation_id)!
    const requestsAfterOutage = env.provider.requests
    const args = (x: Record<string, unknown>) => ({ ...req, action: { tool: 'refund', args: { ...APPROVED_REFUND, ...x } } })
    const cases: [string, Record<string, unknown>, string][] = [
      ['payment', args({ payment_id: 'pay_B' }), 'operation_id_reused_for_different_action'],
      ['amount', args({ amount_minor: 3900 }), 'operation_id_reused_for_different_action'],
      ['currency', args({ currency: 'USD' }), 'operation_id_reused_for_different_action'],
      ['tenant', { ...req, tenant: 'tenant-b' }, 'operation_tenant_mismatch'],
      ['tenant omitted', { ...req, tenant: undefined }, 'operation_tenant_mismatch'],
      ['workflow', { ...req, workflow: 'refund_alt' }, 'operation_workflow_mismatch'],
    ]
    for (const [name, changed, code] of cases) {
      const r = await env.rt.submit(changed as any)
      assert.equal(r.status, 'refused', `${name}: ${JSON.stringify(r)}`)
      assert.deepEqual(reasonsOf(r), [code], name)
    }
    assert.equal(env.provider.requests, requestsAfterOutage)
    assert.deepEqual(env.rt.store.getOperation(req.operation_id), stored)
    const recovered = await env.rt.submit(req)
    assert.equal(recovered.status, 'provider_confirmed')
    assert.equal(env.provider.refunds.length, 1)
    const prov = env.rt.provenance(req.operation_id) as any
    assert.equal(prov.admissions.length, 1)
    assert.deepEqual(prov.attempts.map((x: any) => x.outcome), ['failed', 'provider_confirmed'])
    assert.equal(env.rt.store.getOperation(req.operation_id)!.tenant, 'tenant-a')
  } finally { await env.close() }
})
