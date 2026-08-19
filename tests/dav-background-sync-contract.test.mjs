import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('active DAV sync tasks are owned by a backend runner instead of the settings page', () => {
  const runnerPath = join(repoRoot, 'src', 'sync-runner.ts')
  assert.equal(existsSync(runnerPath), true, 'backend sync runner module must exist')

  const main = readFileSync(join(repoRoot, 'src', 'main.ts'), 'utf8')
  const router = readFileSync(join(repoRoot, 'src', 'router.ts'), 'utf8')
  const app = readFileSync(join(repoRoot, 'static', 'js', 'app.js'), 'utf8')

  assert.match(main, /await\s+resumeDavSyncRunners\(\)/)
  assert.match(main, /stopDavSyncRunners\(\)/)
  assert.match(router, /startDavSyncInBackground\(params\.id\)/)
  assert.match(router, /cancelDavSyncInBackground\(params\.id,\s*taskId\)/)
  assert.match(app, /ensureSyncMonitor\(root\.configId,\s*task\.taskId\)/)
  assert.doesNotMatch(app, /\/advance/)
  assert.doesNotMatch(app, /X-Plugin-Timeout-Ms/)
})
