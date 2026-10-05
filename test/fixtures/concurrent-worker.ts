// One OS process submitting one request against a shared SQLite store.
// argv[2] = path to a JSON job file. The provider secret comes from FP_PROVIDER_KEY and is never printed.
import { readFileSync } from 'node:fs'
import { Runtime } from '../../src/runtime/index.ts'

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const rt = await Runtime.create({ policy: job.policy, dbPath: job.dbPath, secrets: { provider_api_key: process.env.FP_PROVIDER_KEY! } })
const req = job.request
req.operation_id = `${req.operation_id}-${process.argv[3]}`
req.evidence = Object.fromEntries(Object.entries(req.evidence as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, 'base64')]))
while (Date.now() < job.goAt) { /* start barrier */ }
const r = await rt.submit(req)
rt.close()
process.stdout.write(JSON.stringify({ status: r.status, reasons: 'reasons' in r ? r.reasons : [] }))
