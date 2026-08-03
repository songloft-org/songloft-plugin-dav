import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPlugin } from '@songloft/plugin-builder'
import JSZip from 'jszip'

const cwd = process.cwd()
const buildDir = join(cwd, 'dist', '_build')

// Older builder releases reused this directory, so clean it before invoking
// the builder as a compatibility guard for frozen plugin lock files.
rmSync(buildDir, { recursive: true, force: true })

const result = await buildPlugin({ cwd })
const zipBuffer = readFileSync(result.zipPath)
const zip = await JSZip.loadAsync(zipBuffer)
const manifestFile = zip.file('plugin.json')
if (!manifestFile) {
  throw new Error('Build artifact is missing plugin.json')
}

const manifest = JSON.parse(await manifestFile.async('string'))
const declaredEntry = zip.file(manifest.main)
if (!declaredEntry) {
  throw new Error(`Build artifact is missing declared entry ${manifest.main}`)
}

const sibling = manifest.main.endsWith('.jsc')
  ? manifest.main.replace(/\.jsc$/, '.js')
  : manifest.main.replace(/\.js$/, '.jsc')
let normalized = false
if (zip.file(sibling)) {
  zip.remove(sibling)
  rmSync(join(buildDir, sibling), { force: true })
  normalized = true
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

const entryContent = await declaredEntry.async('nodebuffer')
const actualEntryHash = sha256(entryContent)
if (manifest.entryHash !== actualEntryHash) {
  throw new Error(
    `entryHash mismatch for ${manifest.main}: declared=${manifest.entryHash} actual=${actualEntryHash}`,
  )
}

const packageFiles = Object.values(zip.files)
  .filter(entry => !entry.dir && entry.name !== 'plugin.json')
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
const canonicalParts = []
for (const entry of packageFiles) {
  const content = await entry.async('nodebuffer')
  canonicalParts.push(Buffer.from(`${entry.name}\n${sha256(content)}\n`))
}
manifest.zipHash = sha256(Buffer.concat(canonicalParts))

const manifestJSON = `${JSON.stringify(manifest, null, 2)}\n`
zip.file('plugin.json', manifestJSON)
writeFileSync(join(buildDir, 'plugin.json'), manifestJSON)
writeFileSync(
  result.zipPath,
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
)

// The plugin store reads the repository manifest, while clients validate the
// manifest embedded in the ZIP. Keep both declarations tied to this artifact.
const registryManifestPath = join(cwd, 'plugin.json')
const registryManifest = JSON.parse(readFileSync(registryManifestPath, 'utf8'))
registryManifest.main = manifest.main
registryManifest.entryHash = manifest.entryHash
registryManifest.zipHash = manifest.zipHash
writeFileSync(registryManifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`)

if (normalized) {
  console.log(`  🧹 removed undeclared sibling entry ${sibling}`)
}
console.log(`  🔑 normalized zipHash: ${manifest.zipHash}`)
