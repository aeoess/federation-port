// One OS process running one refund, through the port or directly. Secret from FP_PROVIDER_KEY, never printed.
import { readFileSync } from 'node:fs'
import { createDirectRefunder } from './direct-refund.ts'
import { createPortRefunder } from './port-refund.ts'

const [mode, jobPath, idx] = process.argv.slice(2)
const job = JSON.parse(readFileSync(jobPath, 'utf8'))
const evidence = Buffer.from(job.evidence, 'base64')
const apiKey = process.env.FP_PROVIDER_KEY!
let status: string
if (mode === 'port') {
  const p = await createPortRefunder({ ...job.cfg, apiKey })
  while (Date.now() < job.goAt) { /* start barrier */ }
  status = (await p.refund(`${job.opPrefix}-${idx}`, job.approvalId, job.args, evidence)).status
  p.rt.close()
} else {
  const refund = createDirectRefunder({ ...job.cfg, apiKey })
  while (Date.now() < job.goAt) { /* start barrier */ }
  const r = await refund(job.args, evidence)
  status = r.ok ? 'refunded' : `refused:${r.reason}`
}
process.stdout.write(status)
