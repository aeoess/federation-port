// Second adapter (tool_admission role), written after the core freeze (tag core-freeze-v0).
// Uses only the published contract; no file under src/ changed for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DEFAULT_TOOL_DEFINITION, startProvider } from '../sim/provider.ts'
import type { SimProvider } from '../sim/provider.ts'
import { APS, APS_CLAIMS, EXEC, ROOT, pinFromDisk, request, setup } from './helpers.ts'
import type { EnvOptions } from './helpers.ts'

const TOOL = 'example.tools/definition-pin-check'
const CLAIM = 'tool.definition_matches_pin'
const PINNED = 'sha256:' + createHash('sha256').update(JSON.stringify(DEFAULT_TOOL_DEFINITION)).digest('hex')
const apsRequired = APS_CLAIMS.map(claim => ({ component: APS, claim }))

async function withTool(as: 'required' | 'optional', definitionUrl?: (p: SimProvider) => string, o: EnvOptions = {}) {
  const apiKey = randomBytes(24).toString('hex')
  const provider = await startProvider({ apiKey })
  const pin = pinFromDisk(join(ROOT, 'adapters/tool-admission'), {
    config: { definition_url: definitionUrl ? definitionUrl(provider) : `${provider.url}/v1/tool-definition`, pinned_sha256: PINNED, tool: 'refund' },
  })
  const ref = { component: TOOL, claim: CLAIM }
  const env = await setup({ apiKey, provider, extraComponents: { [TOOL]: pin },
    required: as === 'required' ? [...apsRequired, ref] : apsRequired, optional: as === 'optional' ? [ref] : [], ...o })
  return { env, async close() { await env.close(); await provider.close() } }
}
const claimOf = (env: Awaited<ReturnType<typeof setup>>, op: string) =>
  (env.rt.provenance(op) as any).admissions.at(-1).claims.find((c: any) => c.component === TOOL)

test('T01 live tool definition equals the pin: admitted, native definition bytes kept as evidence', async () => {
  const t = await withTool('required')
  try {
    const { req } = request(t.env)
    assert.equal((await t.env.rt.submit(req)).status, 'provider_confirmed')
    assert.equal(claimOf(t.env, req.operation_id).status, 'established')
    const ev = t.env.rt.store.evidence(req.operation_id, TOOL, 'check:0')!
    assert.equal(Buffer.from(ev).toString(), JSON.stringify(DEFAULT_TOOL_DEFINITION))
    assert.deepEqual(t.env.rt.store.usage(req.operation_id).map(u => u.component), [APS, TOOL, EXEC].sort())
  } finally { await t.close() }
})

test('T02 provider changes its live tool definition after pinning: refused with the component, admitted without it', async () => {
  const changed = structuredClone(DEFAULT_TOOL_DEFINITION) as any
  changed.input_schema.properties.amount_minor.minimum = 0
  changed.description = 'Refund any amount, including zero.'

  const t = await withTool('required')
  try {
    t.env.provider.setToolDefinition(changed)
    const { req } = request(t.env)
    const r = await t.env.rt.submit(req)
    assert.equal(r.status, 'refused')
    assert.deepEqual((r as any).reasons, [`required_claim_not_established:${TOOL}#${CLAIM}:definition_digest_differs_from_pin`])
    assert.equal(t.env.provider.requests, 0)
  } finally { await t.close() }

  // Core alone: the execution component's manifest did not change, so the runtime has nothing to compare.
  const env = await setup()
  try {
    env.provider.setToolDefinition(changed)
    const { req } = request(env)
    assert.equal((await env.rt.submit(req)).status, 'provider_confirmed')
  } finally { await env.close() }
})

test('T03 tool-admission component down: required refuses, optional proceeds with the claim unevaluated', async () => {
  // A port that was just bound and released, so nothing listens on it.
  const probe = createServer()
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(ok => probe.close(() => ok()))
  const closedPort = () => `http://127.0.0.1:${port}/v1/tool-definition`
  let t = await withTool('required', closedPort)
  try {
    const r = await t.env.rt.submit(request(t.env).req)
    assert.equal(r.status, 'refused')
    assert.ok((r as any).reasons[0].startsWith(`required_claim_unavailable:${TOOL}#${CLAIM}:component_unavailable`), JSON.stringify(r))
    assert.equal(t.env.provider.requests, 0)
  } finally { await t.close() }

  t = await withTool('optional', closedPort)
  try {
    const { req } = request(t.env)
    assert.equal((await t.env.rt.submit(req)).status, 'provider_confirmed')
    const c = claimOf(t.env, req.operation_id)
    assert.equal(c.status, 'unevaluated')
    assert.equal(c.requirement, 'optional')
  } finally { await t.close() }

  // Definition endpoint answering 503: the component ran and reports failed.
  t = await withTool('optional')
  try {
    t.env.provider.setToolFault(true)
    const { req } = request(t.env)
    assert.equal((await t.env.rt.submit(req)).status, 'provider_confirmed')
    assert.deepEqual([claimOf(t.env, req.operation_id).status, claimOf(t.env, req.operation_id).reason], ['failed', 'definition_http_503'])
  } finally { await t.close() }
})

test('T04 definition URL outside the granted destinations: fetch refused, required claim unavailable', async () => {
  const t = await withTool('required', p => p.url.replace('127.0.0.1', 'localhost') + '/v1/tool-definition')
  try {
    const r = await t.env.rt.submit(request(t.env).req)
    assert.equal(r.status, 'refused')
    assert.match((r as any).reasons[0], /component_unavailable:destination_not_granted/)
  } finally { await t.close() }
})
