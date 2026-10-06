// Runs the same cases through the direct integration and through the port, and prints a table.
// Every number in the output is measured in this run against the local simulator.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_TOOL_DEFINITION, startProvider } from '../sim/provider.ts'
import type { SimProvider } from '../sim/provider.ts'
import { BOUNDARY, createOperator } from '../sim/operator.ts'
import type { Operator } from '../sim/operator.ts'
import { APPROVED_REFUND, TARGET_TEMPLATE } from '../sim/profile.ts'
import { createDirectRefunder } from './direct-refund.ts'
import { createPortRefunder } from './port-refund.ts'

const ROOT = resolve(import.meta.dirname, '..')
const run = promisify(execFile)
const TOOL_SHA = 'sha256:' + createHash('sha256').update(JSON.stringify(DEFAULT_TOOL_DEFINITION)).digest('hex')
let seq = 0
const op = () => `cmp-${Date.now()}-${seq++}`

interface World { provider: SimProvider; operator: Operator; apiKey: string; dbPath: string; cfg: any }
async function world(): Promise<World> {
  const apiKey = randomBytes(24).toString('hex')
  const provider = await startProvider({ apiKey })
  const operator = createOperator()
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fp-cmp-')), 'port.db')
  const cfg = { root: ROOT, dbPath, providerUrl: provider.url, boundaryIdentity: BOUNDARY,
    trustedKeys: { [BOUNDARY]: operator.boundaryPublicKey }, targetTemplate: TARGET_TEMPLATE, toolDefinitionSha256: TOOL_SHA }
  return { provider, operator, apiKey, dbPath, cfg }
}
const direct = (w: World, afterCheck?: () => Promise<void>) => createDirectRefunder({ ...w.cfg, apiKey: w.apiKey, afterCheck })
const port = (w: World, o?: { extraWorkflow?: string }) => createPortRefunder({ ...w.cfg, apiKey: w.apiKey }, o)
const okDirect = (r: { ok: boolean; reason?: string }) => r.ok ? 'refunded' : `refused:${r.reason}`

type Row = { kase: string; direct: string; port: string; directCovers: string; portCovers: string }
const rows: Row[] = []
// Each case returns [outcome, provider requests, refunds] for both sides.
async function both(kase: string, fn: (w: World, side: 'direct' | 'port') => Promise<string>, verdict: (o: string, req: number, refunds: number, side: 'direct' | 'port') => string) {
  const res: Record<string, { o: string; req: number; ref: number }> = {}
  for (const side of ['direct', 'port'] as const) {
    const w = await world()
    try {
      const o = await fn(w, side)
      res[side] = { o, req: w.provider.requests, ref: w.provider.refunds.length }
    } finally { await w.provider.close() }
  }
  const fmt = (r: { o: string; req: number; ref: number }) => `${r.o} (provider requests ${r.req}, refunds ${r.ref})`
  rows.push({ kase, direct: fmt(res.direct), port: fmt(res.port),
    directCovers: verdict(res.direct.o, res.direct.req, res.direct.ref, 'direct'), portCovers: verdict(res.port.o, res.port.req, res.port.ref, 'port') })
}
const refusedNoSideEffect = (o: string, req: number) => o.startsWith('refused') && req === 0 ? 'yes' : 'no'

async function single(w: World, side: 'direct' | 'port', args: Record<string, unknown>, ev?: Uint8Array, approvalId?: string) {
  if (side === 'direct') return okDirect(await direct(w)(args as any, ev))
  const p = await port(w)
  try {
    const r = await p.refund(op(), approvalId, args, ev)
    return r.status === 'refused' ? `refused:${(r as any).reasons[0].split(':').slice(0, 2).join(':')}` : r.status
  } finally { p.rt.close() }
}

await both('exact EUR 40.00 pay_A (baseline)', async (w, s) => { const a = w.operator.issue(APPROVED_REFUND); return single(w, s, { ...APPROVED_REFUND }, a.evidence, a.approval_id) },
  (o, _r, ref) => (o === 'refunded' || o === 'provider_confirmed') && ref === 1 ? 'yes (admitted)' : 'no')
for (const [name, args] of [['amount 3900', { amount_minor: 3900 }], ['amount 4100', { amount_minor: 4100 }], ['payment pay_B', { payment_id: 'pay_B' }], ['currency USD', { currency: 'USD' }]] as const) {
  await both(`altered ${name}`, async (w, s) => { const a = w.operator.issue(APPROVED_REFUND); return single(w, s, { ...APPROVED_REFUND, ...args }, a.evidence, a.approval_id) }, refusedNoSideEffect)
}
await both('missing authority', (w, s) => single(w, s, { ...APPROVED_REFUND }), refusedNoSideEffect)
await both('invalid authority (forged signature)', async (w, s) => { const a = w.operator.issue(APPROVED_REFUND, { forge: true }); return single(w, s, { ...APPROVED_REFUND }, a.evidence, a.approval_id) }, refusedNoSideEffect)
await both('expired authority', async (w, s) => { const a = w.operator.issue(APPROVED_REFUND, { issuedAt: new Date(Date.now() - 120_000), ttlMs: 60_000 }); return single(w, s, { ...APPROVED_REFUND }, a.evidence, a.approval_id) }, refusedNoSideEffect)

await both('repeated admission, same process', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND)
  if (s === 'direct') { const d = direct(w); await d({ ...APPROVED_REFUND }, a.evidence); return okDirect(await d({ ...APPROVED_REFUND }, a.evidence)) }
  const p = await port(w)
  try { await p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence); const r = await p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence); return r.status === 'refused' ? `refused:${(r as any).reasons[0]}` : r.status }
  finally { p.rt.close() }
}, (o, req, ref) => o.startsWith('refused') && req === 1 && ref === 1 ? 'yes' : 'no')

await both('8 concurrent submissions, one process', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND)
  if (s === 'direct') { const d = direct(w); const rs = await Promise.all(Array.from({ length: 8 }, () => d({ ...APPROVED_REFUND }, a.evidence))); return `${rs.filter(r => r.ok).length} succeeded` }
  const p = await port(w)
  try { const rs = await Promise.all(Array.from({ length: 8 }, () => p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence))); return `${rs.filter(r => r.status === 'provider_confirmed').length} succeeded` }
  finally { p.rt.close() }
}, (o, req, ref) => o === '1 succeeded' && req === 1 && ref === 1 ? 'yes' : 'no')

async function multiProcess(w: World, s: 'direct' | 'port', a: ReturnType<Operator['issue']>, n: number) {
  const job = join(mkdtempSync(join(tmpdir(), 'fp-job-')), 'job.json')
  writeFileSync(job, JSON.stringify({ cfg: w.cfg, goAt: Date.now() + 1500, opPrefix: op(), approvalId: a.approval_id, args: { ...APPROVED_REFUND }, evidence: Buffer.from(a.evidence).toString('base64') }))
  const outs = await Promise.all(Array.from({ length: n }, (_, i) => run(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'compare/worker.ts'), s, job, String(i)], { env: { ...process.env, FP_PROVIDER_KEY: w.apiKey } })))
  return outs.map(o => o.stdout)
}
await both('4 concurrent submissions, 4 OS processes', async (w, s) => {
  const outs = await multiProcess(w, s, w.operator.issue(APPROVED_REFUND), 4)
  return `${outs.filter(o => o === 'refunded' || o === 'provider_confirmed').length} reported success`
}, (o, req, ref) => req === 1 && ref === 1 ? 'yes' : ref === 1 ? `partly: ${req} dispatches, provider idempotency kept 1 refund` : 'no')

await both('approval reused after restart', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND)
  if (s === 'direct') { await direct(w)({ ...APPROVED_REFUND }, a.evidence); return okDirect(await direct(w)({ ...APPROVED_REFUND }, a.evidence)) }
  let p = await port(w); await p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence); p.rt.close()
  p = await port(w)
  try { const r = await p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence); return r.status === 'refused' ? `refused:${(r as any).reasons[0]}` : r.status } finally { p.rt.close() }
}, (o, req, ref) => o.startsWith('refused') && req === 1 ? 'yes' : ref === 1 ? `partly: ${req} dispatches, provider idempotency kept 1 refund` : 'no')

await both('response lost after the side effect', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND)
  w.provider.setFault({ mode: 'drop_after_commit', count: 1 })
  if (s === 'direct') return okDirect(await direct(w)({ ...APPROVED_REFUND }, a.evidence))
  const p = await port(w)
  try { const id = op(); const r1 = await p.refund(id, a.approval_id, { ...APPROVED_REFUND }, a.evidence); const r2 = await p.refund(id, a.approval_id, { ...APPROVED_REFUND }, a.evidence); return `${r1.status} then ${r2.status}` }
  finally { p.rt.close() }
}, (o, _req, ref) => /refunded|provider_confirmed$/.test(o) && ref === 1 ? 'yes' : 'no')

await both('live tool definition changed after pinning', async (w, s) => {
  const changed = structuredClone(DEFAULT_TOOL_DEFINITION) as any
  changed.input_schema.properties.amount_minor.minimum = 0
  w.provider.setToolDefinition(changed)
  const a = w.operator.issue(APPROVED_REFUND)
  return single(w, s, { ...APPROVED_REFUND }, a.evidence, a.approval_id)
}, refusedNoSideEffect)

await both('required check component unavailable', async (w, s) => {
  w.provider.setToolFault(true)
  const a = w.operator.issue(APPROVED_REFUND)
  return single(w, s, { ...APPROVED_REFUND }, a.evidence, a.approval_id)
}, (o, req, _ref, side) => side === 'direct' ? 'n/a (no separate check component)' : refusedNoSideEffect(o, req))

// V0b defect 1: the approval expires while the authority check is delayed (100 ms ttl, 250 ms delay after the
// check computed its result). Same injection point on both sides: after the check, before the provider call.
const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms))
await both('approval expires while the check is delayed (V0b defect 1)', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND, { ttlMs: 100 })
  if (s === 'direct') return okDirect(await direct(w, () => sleep(250))({ ...APPROVED_REFUND }, a.evidence))
  const p = await port(w)
  try {
    const c = p.rt.component('aeoess.aps/exact-approval-authority')!
    const check = c.adapter.check!.bind(c.adapter)
    c.adapter.check = async input => { const out = await check(input); await sleep(250); return out }
    const r = await p.refund(op(), a.approval_id, { ...APPROVED_REFUND }, a.evidence)
    return r.status === 'refused' ? `refused:${(r as any).reasons[0]}` : r.status
  } finally { p.rt.close() }
}, refusedNoSideEffect)

// V0b defect 2: retry of the same operation under a different workflow after a provider outage.
await both('retry under a different workflow after an outage (V0b defect 2)', async (w, s) => {
  if (s === 'direct') return 'n/a: the direct integration has no workflows or operation ids'
  const a = w.operator.issue(APPROVED_REFUND)
  w.provider.setFault({ mode: 'outage', count: 1 })
  const p = await port(w, { extraWorkflow: 'refund_alt' })
  try {
    const id = op()
    const r1 = await p.refund(id, a.approval_id, { ...APPROVED_REFUND }, a.evidence)
    const r2 = await p.refund(id, a.approval_id, { ...APPROVED_REFUND }, a.evidence, 'refund_alt')
    return `${r1.status}, then ${r2.status === 'refused' ? `refused:${(r2 as any).reasons[0]}` : r2.status}`
  } finally { p.rt.close() }
}, (o, req, _ref, side) => side === 'direct' ? 'n/a' : /refused:operation_workflow_mismatch$/.test(o) && req === 1 ? 'yes' : 'no')

// Acceptance 3 shape, identical inputs on both sides: the provider is down for the first 2 requests; the caller
// then submits a changed amount (3900), then the original request twice.
await both('outage, then retry with changed amount, then original twice', async (w, s) => {
  const a = w.operator.issue(APPROVED_REFUND)
  w.provider.setFault({ mode: 'outage', count: 2 })
  const steps: string[] = []
  if (s === 'direct') {
    const d = direct(w)
    for (const args of [APPROVED_REFUND, { ...APPROVED_REFUND, amount_minor: 3900 }, APPROVED_REFUND, APPROVED_REFUND]) steps.push(okDirect(await d({ ...args }, a.evidence)))
    return steps.join(' / ')
  }
  const p = await port(w)
  try {
    const id = op()
    for (const args of [APPROVED_REFUND, { ...APPROVED_REFUND, amount_minor: 3900 }, APPROVED_REFUND, APPROVED_REFUND]) {
      const r = await p.refund(id, a.approval_id, { ...args }, a.evidence)
      steps.push(r.status === 'refused' ? `refused:${(r as any).reasons[0]}` : r.status)
    }
    return steps.join(' / ')
  } finally { p.rt.close() }
}, (o, _req, ref) => ref === 1 && !/refunded|provider_confirmed/.test(o.split(' / ')[1]) ? 'yes' : ref === 0 ? 'no: approval spent, no refund' : 'no')

// Latency, happy path, sequential, 1 minor unit refunds on pay_B so N fit in one payment. Localhost only.
const N = 100
async function latency(side: 'direct' | 'port'): Promise<number> {
  const w = await world()
  const ms: number[] = []
  try {
    const d = direct(w)
    const p = side === 'port' ? await port(w) : undefined
    for (let i = 0; i < N; i++) {
      const args = { payment_id: 'pay_B', amount_minor: 1, currency: 'EUR' }
      const a = w.operator.issue(args)
      const t = performance.now()
      const r = side === 'direct' ? okDirect(await d(args, a.evidence)) : (await p!.refund(op(), a.approval_id, args, a.evidence)).status
      ms.push(performance.now() - t)
      if (r !== 'refunded' && r !== 'provider_confirmed') throw new Error(`latency run failed: ${r}`)
    }
    p?.rt.close()
  } finally { await w.provider.close() }
  ms.sort((x, y) => x - y)
  return ms[Math.floor(ms.length / 2)]
}
const lat = { direct: await latency('direct'), port: await latency('port') }

// Lines of code: non-blank lines that are not only a // comment.
const loc = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length
const RUNTIME = ['src/runtime/canonical.ts', 'src/runtime/schema.ts', 'src/runtime/policy.ts', 'src/runtime/loader.ts', 'src/runtime/store.ts', 'src/runtime/runtime.ts', 'src/runtime/index.ts']
const locRows: [string, string, string[]][] = [
  ['customer integration', 'Direct integration (all of it, including its own approval checks)', ['compare/direct-refund.ts']],
  ['customer integration', 'Port: customer side (policy + submit)', ['compare/port-refund.ts']],
  ['reusable core', 'Port: shared runtime (src/runtime)', RUNTIME],
  ['reusable core', 'Port: contract types (src/contract)', ['src/contract/types.ts']],
  ['reusable component', 'APS authority component (adapter.ts + manifest.json)', ['adapters/aps-authority/adapter.ts', 'adapters/aps-authority/manifest.json']],
  ['reusable component', 'tool-admission component (adapter.ts + manifest.json)', ['adapters/tool-admission/adapter.ts', 'adapters/tool-admission/manifest.json']],
  ['reusable component', 'simulator execution component, ships with the simulator (adapter.ts + manifest.json)', ['sim/executor/adapter.ts', 'sim/executor/manifest.json']],
]

const out: string[] = []
out.push(`Generated by \`npm run compare\` on ${new Date().toISOString()}, Node ${process.version}, local simulator only.`, '')
out.push('| case | direct: outcome | direct covers | port: outcome | port covers |', '|---|---|---|---|---|')
for (const r of rows) out.push(`| ${r.kase} | ${r.direct} | ${r.directCovers} | ${r.port} | ${r.portCovers} |`)
out.push('| privilege escalation in a component manifest | n/a (no component manifests) | n/a | refused at load (test C11) | yes |')
out.push('| provenance and usage per logical operation | none recorded | no | recorded (tests C01, C09) | yes |')
out.push('', '| category | code | files | lines (non-blank, non-comment) |', '|---|---|---|---|')
const total = (files: string[]) => files.reduce((a, f) => a + loc(f), 0)
for (const [cat, label, files] of locRows) out.push(`| ${cat} | ${label} | ${files.join(', ')} | ${files.length === 2 ? files.map(loc).join(' + ') + ' = ' : ''}${total(files)} |`)
for (const cat of ['reusable core', 'reusable component']) out.push(`| ${cat} | subtotal | | ${locRows.filter(r => r[0] === cat).reduce((a, r) => a + total(r[2]), 0)} |`)
out.push('', 'Customer integration is what one customer writes for this flow. Reusable core and components are written once',
  'and shared by every customer that uses them. Manifest lines are pretty-printed JSON as written by scripts/seal.ts.', '',
  `Latency, happy path: localhost median of N=${N} sequential refunds (1 minor unit, pay_B) against the local simulator on one machine: direct ${lat.direct.toFixed(2)} ms, port ${lat.port.toFixed(2)} ms. This is not a production cost: there is no real network, provider or load, and the port's store is a local SQLite file.`)
const text = out.join('\n') + '\n'
writeFileSync(join(ROOT, 'compare/RESULTS.md'), text)
process.stdout.write(text)
