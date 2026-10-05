// Customer-side integration for the same flow through the port: policy plus one submit call.
// The components themselves are maintained by their publishers and are not counted here.
import { join } from 'node:path'
import { Runtime, artifactDigest, digestJson } from '../src/runtime/index.ts'
import type { ComponentPin, CustomerPolicy } from '../src/runtime/index.ts'
import { readFileSync } from 'node:fs'

const pin = (dir: string, config: Record<string, unknown>): ComponentPin => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  return { path: dir, version: m.artifact.version, manifest_digest: digestJson(m), artifact_digest: artifactDigest(dir, m.artifact.files),
    privileges_granted: m.privileges_requested, destinations_allowed: m.data_destinations, config }
}

export interface PortConfig {
  root: string
  dbPath: string
  providerUrl: string
  apiKey: string
  boundaryIdentity: string
  trustedKeys: Record<string, string>
  targetTemplate: string
  toolDefinitionSha256?: string
}

export async function createPortRefunder(cfg: PortConfig) {
  const APS = 'aeoess.aps/exact-approval-authority', EXEC = 'example.sim/refund-executor', TOOL = 'example.tools/definition-pin-check'
  const policy: CustomerPolicy = {
    policy_id: 'comparison',
    components: {
      [APS]: pin(join(cfg.root, 'adapters/aps-authority'), { boundary_identity: cfg.boundaryIdentity, trusted_keys: cfg.trustedKeys, target_template: cfg.targetTemplate, action_type: 'refund' }),
      [EXEC]: pin(join(cfg.root, 'sim/executor'), { base_url: cfg.providerUrl }),
      ...(cfg.toolDefinitionSha256 ? { [TOOL]: pin(join(cfg.root, 'adapters/tool-admission'),
        { definition_url: `${cfg.providerUrl}/v1/tool-definition`, pinned_sha256: cfg.toolDefinitionSha256, tool: 'refund' }) } : {}),
    },
    workflows: {
      refund: {
        executor: EXEC, tool: 'refund', approval: 'required', optional_claims: [], check_timeout_ms: 500, execute_timeout_ms: 1000,
        required_claims: [
          ...['approval.signature_valid', 'approval.id_matches_request', 'approval.permit_verdict', 'approval.binds_exact_action', 'approval.unexpired']
            .map(claim => ({ component: APS, claim })),
          ...(cfg.toolDefinitionSha256 ? [{ component: TOOL, claim: 'tool.definition_matches_pin' }] : []),
        ],
      },
    },
  }
  const rt = await Runtime.create({ policy, dbPath: cfg.dbPath, secrets: { provider_api_key: cfg.apiKey } })
  return {
    rt,
    refund: (operationId: string, approvalId: string | undefined, args: Record<string, unknown>, evidence: Uint8Array | undefined) =>
      rt.submit({ workflow: 'refund', operation_id: operationId, approval_id: approvalId, action: { tool: 'refund', args }, evidence: evidence ? { [APS]: evidence } : {} }),
  }
}
