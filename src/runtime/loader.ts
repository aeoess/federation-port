import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTRACT_VERSION } from '../contract/types.ts'
import type { Adapter, AdapterFactory, Manifest } from '../contract/types.ts'
import { artifactDigest, digestJson } from './canonical.ts'
import type { ComponentPin } from './policy.ts'

export class LoadError extends Error {
  readonly code: string
  readonly component: string
  constructor(code: string, component: string, detail = '') {
    super(`${code}:${component}${detail ? ':' + detail : ''}`)
    this.code = code
    this.component = component
  }
}

export interface LoadedComponent {
  id: string
  manifest: Manifest
  manifest_digest: string
  artifact_digest: string
  adapter: Adapter
}

/** Origin pattern match. "*" is allowed only as the whole port. */
export function destinationAllowed(url: string, patterns: string[]): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  return patterns.some(p => {
    const m = /^(https?):\/\/([^/:]+)(?::(\*|\d+))?$/.exec(p)
    if (!m) return false
    const [, proto, host, port] = m
    if (u.protocol !== proto + ':' || u.hostname !== host) return false
    return port === '*' || (port ?? '') === u.port
  })
}

function restrictedFetch(allowed: string[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!destinationAllowed(url, allowed)) return Promise.reject(new Error(`destination_not_granted:${new URL(url).origin}`))
    return fetch(input, init)
  }) as typeof fetch
}

/**
 * Load one component under its pin. Refuses before import when the manifest digest,
 * artifact digest, version, privileges or destinations do not match the operator grant.
 */
export async function loadComponent(id: string, pin: ComponentPin, secrets: Record<string, string>): Promise<LoadedComponent> {
  const manifestPath = resolve(pin.path, 'manifest.json')
  let manifest: Manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) {
    throw new LoadError('manifest_unreadable', id, (e as Error).message)
  }
  if (manifest.contract !== CONTRACT_VERSION) throw new LoadError('contract_version_unsupported', id, String(manifest.contract))
  if (manifest.id !== id) throw new LoadError('manifest_id_mismatch', id, manifest.id)
  const manifest_digest = digestJson(manifest)
  if (manifest_digest !== pin.manifest_digest) throw new LoadError('manifest_changed', id)
  if (manifest.artifact.version !== pin.version) throw new LoadError('version_not_pinned', id, manifest.artifact.version)

  const base = dirname(manifestPath)
  const files = manifest.artifact.files
  if (!files.includes(manifest.artifact.entry)) throw new LoadError('entry_not_covered_by_digest', id)
  if (files.some(f => f.startsWith('/') || f.split(/[\\/]/).includes('..'))) throw new LoadError('artifact_path_outside_component', id)
  let artifact_digest: string
  try { artifact_digest = artifactDigest(base, files) } catch (e) {
    throw new LoadError('artifact_unreadable', id, (e as Error).message)
  }
  if (artifact_digest !== manifest.artifact.digest) throw new LoadError('artifact_digest_mismatch', id)
  if (artifact_digest !== pin.artifact_digest) throw new LoadError('artifact_not_pinned', id)

  const excess = manifest.privileges_requested.filter(p => !pin.privileges_granted.includes(p))
  if (excess.length) throw new LoadError('privileges_exceed_grant', id, excess.join(','))
  const badDest = manifest.data_destinations.filter(d => !pin.destinations_allowed.includes(d))
  if (badDest.length) throw new LoadError('destinations_exceed_grant', id, badDest.join(','))

  const claimIds = manifest.claims.map(c => c.id)
  if (new Set(claimIds).size !== claimIds.length) throw new LoadError('duplicate_claim_id', id)
  if (manifest.role === 'execution' && !manifest.tools?.length) throw new LoadError('execution_without_tools', id)

  const granted: Record<string, string> = {}
  for (const p of manifest.privileges_requested) {
    if (!p.startsWith('secret:')) continue
    const name = p.slice('secret:'.length)
    if (!(name in secrets)) throw new LoadError('secret_not_provisioned', id, name)
    granted[name] = secrets[name]
  }

  const mod = await import(pathToFileURL(join(base, manifest.artifact.entry)).href) as { createAdapter?: AdapterFactory }
  if (typeof mod.createAdapter !== 'function') throw new LoadError('entry_missing_createAdapter', id)
  const adapter = mod.createAdapter({
    config: structuredClone(pin.config ?? {}),
    secrets: Object.freeze(granted),
    fetch: restrictedFetch(manifest.data_destinations),
  })
  if (manifest.role === 'execution' ? typeof adapter.execute !== 'function' : typeof adapter.check !== 'function') {
    throw new LoadError('adapter_missing_role_method', id, manifest.role)
  }
  if (digestJson(adapter.describe()) !== manifest_digest) throw new LoadError('describe_differs_from_manifest', id)
  return { id, manifest, manifest_digest, artifact_digest, adapter }
}
