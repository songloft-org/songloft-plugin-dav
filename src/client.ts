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
  // Build the raw URL string without relying on URL object mutation
  // (the JS polyfill in quickjs does not update href when setting pathname/username/password)
  let rawUrl: string
  if (path.startsWith('http')) {
    rawUrl = path
  } else {
    const base = config.url.replace(/\/$/, '')
    const encodedPath = path.split('/').map((s: string) => s ? encodeURIComponent(s) : '').join('/')
    const normalizedPath = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath
    rawUrl = (base + normalizedPath).replace(/([^:])\/\/+/g, '$1/')
  }

  if (config.username && config.password) {
    // Inject credentials as http://user:pass@host/path
    const protoMatch = rawUrl.match(/^(https?:\/\/)(.*)$/)
    if (protoMatch) {
      const encodedUser = encodeURIComponent(config.username)
      const encodedPass = encodeURIComponent(config.password)
      // Strip any existing userinfo from the captured host+path part
      const rest = protoMatch[2].replace(/^[^@]*@/, '')
      rawUrl = protoMatch[1] + encodedUser + ':' + encodedPass + '@' + rest
    }
  }

  return rawUrl
}
