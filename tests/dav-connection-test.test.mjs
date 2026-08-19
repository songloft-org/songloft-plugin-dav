import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginBundle = await loadExecutablePluginBundle(repoRoot)

const config = {
  name: 'primary',
  url: 'https://dav.example.test/dav',
  username: 'listener',
  password: 'secret',
}

globalThis.songloft = {
  storage: {
    get: async () => null,
    set: async () => {},
  },
  log: {
    error() {},
  },
}

vm.runInThisContext(pluginBundle, { filename: 'dav-main.js' })

function testRequest() {
  return {
    method: 'POST',
    path: '/test',
    headers: {},
    body: JSON.stringify(config),
  }
}

function propfindResponse(entries) {
  return {
    ok: true,
    status: 207,
    statusText: 'Multi-Status',
    text: async () => `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        ${entries.map(entry => `
          <d:response>
            <d:href>${entry.href}</d:href>
            <d:propstat><d:prop>
              <d:resourcetype>${entry.directory ? '<d:collection/>' : ''}</d:resourcetype>
              <d:getcontentlength>${entry.size || 0}</d:getcontentlength>
            </d:prop></d:propstat>
          </d:response>`).join('')}
      </d:multistatus>`,
  }
}

test('connection test fails when directory listing works but a media file is forbidden', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })

    if (init.method === 'PROPFIND' && String(url).endsWith('/dav/')) {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: '/dav/cover.jpg', size: 512 },
        { href: '/dav/pure/', directory: true },
      ])
    }
    if (init.method === 'PROPFIND' && String(url).endsWith('/dav/pure')) {
      return propfindResponse([
        { href: '/dav/pure/', directory: true },
        { href: '/dav/pure/song.mp3', size: 1024 },
      ])
    }
    if (init.method === 'GET' && String(url).endsWith('/dav/pure/song.mp3')) {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      }
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`)
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(body.success, false)
  assert.equal(body.stage, 'read')
  assert.match(body.error, /403/)
  assert.equal(fetchCalls.some(call => call.init.method === 'HEAD'), false)
  assert.equal(fetchCalls.some(call => call.init.method === 'GET'), true)
  assert.equal(fetchCalls.at(-1).url.endsWith('/dav/pure/song.mp3'), true)
  assert.equal(fetchCalls.at(-1).init.headers['X-Fetch-No-Redirect'], '1')
  assert.equal(fetchCalls.at(-1).init.headers.Range, 'bytes=0-0')
  assert.equal(
    fetchCalls.at(-1).init.headers.Authorization,
    `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`,
  )
})

test('connection test rejects media redirects with native-proxy guidance', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })

    if (init.method === 'PROPFIND') {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: '/dav/song.mp3', size: 1024 },
      ])
    }
    if (init.method === 'GET') {
      return {
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: 'https://download.example.test/song.mp3' }),
      }
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`)
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, false)
  assert.equal(body.stage, 'read')
  assert.match(body.error, /本机代理.*native proxy/)
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[1].init.headers['X-Fetch-No-Redirect'], '1')
})

test('connection test passes after both directory and media reads succeed', async () => {
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'PROPFIND') {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: '/dav/song.mp3', size: 1024 },
      ])
    }
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
    }
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, true)
  assert.equal(body.readChecked, true)
})

test('connection test is only partially successful when no music file can be verified', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return propfindResponse([
      { href: '/dav/', directory: true },
      { href: '/dav/cover.jpg', size: 512 },
    ])
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, true)
  assert.equal(body.readChecked, false)
  assert.match(body.warning, /音乐文件/)
  assert.equal(fetchCalls.some(call => call.init.method === 'GET'), false)
})

test('connection test never probes a cross-origin music href with credentials', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    if (init.method === 'PROPFIND') {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: 'https://evil.example.test/stolen.mp3', size: 1024 },
        { href: '/dav/local.mp3', size: 1024 },
      ])
    }
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
    }
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, true)
  assert.equal(body.readChecked, true)
  assert.equal(fetchCalls.some(call => call.url.includes('evil.example.test')), false)
  assert.equal(fetchCalls.at(-1).url, 'https://dav.example.test/dav/local.mp3')
})

test('an unreadable music directory cannot be replaced by a readable cover probe', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    if (String(url).endsWith('/dav/')) {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: '/dav/cover.jpg', size: 512 },
        { href: '/dav/music/', directory: true },
      ])
    }
    return {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '',
    }
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, true)
  assert.equal(body.readChecked, false)
  assert.equal(fetchCalls.some(call => call.init.method === 'GET'), false)
})

test('an oversized response to the range probe is reported as unverified', async () => {
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'PROPFIND') {
      return propfindResponse([
        { href: '/dav/', directory: true },
        { href: '/dav/large.flac', size: 128 * 1024 * 1024 },
      ])
    }
    throw new Error('response body exceeds limit of 64 MiB')
  }

  const response = await globalThis.onHTTPRequest(testRequest())
  const body = JSON.parse(response.body)

  assert.equal(body.success, true)
  assert.equal(body.readChecked, false)
  assert.match(body.warning, /尚未验证/)
})
