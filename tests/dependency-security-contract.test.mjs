import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))

function isAtLeast(version, minimum) {
  const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/
  const actualMatch = versionPattern.exec(version)
  const expectedMatch = versionPattern.exec(minimum)
  if (!actualMatch || !expectedMatch) return false
  const actual = actualMatch.slice(1).map(Number)
  const expected = expectedMatch.slice(1).map(Number)
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true
    if (actual[index] < expected[index]) return false
  }
  return true
}

test('brace-expansion lock entries include the GHSA-rgw5-rvv9-x895 fix', () => {
  const entries = Object.entries(lock.packages)
    .filter(([path]) => path === 'node_modules/brace-expansion' ||
      path.endsWith('/node_modules/brace-expansion'))

  assert.equal(entries.length > 0, true, 'brace-expansion is missing from the lockfile')
  for (const [path, metadata] of entries) {
    assert.equal(
      isAtLeast(metadata.version, '5.0.9'),
      true,
      `${path} locks vulnerable brace-expansion ${metadata.version}; require >=5.0.9`,
    )
  }
})
