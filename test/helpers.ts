import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Runtime, artifactDigest, digestJson } from '../src/runtime/index.ts'
import type { ClaimRef, ComponentPin, CustomerPolicy, WorkflowPolicy } from '../src/runtime/index.ts'
import { startProvider } from '../sim/provider.ts'
import type { SimProvider } from '../sim/provider.ts'
import { BOUNDARY, createOperator } from '../sim/operator.ts'
import type { Operator } from '../sim/operator.ts'
import { ACTION_TYPE, APPROVED_REFUND, TARGET_TEMPLATE } from '../sim/profile.ts'

export const ROOT = resolve(import.meta.dirname, '..')
export const APS = 'aeoess.aps/exact-approval-authority'
export const EXEC = 'example.sim/refund-executor'
export const FIXTURE = 'test.fixture/check'
export const APS_CLAIMS = ['approval.signature_valid', 'approval.id_matches_request', 'approval.permit_verdict', 'approval.binds_exact_action', 'approval.unexpired']

export const tmp = (p = 'fp-') => mkdtempSync(join(tmpdir(), p))

/** Pin a component exactly as it is on disk now, granting what its manifest requests. */
export function pinFromDisk(path: string, extra: Partial<ComponentPin> = {}): ComponentPin {
  const m = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
  return {
    path, version: m.artifact.version, manifest_digest: digestJson(m), artifact_digest: artifactDigest(path, m.artifact.files),
    privileges_granted: [...m.privileges_requested], destinations_allowed: [...m.data_destinations], ...extra,
  }
}

/** Copy a component directory to a temp location (for tamper tests). */
export function copyComponent(rel: string): string {
  const dst = join(tmp('fp-comp-'), 'c')
  cpSync(join(ROOT, rel), dst, { recursive: true })
  return dst
}

export interface Env {
  provider: SimProvider
  operator: Operator
  policy: CustomerPolicy
  rt: Runtime
  dbPath: string
  apiKey: string
  close(): Promise<void>
}

export interface EnvOptions {
  extraComponents?: Record<string, ComponentPin>
  required?: ClaimRef[]
  optional?: ClaimRef[]
  overrides?: Partial<CustomerPolicy['components']>
  workflow?: Partial<WorkflowPolicy>
  dbPath?: string
  provider?: SimProvider
  apiKey?: string
}

export function buildPolicy(operator: Operator, providerUrl: string, o: EnvOptions = {}): CustomerPolicy {
  return {
    policy_id: 'customer-policy-v0-test',
    components: {
      [APS]: pinFromDisk(join(ROOT, 'adapters/aps-authority'), {
        config: { boundary_identity: BOUNDARY, trusted_keys: { [BOUNDARY]: operator.boundaryPublicKey }, target_template: TARGET_TEMPLATE, action_type: ACTION_TYPE },
      }),
      [EXEC]: pinFromDisk(join(ROOT, 'sim/executor'), { config: { base_url: providerUrl } }),
      ...o.extraComponents,
      ...(o.overrides as Record<string, ComponentPin>),
    },
    workflows: {
      refund: {
        executor: EXEC, tool: 'refund', approval: 'required',
        required_claims: o.required ?? APS_CLAIMS.map(claim => ({ component: APS, claim })),
        optional_claims: o.optional ?? [],
        check_timeout_ms: 500, execute_timeout_ms: 1000,
        ...o.workflow,
      },
    },
  }
}

export async function setup(o: EnvOptions = {}): Promise<Env> {
  const apiKey = o.apiKey ?? randomBytes(24).toString('hex')
  const provider = o.provider ?? await startProvider({ apiKey })
  const operator = createOperator()
  const policy = buildPolicy(operator, provider.url, o)
  const dbPath = o.dbPath ?? join(tmp(), 'port.db')
  const rt = await Runtime.create({ policy, dbPath, secrets: { provider_api_key: apiKey } })
  const env: Env = {
    provider, operator, policy, rt, dbPath, apiKey,
    // Closes whichever runtime the test left in env.rt, not only the first one.
    async close() { env.rt.close(); if (!o.provider) await provider.close() },
  }
  return env
}

let n = 0
export const opId = () => `op-${process.pid}-${Date.now()}-${n++}`

/** A submission for `args` carrying an approval issued for `approved`. */
export function request(env: Env, args: Record<string, unknown> = { ...APPROVED_REFUND }, approved = APPROVED_REFUND,
  issueOpts: Parameters<Operator['issue']>[1] = {}) {
  const a = env.operator.issue(approved, issueOpts)
  return { a, req: { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args }, evidence: { [APS]: a.evidence } } }
}

/** Wraps a loaded check component so its result arrives `ms` after it was computed. */
export function delayCheck(rt: Runtime, id: string, ms: number | (() => Promise<void>)): void {
  const c = rt.component(id)!
  const original = c.adapter.check!.bind(c.adapter)
  c.adapter.check = async input => {
    const out = await original(input)
    if (typeof ms === 'number') await new Promise(ok => setTimeout(ok, ms))
    else await ms()
    return out
  }
}

/** Replace env.rt with a runtime on the same store under `policy`. */
export async function restart(env: Env, policy: CustomerPolicy, clock?: () => Date): Promise<void> {
  env.rt.close()
  env.rt = await Runtime.create({ policy, dbPath: env.dbPath, secrets: { provider_api_key: env.apiKey }, ...(clock ? { clock } : {}) })
}

/** Spawn a node script; resolves `line(x)` when stdout prints that line, `done` on exit. */
export function child(script: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  const waiters: [string, () => void][] = []
  p.stdout.on('data', d => {
    out += d
    for (const [l, ok] of waiters) if (out.split('\n').includes(l)) ok()
  })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; lines: string[] }>(ok =>
    p.on('exit', (code, signal) => ok({ code, signal, lines: out.split('\n').filter(Boolean) })))
  return {
    proc: p, done,
    line: (l: string) => new Promise<void>(ok => { if (out.split('\n').includes(l)) ok(); else waiters.push([l, ok]) }),
  }
}

export function writeJob(env: Env, req: ReturnType<typeof request>['req'], extra: Record<string, unknown> = {}): string {
  const job = join(tmp(), 'job.json')
  const evidence = Object.fromEntries(Object.entries(req.evidence).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
  writeFileSync(job, JSON.stringify({ policy: env.policy, dbPath: env.dbPath, request: { ...req, evidence }, ...extra }))
  return job
}
export const WORKER = join(ROOT, 'test/fixtures/port-worker.ts')
export async function runWorker(env: Env, job: string) {
  const r = await child(WORKER, [job], { FP_PROVIDER_KEY: env.apiKey }).done
  assert.equal(r.code, 0)
  return JSON.parse(r.lines.at(-1)!)
}

