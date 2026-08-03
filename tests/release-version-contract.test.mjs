import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReleaseVersion } from '../scripts/resolve-version.mjs'

test('release version accepts an optional tag prefix and emits plain semver', () => {
  for (const [input, expected] of [['1.1.4', '1.1.4'], ['v1.1.4', '1.1.4']]) {
    assert.equal(normalizeReleaseVersion(input), expected)
  }
})

test('release version rejects values outside the builder x.y.z contract', () => {
  for (const input of ['1.1', 'release-1.1.4', '1.1.4-beta.1', '']) {
    assert.throws(
      () => normalizeReleaseVersion(input),
      /valid release version/i,
    )
  }
})
