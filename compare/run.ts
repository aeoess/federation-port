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
const direct = (w: World) => createDirectRefunder({ ...w.cfg, apiKey: w.apiKey })
const port = (w: World) => createPortRefunder({ ...w.cfg, apiKey: w.apiKey })
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

// Latency, happy path, sequential, 1 minor unit refunds on pay_B so 30 fit in one payment.
async function latency(side: 'direct' | 'port'): Promise<number> {
  const w = await world()
  const ms: number[] = []
  try {
    const d = direct(w)
    const p = side === 'port' ? await port(w) : undefined
    for (let i = 0; i < 30; i++) {
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
const locRows: [string, string[]][] = [
  ['Direct integration (all of it)', ['compare/direct-refund.ts']],
  ['Port: customer-side integration (policy + submit)', ['compare/port-refund.ts']],
  ['Port: APS authority component (adapter.ts + manifest.json)', ['adapters/aps-authority/adapter.ts', 'adapters/aps-authority/manifest.json']],
  ['Port: simulator execution component (adapter.ts + manifest.json)', ['sim/executor/adapter.ts', 'sim/executor/manifest.json']],
  ['Port: tool-admission component (adapter.ts + manifest.json)', ['adapters/tool-admission/adapter.ts', 'adapters/tool-admission/manifest.json']],
  ['Port: shared runtime (src/runtime)', ['src/runtime/canonical.ts', 'src/runtime/schema.ts', 'src/runtime/policy.ts', 'src/runtime/loader.ts', 'src/runtime/store.ts', 'src/runtime/runtime.ts', 'src/runtime/index.ts']],
  ['Port: contract types (src/contract)', ['src/contract/types.ts']],
]

const out: string[] = []
out.push(`Generated by \`npm run compare\` on ${new Date().toISOString()}, Node ${process.version}, local simulator only.`, '')
out.push('| case | direct: outcome | direct covers | port: outcome | port covers |', '|---|---|---|---|---|')
for (const r of rows) out.push(`| ${r.kase} | ${r.direct} | ${r.directCovers} | ${r.port} | ${r.portCovers} |`)
out.push('| privilege escalation in a component manifest | n/a (no component manifests) | n/a | refused at load (test C11) | yes |')
out.push('| provenance and usage per logical operation | none recorded | no | recorded (tests C01, C09) | yes |')
out.push('', '| integration code | files | lines (non-blank, non-comment) |', '|---|---|---|')
for (const [label, files] of locRows) out.push(`| ${label} | ${files.join(', ')} | ${files.length > 1 && files.length < 3 ? files.map(loc).join(' + ') + ' = ' : ''}${files.reduce((a, f) => a + loc(f), 0)} |`)
out.push('', 'Manifest lines are pretty-printed JSON as written by scripts/seal.ts.', '', `Median happy-path latency over 30 sequential refunds (1 minor unit, pay_B): direct ${lat.direct.toFixed(2)} ms, port ${lat.port.toFixed(2)} ms.`)
const text = out.join('\n') + '\n'
writeFileSync(join(ROOT, 'compare/RESULTS.md'), text)
process.stdout.write(text)
