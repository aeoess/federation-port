// Checks that each component's files hash to its sealed manifest digest, and that the digests are the
// ones the composition run used. Exits 1 on any difference.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactDigest } from '../src/runtime/index.ts'

const EXPECTED: Record<string, string> = {
  'aps-authority': 'sha256:0ef8faf0078262d8c3f8b0b8b512e2c82f549aeda994bacf355ef619978c999a',
  'invinoveritas-verdict': 'sha256:9c11769fd9f4e1d42584ae1f79ba4c77334db11222643185f36edd28fc9ba6d3',
  'nenrin-conduct-walk': 'sha256:50bff064d3e3b9db25b63c96968b617c69182023f5e7d82e8aa515d000804205',
  'agentavow-mcp-admission': 'sha256:c7d2a4159bd53c2df28360d9a8bdc9a821bd0954125a35b88ef2ca042408d1d1',
}
let bad = 0
for (const [dir, want] of Object.entries(EXPECTED)) {
  const p = join(import.meta.dirname, '..', 'adapters', dir)
  const m = JSON.parse(readFileSync(join(p, 'manifest.json'), 'utf8'))
  const got = artifactDigest(p, m.artifact.files)
  const ok = got === m.artifact.digest && got === want
  if (!ok) bad++
  console.log(`${ok ? 'ok ' : 'BAD'} ${m.id} ${m.artifact.version} ${got}`)
}
process.exit(bad ? 1 : 0)
