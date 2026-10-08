// ctx.fetch checks the first URL only, so it must not follow a redirect to an origin that was not granted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { restrictedFetch } from '../src/runtime/loader.ts'

test('F1 a redirect from a granted origin to one that is not granted is refused, and the second origin is never reached', async () => {
  const hits: string[] = []
  const other = http.createServer((q, r) => { hits.push(`other ${q.url}`); r.end('other') })
  await new Promise<void>(ok => other.listen(0, '127.0.0.1', () => ok()))
  const otherPort = (other.address() as AddressInfo).port
  const granted = http.createServer((q, r) => { hits.push(`granted ${q.url}`); r.writeHead(302, { location: `http://127.0.0.1:${otherPort}/x` }); r.end() })
  await new Promise<void>(ok => granted.listen(0, '127.0.0.1', () => ok()))
  const grantedPort = (granted.address() as AddressInfo).port
  try {
    const f = restrictedFetch([`http://127.0.0.1:${grantedPort}`])
    await assert.rejects(f(`http://127.0.0.1:${grantedPort}/scan`))
    await assert.rejects(f(new Request(`http://127.0.0.1:${grantedPort}/scan`, { redirect: 'follow' })))
    assert.deepEqual(hits, ['granted /scan', 'granted /scan'])
  } finally { granted.close(); other.close() }
})
