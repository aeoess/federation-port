import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
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
  return {
    provider, operator, policy, rt, dbPath, apiKey,
    async close() { rt.close(); if (!o.provider) await provider.close() },
  }
}

let n = 0
export const opId = () => `op-${process.pid}-${Date.now()}-${n++}`

/** A submission for `args` carrying an approval issued for `approved`. */
export function request(env: Env, args: Record<string, unknown> = { ...APPROVED_REFUND }, approved = APPROVED_REFUND,
  issueOpts: Parameters<Operator['issue']>[1] = {}) {
  const a = env.operator.issue(approved, issueOpts)
  return { a, req: { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args }, evidence: { [APS]: a.evidence } } }
}
