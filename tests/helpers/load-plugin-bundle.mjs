import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import JSZip from 'jszip'

const nodeBuiltins = /^(fs|net|http|https|child_process|os|path|crypto|stream|util|events|buffer|url|querystring|zlib)$/

export async function loadExecutablePluginBundle(
  repoRoot,
  bundlePath = join(repoRoot, 'dist', 'dav.jsplugin.zip'),
) {
  const zip = await JSZip.loadAsync(readFileSync(bundlePath))
  const manifestFile = zip.file('plugin.json')
  if (!manifestFile) {
    throw new Error('Build artifact is missing plugin.json')
  }

  const manifest = JSON.parse(await manifestFile.async('string'))
  const declaredEntry = zip.file(manifest.main)
  if (!declaredEntry) {
    throw new Error(`Build artifact is missing declared entry ${manifest.main}`)
  }

  if (manifest.main.endsWith('.js')) {
    return await declaredEntry.async('string')
  }
  if (!manifest.main.endsWith('.jsc')) {
    throw new Error(`Unsupported plugin entry for Node tests: ${manifest.main}`)
  }

  // QuickJS bytecode cannot run in Node's VM. Rebuild the same source entry
  // as JavaScript for behavior tests; artifact tests still validate the JSC.
  const result = await build({
    entryPoints: [join(repoRoot, 'src', 'main.ts')],
    bundle: true,
    platform: 'neutral',
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    plugins: [{
      name: 'no-node-builtins',
      setup(context) {
        context.onResolve({ filter: nodeBuiltins }, args => ({
          errors: [{
            text: `Node builtin "${args.path}" is not available in QuickJS runtime`,
          }],
        }))
      },
    }],
  })
  if (result.outputFiles.length !== 1) {
    throw new Error(`Expected one executable test bundle, got ${result.outputFiles.length}`)
  }
  return result.outputFiles[0].text
}
