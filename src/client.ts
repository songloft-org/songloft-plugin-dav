import type { DavConfig } from './config'

function getBasicAuth(str: string): string {
  try {
    const utf8 = encodeURIComponent(str).replace(
      /%([0-9A-F]{2})/g,
      (_match: string, hex: string) => String.fromCharCode(parseInt(hex, 16))
    )
    return globalThis.btoa(utf8)
  } catch {
    return ''
  }
}

function getAuthHeader(config: DavConfig): Record<string, string> {
  if (config.username && config.password) {
    const basic = getBasicAuth(`${config.username}:${config.password}`)
    if (basic) return { 'Authorization': `Basic ${basic}` }
  }
  return {}
}

export interface DavItem {
  filename: string
  basename: string
  lastmod: string
  size: number
  type: 'directory' | 'file'
}

export interface DavPropfindOptions {
  strictStatus?: boolean
}

function extractTag(xml: string, tag: string): string {
  let searchStr = xml.toLowerCase()
  let lowerTag = tag.toLowerCase()
  let openIdx = searchStr.indexOf(`<${lowerTag}`)
  if (openIdx === -1) {
    openIdx = searchStr.indexOf(`:${lowerTag}`)
    if (openIdx !== -1) {
      // make sure it's preceded by <[^>]+
      const pre = searchStr.lastIndexOf('<', openIdx)
      if (pre !== -1) {
        openIdx = pre
      } else {
        openIdx = -1
      }
    }
  }
  
  if (openIdx === -1) return ''
  
  const closeBracketIdx = searchStr.indexOf(`>`, openIdx)
  if (closeBracketIdx === -1) return ''
  
  const tagContent = searchStr.substring(openIdx + 1, closeBracketIdx)
  const prefix = tagContent.split(' ')[0]
  const closingTag = `</${prefix}>`
  const closeIdx = searchStr.indexOf(closingTag, closeBracketIdx + 1)
  
  if (closeIdx !== -1) {
    return xml.substring(closeBracketIdx + 1, closeIdx)
  }
  return ''
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = []
  // Use string searching to avoid RegExp engine limits in Goja
  let searchStr = xml.toLowerCase()
  let lowerTag = tag.toLowerCase()
  let currentIndex = 0
  
  while (true) {
    const openIdx = searchStr.indexOf(`<`, currentIndex)
    if (openIdx === -1) break
    
    const closeBracketIdx = searchStr.indexOf(`>`, openIdx)
    if (closeBracketIdx === -1) break
    
    const tagContent = searchStr.substring(openIdx + 1, closeBracketIdx)
    // Check if tagContent is something like "response" or "d:response"
    if (tagContent === lowerTag || tagContent.endsWith(`:${lowerTag}`) || tagContent.startsWith(`${lowerTag} `) || tagContent.includes(`:${lowerTag} `)) {
      // Find the closing tag
      // The closing tag is either </response> or </d:response>
      const prefix = tagContent.split(' ')[0] // e.g. "d:response"
      const closingTag = `</${prefix}>`
      const closeIdx = searchStr.indexOf(closingTag, closeBracketIdx + 1)
      
      if (closeIdx !== -1) {
        results.push(xml.substring(closeBracketIdx + 1, closeIdx))
        currentIndex = closeIdx + closingTag.length
      } else {
        currentIndex = closeBracketIdx + 1
      }
    } else {
      currentIndex = closeBracketIdx + 1
    }
  }
  
  return results
}

function countOpeningTags(xml: string, tag: string): number {
  const searchStr = xml.toLowerCase()
  const lowerTag = tag.toLowerCase()
  let currentIndex = 0
  let count = 0
  while (true) {
    const openIdx = searchStr.indexOf('<', currentIndex)
    if (openIdx === -1) break
    const closeBracketIdx = searchStr.indexOf('>', openIdx)
    if (closeBracketIdx === -1) break
    const tagContent = searchStr.substring(openIdx + 1, closeBracketIdx).trim()
    const openingTag = tagContent.endsWith('/') ? tagContent.slice(0, -1).trim() : tagContent
    if (!openingTag.startsWith('/') && (
      openingTag === lowerTag ||
      openingTag.endsWith(`:${lowerTag}`) ||
      openingTag.startsWith(`${lowerTag} `) ||
      openingTag.includes(`:${lowerTag} `)
    )) {
      count += 1
    }
    currentIndex = closeBracketIdx + 1
  }
  return count
}

function hasTag(xml: string, tag: string): boolean {
  return countOpeningTags(xml, tag) > 0
}

function parseDavStatus(value: string): number | undefined {
  const match = value.match(/(?:^|\s)(\d{3})(?:\s|$)/)
  if (!match) return undefined
  const status = Number(match[1])
  return Number.isInteger(status) ? status : undefined
}

function decodeXmlEntities(str: string): string {
  return str.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (match: string, dec: string, hex: string, name: string) => {
      if (dec) return String.fromCharCode(parseInt(dec, 10))
      if (hex) return String.fromCharCode(parseInt(hex, 16))
      switch (name) {
        case 'amp': return '&'
        case 'lt': return '<'
        case 'gt': return '>'
        case 'quot': return '"'
        case 'apos': return "'"
        default: return match
      }
    }
  )
}

export async function propfind(
  config: DavConfig,
  path: string,
  options: DavPropfindOptions = {}
): Promise<DavItem[]> {
  const url = buildStreamRequest(config, path, { mountRelative: true }).url
  const headers = getAuthHeader(config)
  
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      ...headers,
      'Depth': '1',
      'X-Fetch-No-Redirect': '1',
      'X-Fetch-Timeout-Ms': '15000'
    }
  })
  
  if (response.status >= 300 && response.status < 400) {
    throw new Error('WebDAV PROPFIND redirect rejected')
  }
  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND failed: ${response.status} ${response.statusText}`)
  }
  if (response.status !== 207) {
    throw new Error(`WebDAV PROPFIND expected 207 Multi-Status, received ${response.status}`)
  }
  
  const xmlText = await response.text()
  const multistatusBlocks = extractAllTags(xmlText, 'multistatus')
  if (multistatusBlocks.length !== 1) {
    throw new Error('Malformed WebDAV multistatus response')
  }
  const multistatus = multistatusBlocks[0]
  const responses = extractAllTags(multistatus, 'response')
  if (responses.length === 0 || responses.length !== countOpeningTags(multistatus, 'response')) {
    throw new Error('Incomplete WebDAV multistatus response')
  }
  
  return responses.map((r: string) => {
    const href = decodeXmlEntities(extractTag(r, 'href'))
    if (!href) throw new Error('WebDAV response is missing href')
    let hrefPathname: string
    try {
      hrefPathname = new URL(href, 'http://webdav.invalid').pathname
    } catch {
      throw new Error('WebDAV response contains an invalid href')
    }
    const encodedBasename = hrefPathname.split('/').filter(Boolean).pop() || ''
    let basename: string
    try {
      basename = decodeURIComponent(encodedBasename)
    } catch {
      throw new Error('WebDAV response contains invalid path encoding')
    }
    
    const propstats = extractAllTags(r, 'propstat')
    if (propstats.length !== countOpeningTags(r, 'propstat')) {
      throw new Error(`Incomplete WebDAV properties for ${basename || href}`)
    }
    let prop = ''
    if (propstats.length > 0) {
      const successfulPropstats = propstats.filter(block => {
        const status = parseDavStatus(extractTag(block, 'status'))
        return status === undefined
          ? !options.strictStatus
          : status >= 200 && status < 300
      })
      if (successfulPropstats.length === 0) {
        const status = parseDavStatus(extractTag(propstats[0], 'status'))
        const detail = status === undefined ? 'missing valid status' : String(status)
        throw new Error(`WebDAV properties failed for ${basename || href}: ${detail}`)
      }
      prop = successfulPropstats.map(block => extractTag(block, 'prop')).join('')
    } else {
      const status = parseDavStatus(extractTag(r, 'status'))
      if (options.strictStatus && status === undefined) {
        throw new Error(`WebDAV resource is missing valid status for ${basename || href}`)
      }
      if (status !== undefined && (status < 200 || status >= 300)) {
        throw new Error(`WebDAV resource failed for ${basename || href}: ${status}`)
      }
      prop = extractTag(r, 'prop')
    }
    if (!hasTag(prop, 'resourcetype')) {
      throw new Error(`WebDAV response is missing resource type for ${basename || href}`)
    }
    
    // collection is usually <d:resourcetype><d:collection/></d:resourcetype>
    const resourcetype = extractTag(prop, 'resourcetype')
    const isCollection = /<([^:>]+:)?collection/i.test(resourcetype)
    
    const lastmod = decodeXmlEntities(extractTag(prop, 'getlastmodified'))
    const contentLength = extractTag(prop, 'getcontentlength')
    
    return {
      filename: href,
      basename,
      lastmod: lastmod || '',
      size: parseInt(contentLength || '0', 10),
      type: isCollection ? 'directory' : 'file'
    }
  })
}

export interface DavStreamRequest {
  url: string
  headers: Record<string, string>
}

export interface DavPathOptions {
  mountRelative?: boolean
  legacyEndpointAliases?: boolean
}

export interface DavConnectionTestResult {
  success: boolean
  count?: number
  readChecked?: boolean
  stage?: 'list' | 'read'
  error?: string
  warning?: string
}

export function buildStreamRequest(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): DavStreamRequest {
  const baseUrl = new URL(config.url)
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('Unsupported WebDAV URL protocol')
  }
  baseUrl.username = ''
  baseUrl.password = ''
  baseUrl.search = ''
  baseUrl.hash = ''

  let targetUrl: URL
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) {
    targetUrl = new URL(path)
    targetUrl.pathname = canonicalizePathname(targetUrl.pathname)
    for (const alias of options.legacyEndpointAliases ? config.endpointAliases || [] : []) {
      let aliasUrl: URL
      try {
        aliasUrl = new URL(alias)
      } catch {
        continue
      }
      if (aliasUrl.protocol !== 'http:' && aliasUrl.protocol !== 'https:') continue
      const aliasPath = canonicalizePathname(aliasUrl.pathname)
      if (targetUrl.origin !== aliasUrl.origin || !(
        targetUrl.pathname === aliasPath || targetUrl.pathname.startsWith(aliasPath + '/')
      )) continue
      const relativePath = targetUrl.pathname.substring(aliasPath.length) || '/'
      const search = targetUrl.search
      targetUrl = new URL(baseUrl.toString().replace(/\/$/, '') + relativePath + search)
      break
    }
  } else {
    const base = baseUrl.toString().replace(/\/$/, '')
    const configPathname = canonicalizePathname(baseUrl.pathname)
    let relativePath = canonicalizePathname(path)
    if (!options.mountRelative) {
      const knownMounts = [configPathname, ...(config.mountAliases || []).map(canonicalizePathname)]
        .filter((mount, index, mounts) => mount !== '/' && mounts.indexOf(mount) === index)
        .sort((left, right) => right.length - left.length)
      const matchingMount = knownMounts.find(mount =>
        relativePath === mount || relativePath.startsWith(mount + '/')
      )
      if (matchingMount) {
        relativePath = relativePath.substring(matchingMount.length) || '/'
      }
    }
    targetUrl = new URL(base + relativePath)
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error('Unsupported WebDAV resource protocol')
  }
  if (targetUrl.origin !== baseUrl.origin) {
    throw new Error('Cross-origin WebDAV resource rejected')
  }
  targetUrl.username = ''
  targetUrl.password = ''

  return {
    url: targetUrl.toString(),
    headers: getAuthHeader(config)
  }
}

export function buildStreamUrl(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  return buildStreamRequest(config, path, options).url
}

function normalizeUnicode(value: string): string {
  return typeof value.normalize === 'function' ? value.normalize('NFC') : value
}

function canonicalizePathname(pathname: string): string {
  let canonical: string
  try {
    canonical = pathname
      .split('/')
      .map(segment => segment
        ? encodeURIComponent(normalizeUnicode(decodeURIComponent(segment)))
        : '')
      .join('/')
  } catch {
    throw new Error('Invalid WebDAV resource path encoding')
  }
  if (!canonical.startsWith('/')) canonical = '/' + canonical
  return canonical === '/' ? canonical : canonical.replace(/\/$/, '')
}

export function normalizeDavResourcePath(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  const request = buildStreamRequest(config, path, options)
  const basePath = canonicalizePathname(new URL(config.url).pathname)
  const resourcePath = canonicalizePathname(new URL(request.url).pathname)
  if (resourcePath === basePath) return '/'
  if (basePath !== '/' && !resourcePath.startsWith(basePath + '/')) {
    throw new Error('WebDAV resource path is outside the configured mount')
  }
  return basePath === '/' ? resourcePath : resourcePath.substring(basePath.length)
}

export function normalizeDavScanRoot(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  const resourcePath = normalizeDavResourcePath(config, path, options)
  return resourcePath
    .split('/')
    .map(segment => segment ? normalizeUnicode(decodeURIComponent(segment)) : '')
    .join('/')
}

function requireConfigId(config: DavConfig): string {
  if (!config.id) throw new Error('WebDAV config has no stable identity')
  return config.id
}

export function buildDavResourceKey(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  return `dav-resource:${requireConfigId(config)}:${normalizeDavResourcePath(config, path, options)}`
}

export function buildDavDirectoryKey(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  return `dav-directory:${requireConfigId(config)}:${normalizeDavResourcePath(config, path, options)}`
}

export function buildDavSongDedupKey(
  config: DavConfig,
  path: string,
  options: DavPathOptions = {}
): string {
  return `dav:${requireConfigId(config)}:${normalizeDavResourcePath(config, path, options)}`
}

const MAX_PROBE_DIRECTORIES = 6
const MAX_PROBE_DEPTH = 3
export const MUSIC_FILE_EXTENSIONS = [
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav', '.ape', '.wma',
  '.alac', '.aif', '.aiff', '.mka'
]

function normalizeResourceUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function joinDavPath(parent: string, child: string): string {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/$/, '')
  return `${normalizedParent}/${child}`
}

export function isMusicFile(item: DavItem): boolean {
  const name = item.basename.toLowerCase()
  return item.type === 'file' && MUSIC_FILE_EXTENSIONS.some(ext => name.endsWith(ext))
}

function isInconclusiveRangeProbeError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return message.includes('response body exceeds limit') ||
    message.includes('deadline exceeded') ||
    message.includes('timed out') ||
    message.includes('timeout')
}

async function findProbeFile(
  config: DavConfig,
  rootItems: DavItem[]
): Promise<DavItem | undefined> {
  const queue: Array<{ path: string; depth: number; items?: DavItem[] }> = [
    { path: '/', depth: 0, items: rootItems }
  ]
  let visitedDirectories = 0

  while (queue.length > 0 && visitedDirectories < MAX_PROBE_DIRECTORIES) {
    const current = queue.shift()!
    visitedDirectories += 1

    let items: DavItem[]
    try {
      items = current.items || await propfind(config, current.path)
    } catch {
      continue
    }

    const currentUrl = normalizeResourceUrl(buildStreamUrl(config, current.path))
    const children = items.filter(item => {
      try {
        return normalizeResourceUrl(buildStreamUrl(config, item.filename)) !== currentUrl
      } catch {
        return false
      }
    })

    const musicFile = children.find(isMusicFile)
    if (musicFile) return musicFile

    if (current.depth >= MAX_PROBE_DEPTH) continue
    for (const item of children) {
      if (item.type === 'directory' && item.basename) {
        queue.push({
          path: joinDavPath(current.path, item.basename),
          depth: current.depth + 1
        })
      }
    }
  }

  return undefined
}

export async function testDavConnection(config: DavConfig): Promise<DavConnectionTestResult> {
  let rootItems: DavItem[]
  try {
    rootItems = await propfind(config, '/')
  } catch (e) {
    return { success: false, stage: 'list', error: String(e) }
  }

  const file = await findProbeFile(config, rootItems)
  if (!file) {
    return {
      success: true,
      count: rootItems.length,
      readChecked: false,
      warning: '目录连接正常，但未找到可用于验证读取的音乐文件'
    }
  }

  const request = buildStreamRequest(config, file.filename)
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'GET',
      headers: {
        ...request.headers,
        'Range': 'bytes=0-0',
        'X-Fetch-No-Redirect': '1',
        'X-Fetch-Timeout-Ms': '10000'
      }
    })
  } catch (e) {
    if (isInconclusiveRangeProbeError(e)) {
      return {
        success: true,
        count: rootItems.length,
        readChecked: false,
        warning: '目录连接正常，但服务端未返回可安全探测的音乐片段，文件读取尚未验证'
      }
    }
    return { success: false, stage: 'read', error: `WebDAV 文件读取失败: ${String(e)}` }
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      success: false,
      stage: 'read',
      error: 'WebDAV 文件读取返回重定向；若服务端使用 302 直链，请改为本机代理（native proxy）'
    }
  }
  if (response.status !== 200 && response.status !== 206) {
    return {
      success: false,
      stage: 'read',
      error: `WebDAV 文件读取失败: ${response.status} ${response.statusText}`
    }
  }

  return { success: true, count: rootItems.length, readChecked: true }
}
