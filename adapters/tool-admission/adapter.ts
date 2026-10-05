// Tool-admission component: fetches the provider's live tool definition and compares its
// SHA-256 with the digest the customer pinned. Written against src/contract only, after the core freeze.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Adapter, AdapterContext, CheckOutput, Manifest } from '../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const CLAIM = 'tool.definition_matches_pin'

export function createAdapter(ctx: AdapterContext): Adapter {
  const cfg = ctx.config as { definition_url: string; pinned_sha256: string; tool: string }
  return {
    describe: () => manifest,
    async check(input): Promise<CheckOutput> {
      if (input.action.tool !== cfg.tool) {
        return { evidence: new Uint8Array(), claims: [{ claim: CLAIM, status: 'unsupported', reason: `tool_not_configured:${input.action.tool}` }] }
      }
      // A transport error propagates: the runtime records the component as unavailable.
      const res = await ctx.fetch(cfg.definition_url)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (res.status !== 200) return { evidence: bytes, claims: [{ claim: CLAIM, status: 'failed', reason: `definition_http_${res.status}` }] }
      const got = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
      return got === cfg.pinned_sha256
        ? { evidence: bytes, claims: [{ claim: CLAIM, status: 'established' }] }
        : { evidence: bytes, claims: [{ claim: CLAIM, status: 'not_established', reason: 'definition_digest_differs_from_pin' }] }
    },
  }
}
