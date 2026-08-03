import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import JSZip from 'jszip'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Node behavior tests get executable JavaScript when release entry is main.jsc', async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'dav-jsc-test-'))
  try {
    const bundlePath = join(fixtureDir, 'dav.jsplugin.zip')
    const zip = new JSZip()
    zip.file('main.jsc', 'quickjs-bytecode-placeholder')
    zip.file('plugin.json', JSON.stringify({ main: 'main.jsc' }))
    writeFileSync(bundlePath, await zip.generateAsync({ type: 'nodebuffer' }))

    const executableBundle = await loadExecutablePluginBundle(repoRoot, bundlePath)

    assert.doesNotThrow(() => new vm.Script(executableBundle))
    assert.match(executableBundle, /onHTTPRequest/)
    assert.doesNotMatch(executableBundle, /quickjs-bytecode-placeholder/)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})
