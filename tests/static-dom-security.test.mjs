import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repoRoot, 'static', 'js', 'app.js'), 'utf8')

function dynamicHtmlTemplates() {
  return [...source.matchAll(/innerHTML\s*=\s*`([\s\S]*?)`/g)].map(match => match[1])
}

test('remote DAV metadata is never interpolated into HTML templates', () => {
  for (const template of dynamicHtmlTemplates()) {
    assert.doesNotMatch(
      template,
      /\$\{\s*(?:server\.(?:name|url)|item\.(?:id|name)|e(?:\.message)?)\s*\}/,
    )
  }
})

test('DAV item IDs are not embedded in inline event handlers', () => {
  assert.doesNotMatch(source, /<[^>]*\sonclick\s*=/i)
  assert.match(source, /addEventListener\(['"]click['"][\s\S]*?_importSingle\(item\.id\)/)
})

test('DAV remote labels use text-only DOM assignments', () => {
  assert.match(source, /textContent\s*=\s*server\.name/)
  assert.match(source, /textContent\s*=\s*server\.url/)
  assert.match(source, /textContent\s*=\s*item\.name/)
})
