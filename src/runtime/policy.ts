// Customer and operator policy. Runtime configuration, not part of the adapter contract.

export interface ComponentPin {
  /** Directory holding manifest.json. */
  path: string
  version: string
  manifest_digest: string
  artifact_digest: string
  privileges_granted: string[]
  destinations_allowed: string[]
  /** Passed to the adapter factory as ctx.config. */
  config?: Record<string, unknown>
}

export interface ClaimRef {
  component: string
  claim: string
}

export interface WorkflowPolicy {
  /** Component id of the execution-role component. */
  executor: string
  tool: string
  approval: 'required' | 'none'
  required_claims: ClaimRef[]
  optional_claims: ClaimRef[]
  check_timeout_ms: number
  execute_timeout_ms: number
}

export interface CustomerPolicy {
  policy_id: string
  /** Trusted components by id, each pinned to one version. */
  components: Record<string, ComponentPin>
  workflows: Record<string, WorkflowPolicy>
}
