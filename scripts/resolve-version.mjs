import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function normalizeReleaseVersion(rawVersion) {
  const version = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid release version ${JSON.stringify(rawVersion)}; expected x.y.z or vx.y.z`,
    )
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(normalizeReleaseVersion(process.argv[2] ?? ''))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
