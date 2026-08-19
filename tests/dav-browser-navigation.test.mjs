import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repoRoot, 'static', 'js', 'app.js'), 'utf8')

function createElement(tagName = 'div') {
  return {
    tagName,
    children: [],
    listeners: {},
    style: {},
    classList: {
      add() {},
      remove() {},
    },
    append(...children) {
      this.children.push(...children)
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    replaceChildren(...children) {
      this.children = children
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener
    },
    setAttribute() {},
    textContent: '',
    innerHTML: '',
    value: '',
  }
}

function createBrowserHarness() {
  const browserList = createElement()
  const elements = {
    browserList,
    browserPathDisplay: createElement(),
    browserServerSelect: { value: 'dav_live' },
  }
  const requests = []
  const document = {
    addEventListener() {},
    createElement,
    getElementById(id) {
      return elements[id] || null
    },
  }
  const window = { location: { origin: 'https://songloft.example.test' } }
  const context = vm.createContext({
    console,
    document,
    fetch: async url => {
      requests.push(String(url))
      return { ok: true, json: async () => [] }
    },
    setTimeout,
    SongloftPlugin: { getAuthToken: () => '' },
    window,
  })
  vm.runInContext(source, context, { filename: 'static/js/app.js' })
  return { browserList, context, requests }
}

const canonicalMount = {
  id: '/MultimediaExtend',
  name: '',
  type: 'directory',
  size: 0,
}

test('canonical WebDAV mount falls back to its normalized path for display', () => {
  const harness = createBrowserHarness()
  harness.context.renderItems([canonicalMount], '/')

  const row = harness.browserList.children[0]
  const details = row.children[1]
  const name = details.children[0]
  assert.equal(name.textContent, 'MultimediaExtend')
})

test('canonical WebDAV mount navigation uses the item identity instead of an empty label', () => {
  const harness = createBrowserHarness()
  harness.context.renderItems([canonicalMount], '/')

  const row = harness.browserList.children[0]
  row.listeners.click()

  assert.equal(
    harness.requests[0],
    './lists/dav_live/items?path=%2FMultimediaExtend',
  )
})
