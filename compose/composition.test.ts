// Composition: four independently written check components gate one synthetic workflow through the
// unmodified runtime. APS (aeoess.aps/exact-approval-authority), invinoveritas (verdict-check),
// NENRIN (conduct-walk-check) and AgentAvow (mcp-tool-admission), all required, plus the sim executor.
//
// Evidence: invinoveritas verdicts and NENRIN walks are the authors' real signed fixtures. The AgentAvow
// attestation is the published payload re-signed by a local test key with its validity window moved to
// the evaluation instant (SYNTHETIC), because the published one expired before the other fixtures were
// signed. agentavow.com is answered locally, no network. The APS approval is issued by the sim operator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { APS, APS_CLAIMS, EXEC, ROOT, pinFromDisk, request, restart, setup } from './helpers.ts'
import { APPROVED_REFUND } from '../sim/profile.ts'
import { PROFILE, SCAN_PATH, jcs } from '../adapters/agentavow-mcp-admission/adapter.ts'

const NOW = new Date('2026-10-07T21:20:00.000Z')
const FX = join(ROOT, 'test/fixtures/compose')
const json = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'))
const bytes = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)))

const INV = 'invinoveritas/verdict-check'
const NEN = 'horizonshield.nenrin/conduct-walk-check'
const AV = 'agentavow.com/mcp-tool-admission'
const CLAIMS: Record<string, string[]> = {
  [APS]: APS_CLAIMS,
  [INV]: ['invinoveritas.verdict_authentic', 'invinoveritas.verdict_covers_action', 'invinoveritas.verdict_permits_action'],
  [NEN]: ['nenrin.walk_authentic', 'nenrin.walk_covers_endpoint', 'nenrin.walk_passed_recently'],
  [AV]: ['agentavow.grade', 'agentavow.tool_definition_binds', 'agentavow.fresh'],
}

// invinoveritas: real verdicts, signed 2026-10-07T21:15:12Z, default max_age_s (900) and accepted verdicts as in their I01.
const VERDICTS = json('verdicts.json')
// NENRIN: real walk of https://gate.horizonshield.dev/a2a by pipavlo82.github.io, walked 2026-10-07T16:14:36Z, default freshness.
const WALKS = json('walks.json').walks
const GATE_A2A = 'https://gate.horizonshield.dev/a2a'
const PAVLO = { 'pipavlo82.github.io': { public_key_ed25519_b64: WALKS.pavlo_gate_a2a.public_key_ed25519_b64, key_url: 'https://pipavlo82.github.io/keys/witness.json' } }
const KUANGMI = { 'kuangmi-bit.github.io': { public_key_ed25519_b64: WALKS.kuangmi_mcp.public_key_ed25519_b64 } }
// AgentAvow: published vectors, payload re-signed locally (SYNTHETIC) with the window [NOW-1h, NOW+23h).
const VEC = json('tool-manifest-digest-v1-vectors.json')
const AV_ENDPOINT = 'https://mcp.deepwiki.com/mcp'
const AV_TOOL = 'ask_wiki_question'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }
const AV_JWK = { kty: pub.kty, crv: pub.crv, x: pub.x, kid: VEC.issuer.jwk.kid }
function avJws(): string {
  const p = JSON.parse(Buffer.from(VEC.attestation.jws.split('.')[1], 'base64url').toString('utf8'))
  p.issuedAt = new Date(NOW.getTime() - 3600_000).toISOString()
  p.expiresAt = new Date(NOW.getTime() + 23 * 3600_000).toISOString()
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: AV_JWK.kid })).toString('base64url')
  const b = Buffer.from(jcs(p), 'utf8').toString('base64url')
  return `${h}.${b}.${edSign(null, Buffer.from(`${h}.${b}`, 'ascii'), privateKey).toString('base64url')}`
}
const JWS = avJws()
const servedTool = () => structuredClone(VEC.observed_tools.find((t: { name: string }) => t.name === AV_TOOL))
const avEvidence = (tool: Record<string, unknown>) => bytes({ profile: PROFILE, endpoint: AV_ENDPOINT, tool })
const realFetch = globalThis.fetch
let scanCalls = 0
test.before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://agentavow.com' && url.pathname === SCAN_PATH) {
      scanCalls++
      return new Response(JSON.stringify({ repo: VEC.attestation.subject.id, trust_score: VEC.attestation.trustScore, jws: JWS, algorithm: 'EdDSA', key_id: AV_JWK.kid }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.origin === 'https://agentavow.com') return new Response('not found', { status: 404 })
    return realFetch(input, init)
  }) as typeof fetch
})
test.after(() => { globalThis.fetch = realFetch })

async function env() {
  const e = await setup({
    extraComponents: {
      [INV]: pinFromDisk(join(ROOT, 'adapters/invinoveritas-verdict'), { config: { accept_verdicts: ['approve', 'approve_with_concerns'] } }),
      [NEN]: pinFromDisk(join(ROOT, 'adapters/nenrin-conduct-walk'), { config: { endpoint: GATE_A2A, trusted_witnesses: { ...PAVLO, ...KUANGMI } } }),
      [AV]: pinFromDisk(join(ROOT, 'adapters/agentavow-mcp-admission'), { config: { endpoint: AV_ENDPOINT, tool_name: AV_TOOL, min_score: 70, jwk: AV_JWK } }),
    },
    required: Object.entries(CLAIMS).flatMap(([component, cs]) => cs.map(claim => ({ component, claim }))),
  })
  await restart(e, e.policy, () => NOW)
  return e
}

type Ev = Partial<Record<string, Uint8Array | null>>
/** A refund submission with all four positive evidences, then `edit` applied (null drops one). */
function submission(e: Awaited<ReturnType<typeof setup>>, edit: Ev = {}, args: Record<string, unknown> = { ...APPROVED_REFUND }, approved = APPROVED_REFUND) {
  const { req } = request(e, args, approved, { issuedAt: NOW, ttlMs: 60_000 })
  const ev = req.evidence as Record<string, Uint8Array>
  ev[INV] = bytes(VERDICTS.approved_refund.event)
  ev[NEN] = bytes(WALKS.pavlo_gate_a2a)
  ev[AV] = avEvidence(servedTool())
  for (const [k, v] of Object.entries(edit)) { if (v === null) delete ev[k]; else ev[k] = v! }
  return req
}
const statuses = (e: Awaited<ReturnType<typeof setup>>, op: string) => {
  const adm = (e.rt.provenance(op) as any).admissions.at(-1)
  const out: Record<string, Record<string, string>> = {}
  for (const c of adm.claims) (out[c.component] ??= {})[c.claim] = c.status
  return { adm, out }
}
const allEstablished = (s: Record<string, Record<string, string>>, except: string[] = []) => {
  for (const [comp, cs] of Object.entries(CLAIMS)) {
    if (except.includes(comp)) continue
    for (const c of cs) assert.equal(s[comp]?.[c], 'established', `${comp}#${c}`)
  }
}

test('C0 all four components establish every required claim: admitted, one dispatch, every component checked and recorded', async () => {
  const e = await env()
  try {
    const req = submission(e)
    const r = await e.rt.submit(req)
    assert.equal(r.status, 'provider_confirmed', JSON.stringify(r))
    const { adm, out } = statuses(e, req.operation_id)
    assert.equal(adm.decision, 'admitted')
    allEstablished(out)
    assert.equal(e.provider.requests, 1)
    assert.deepEqual(e.rt.store.usage(req.operation_id).map((u: any) => u.component).sort(), [APS, AV, EXEC, INV, NEN].sort())
    for (const id of [APS, INV, NEN, AV]) assert.ok(e.rt.store.evidence(req.operation_id, id, 'check:0'), `evidence kept for ${id}`)
  } finally { await e.close() }
})

/** One component gets a genuine negative; the other three stay positive. */
async function oneNegative(name: string, comp: string, make: (e: Awaited<ReturnType<typeof setup>>) => ReturnType<typeof submission>,
  expect: Record<string, string>) {
  const e = await env()
  try {
    const req = make(e)
    const r = await e.rt.submit(req)
    assert.equal(r.status, 'refused', `${name}: ${JSON.stringify(r)}`)
    assert.equal(e.provider.requests, 0, `${name}: no dispatch`)
    const { adm, out } = statuses(e, req.operation_id)
    assert.equal(adm.decision, 'refused')
    allEstablished(out, [comp])
    for (const [claim, status] of Object.entries(expect)) assert.equal(out[comp][claim], status, `${name}: ${comp}#${claim}`)
    const reasons = (r as any).reasons as string[]
    assert.ok(reasons.length > 0 && reasons.every(x => x.includes(`${comp}#`)), `${name}: every reason names ${comp}: ${JSON.stringify(reasons)}`)
    console.log(`# ${name}: ${JSON.stringify(reasons)}`)
  } finally { await e.close() }
}

test('C1 APS negative: the approval was issued for a different refund amount', async () => {
  await oneNegative('C1', APS, e => submission(e, {}, { ...APPROVED_REFUND }, { ...APPROVED_REFUND, amount_minor: (APPROVED_REFUND as any).amount_minor + 1 }),
    { 'approval.binds_exact_action': 'not_established' })
})

test('C2 invinoveritas negative: a genuine verdict issued on a different action (the EUR 4M refund)', async () => {
  await oneNegative('C2', INV, e => submission(e, { [INV]: bytes(VERDICTS.reckless_refund.event) }),
    { 'invinoveritas.verdict_authentic': 'established', 'invinoveritas.verdict_covers_action': 'not_established' })
})

test('C3 NENRIN negative: a genuine signed walk, by a trusted witness, of a different endpoint', async () => {
  await oneNegative('C3', NEN, e => submission(e, { [NEN]: bytes(WALKS.kuangmi_mcp) }),
    { 'nenrin.walk_authentic': 'established', 'nenrin.walk_covers_endpoint': 'not_established' })
})

test('C4 AgentAvow negative: the served tool definition drifted after the signed scan', async () => {
  const drifted = servedTool(); drifted.description = String(drifted.description) + ' (changed after the scan)'
  await oneNegative('C4', AV, e => submission(e, { [AV]: avEvidence(drifted) }),
    { 'agentavow.grade': 'established', 'agentavow.tool_definition_binds': 'not_established' })
})

test('C5 missing evidence for one component (NENRIN): refused, no dispatch, attributed to that component', async () => {
  await oneNegative('C5', NEN, e => submission(e, { [NEN]: null }), {})
})

test('C6 OBSERVATION, subject alignment: the four positives concern different subjects and still admit', async () => {
  // Not a pass condition for composition. Recorded so the report states it: APS and invinoveritas bind the
  // refund action itself; NENRIN binds https://gate.horizonshield.dev/a2a and AgentAvow binds a tool on
  // https://mcp.deepwiki.com/mcp, both from per-component config. The executor dispatches to the sim provider.
  // Nothing in the contract ties a tool_admission component's configured endpoint to the executor's target.
  const e = await env()
  try {
    const req = submission(e)
    const r = await e.rt.submit(req)
    assert.equal(r.status, 'provider_confirmed')
    const cfg = e.policy.components
    console.log(`# C6 executor base_url=${(cfg[EXEC].config as any).base_url} nenrin.endpoint=${(cfg[NEN].config as any).endpoint} agentavow.endpoint=${(cfg[AV].config as any).endpoint}`)
  } finally { await e.close() }
})

test('C7 every AgentAvow scan request was answered by the local stub', () => {
  assert.ok(scanCalls > 0)
})
