import { songloft } from '@songloft/plugin-sdk'
import { DavConfig } from './config'

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

export async function propfind(config: DavConfig, path: string): Promise<DavItem[]> {
  const encodedPath = path.split('/').map((s: string) => s ? encodeURIComponent(s) : '').join('/')
  const url = config.url.replace(/\/$/, '') + (encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath)
  const headers = getAuthHeader(config)
  const reqUrl = url.replace(/([^:])\/\//g, '$1/')
  
  const response = await fetch(reqUrl, {
    method: 'PROPFIND',
    headers: {
      ...headers,
      'Depth': '1',
      'X-Fetch-No-Redirect': '1'
    }
  })
  
  if (response.status >= 300 && response.status < 400) {
    throw new Error('WebDAV PROPFIND redirect rejected')
  }
  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND failed: ${response.status} ${response.statusText}`)
  }
  
  const xmlText = await response.text()
  const responses = extractAllTags(xmlText, 'response')
  
  return responses.map((r: string) => {
    const href = decodeXmlEntities(extractTag(r, 'href'))
    const decodedHref = decodeURIComponent(href)
    let basename = decodedHref.split('/').filter(Boolean).pop() || ''
    
    // Check if it's a collection
    const propstat = extractTag(r, 'propstat')
    const prop = extractTag(propstat, 'prop')
    
    // collection is usually <d:resourcetype><d:collection/></d:resourcetype>
    const resourcetype = extractTag(prop, 'resourcetype')
    const isCollection = /<([^:>]+:)?collection/i.test(resourcetype)
    
    const lastmod = decodeXmlEntities(extractTag(prop, 'getlastmodified'))
    const contentLength = extractTag(prop, 'getcontentlength')
    
    return {
      filename: decodedHref,
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

export interface DavConnectionTestResult {
  success: boolean
  count?: number
  readChecked?: boolean
  stage?: 'list' | 'read'
  error?: string
  warning?: string
}

export function buildStreamRequest(config: DavConfig, path: string): DavStreamRequest {
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
  } else {
    const base = baseUrl.toString().replace(/\/$/, '')
    const configPathname = decodeURIComponent(baseUrl.pathname).replace(/\/$/, '')
    let relativePath = path
    if (configPathname && configPathname !== '/' && relativePath.startsWith(configPathname + '/')) {
      relativePath = relativePath.substring(configPathname.length)
    }
    const encodedPath = relativePath
      .split('/')
      .map((segment: string) => segment ? encodeURIComponent(segment) : '')
      .join('/')
    const normalizedPath = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath
    targetUrl = new URL(base + normalizedPath)
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

export function buildStreamUrl(config: DavConfig, path: string): string {
  return buildStreamRequest(config, path).url
}

const MAX_PROBE_DIRECTORIES = 6
const MAX_PROBE_DEPTH = 3
const MUSIC_FILE_EXTENSIONS = [
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.ape', '.wma', '.alac'
]

function normalizeResourceUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function joinDavPath(parent: string, child: string): string {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/$/, '')
  return `${normalizedParent}/${child}`
}

function isMusicFile(item: DavItem): boolean {
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
