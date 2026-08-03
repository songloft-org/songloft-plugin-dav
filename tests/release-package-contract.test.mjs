import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = process.env.DAV_PLUGIN_ZIP || join(repoRoot, 'dist', 'dav.jsplugin.zip')
const registryManifest = JSON.parse(readFileSync(join(repoRoot, 'plugin.json'), 'utf8'))

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

test('release ZIP has one unambiguous entry and valid declared hashes', async () => {
  const zip = await JSZip.loadAsync(readFileSync(bundlePath))
  const files = Object.values(zip.files)
    .filter(entry => !entry.dir)
    .map(entry => entry.name)
  const manifestFile = zip.file('plugin.json')
  assert.ok(manifestFile, 'release ZIP must contain plugin.json')
  const manifest = JSON.parse(await manifestFile.async('string'))
  const declaredEntry = zip.file(manifest.main)

  assert.ok(declaredEntry, `manifest main is missing: ${manifest.main}`)
  assert.equal(
    registryManifest.main,
    manifest.main,
    'registry plugin.json main must match the release ZIP',
  )
  assert.equal(
    sha256(await declaredEntry.async('nodebuffer')),
    manifest.entryHash,
    'entryHash must hash the exact entry declared by plugin.json.main',
  )

  const sibling = manifest.main.endsWith('.jsc')
    ? manifest.main.replace(/\.jsc$/, '.js')
    : manifest.main.replace(/\.js$/, '.jsc')
  assert.equal(
    files.includes(sibling),
    false,
    `release ZIP must not contain undeclared sibling entry ${sibling}`,
  )

  const canonicalInput = files
    .filter(name => name !== 'plugin.json')
    .sort()
  const canonicalParts = []
  for (const name of canonicalInput) {
    canonicalParts.push(`${name}\n${sha256(await zip.file(name).async('nodebuffer'))}\n`)
  }
  assert.equal(
    sha256(canonicalParts.join('')),
    manifest.zipHash,
    'zipHash must match the canonical package contents',
  )

  assert.equal(
    registryManifest.entryHash,
    manifest.entryHash,
    'registry plugin.json entryHash must match the release ZIP',
  )
  assert.equal(
    registryManifest.zipHash,
    manifest.zipHash,
    'registry plugin.json zipHash must match the release ZIP',
  )
})

test('safe DAV credentials require a host that supports response headers', () => {
  assert.equal(registryManifest.minHostVersion, '2.9.5')
})
