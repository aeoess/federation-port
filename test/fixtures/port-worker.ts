// One OS process submitting one request against a shared store, for restart tests.
// argv[2] = job file { policy, dbPath, request, checkDelayMs? }. The provider secret comes from
// FP_PROVIDER_KEY and is never printed. Prints "checked" when the authority check has returned
// (before its optional delay), then one JSON result line.
import { readFileSync } from 'node:fs'
import { Runtime } from '../../src/runtime/index.ts'

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const rt = await Runtime.create({ policy: job.policy, dbPath: job.dbPath, secrets: { provider_api_key: process.env.FP_PROVIDER_KEY! } })
const req = job.request
req.evidence = Object.fromEntries(Object.entries(req.evidence as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, 'base64')]))
if (job.checkDelayMs) {
  const c = rt.component(job.delayComponent)!
  const original = c.adapter.check!.bind(c.adapter)
  c.adapter.check = async input => {
    const out = await original(input)
    process.stdout.write('checked\n')
    await new Promise(ok => setTimeout(ok, job.checkDelayMs))
    return out
  }
}
const r = await rt.submit(req)
rt.close()
process.stdout.write(JSON.stringify({ status: r.status, reasons: 'reasons' in r ? r.reasons : [], replayed: 'replayed' in r ? r.replayed : undefined }) + '\n')
