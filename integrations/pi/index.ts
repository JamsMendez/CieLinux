// pi entry point (loaded by pi through jiti; nothing is built). Supplies the
// real I/O to the extension in `extension.ts`. The factory only registers
// handlers: no timers, sockets or requests start until `session_start`.
//
// Types are local (`PiLike` in extension.ts) rather than imported from
// '@earendil-works/pi-coding-agent', so a copied install needs no node_modules.

import { access, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cieLinuxScenes, type Io, type PiLike } from './extension.ts'

/** A request to CieLinux (a local socket) that takes longer than this is abandoned. */
const REQUEST_TIMEOUT_MS = 3000

const extensionRoot = (): string => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return '.'
  }
}

const nodeIo = (): Io => ({
  fetch: async (url, init) => {
    const response = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    let text: string | undefined
    try {
      text = await response.text()
    } catch {
      text = undefined
    }
    return { status: response.status, text }
  },
  readFile: async path => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
  exists: async path => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms)
    // Never keep pi alive just to send a scene (print mode exits when done).
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  },
  sleep: ms =>
    new Promise(resolve => {
      setTimeout(resolve, ms).unref?.()
    }),
})

export default function (pi: PiLike): void {
  try {
    cieLinuxScenes(pi, { io: nodeIo(), env: process.env, root: extensionRoot() })
  } catch {
    // Never break pi's startup over wallpaper feedback.
  }
}
