import { songloft } from '@songloft/plugin-sdk'
import { DavConfig } from './config'

function getBasicAuth(str: string): string {
  try {
    return globalThis.btoa(str)
  } catch {
    return ''
  }
}

function getAuthHeader(config: DavConfig): HeadersInit {
  if (config.username && config.password) {
    try {
      const basic = getBasicAuth(`${config.username}:${config.password}`)
      return { 'Authorization': `Basic ${basic}` }
    } catch {
      return {}
    }
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
  const reg = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?${tag}>`, 'i')
  const match = xml.match(reg)
  return match ? match[1] : ''
}

function extractAllTags(xml: string, tag: string): string[] {
  // Regex to match opening and closing tags, taking namespace into account optionally.
  // We use a global match and loop to get the content.
  const results: string[] = []
  const reg = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?${tag}>`, 'gi')
  let match
  while ((match = reg.exec(xml)) !== null) {
    results.push(match[1])
  }
  return results
}

export async function propfind(config: DavConfig, path: string): Promise<DavItem[]> {
  const url = config.url.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
  const headers = getAuthHeader(config)
  const reqUrl = url.replace(/([^:])\/\//g, '$1/')
  
  const response = await fetch(reqUrl, {
    method: 'PROPFIND',
    headers: {
      ...headers,
      'Depth': '1'
    }
  })
  
  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND failed: ${response.status} ${response.statusText}`)
  }
  
  const xmlText = await response.text()
  const responses = extractAllTags(xmlText, 'response')
  
  return responses.map((r: string) => {
    const href = extractTag(r, 'href')
    const decodedHref = decodeURIComponent(href)
    let basename = decodedHref.split('/').filter(Boolean).pop() || ''
    
    // Check if it's a collection
    const propstat = extractTag(r, 'propstat')
    const prop = extractTag(propstat, 'prop')
    
    // collection is usually <d:resourcetype><d:collection/></d:resourcetype>
    const resourcetype = extractTag(prop, 'resourcetype')
    const isCollection = /<([^:>]+:)?collection/i.test(resourcetype)
    
    const lastmod = extractTag(prop, 'getlastmodified')
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

export function buildStreamUrl(config: DavConfig, path: string): string {
  let urlObj: URL
  try {
    urlObj = new URL(path)
  } catch {
    urlObj = new URL(config.url)
    const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/')
    urlObj.pathname = (urlObj.pathname.replace(/\/$/, '') + (encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath)).replace(/\/+/g, '/')
  }
  
  if (config.username && config.password) {
    urlObj.username = config.username
    urlObj.password = config.password
  }
  
  return urlObj.toString()
}
