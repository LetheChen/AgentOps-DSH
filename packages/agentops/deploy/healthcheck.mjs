#!/usr/bin/env node
/**
 * Container healthcheck: HTTP GET or TCP connect, exit 0 on success.
 *
 * Uses runtime built-ins (fetch / net) so the image needs no curl or wget.
 *
 *   node healthcheck.mjs http://127.0.0.1:8791/health
 *   node healthcheck.mjs tcp://127.0.0.1:3080
 */

import { connect } from 'node:net'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: healthcheck.mjs <http(s)://… | tcp://host:port>')
  process.exit(2)
}

/** TCP probe: succeeds when the port accepts a connection. */
function probeTcp(url) {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

let ok = false
try {
  if (target.startsWith('tcp://')) {
    ok = await probeTcp(target)
  } else {
    const response = await fetch(target, { signal: AbortSignal.timeout(3000) })
    ok = response.ok
  }
} catch (error) {
  console.error(String(error))
  ok = false
}

process.exit(ok ? 0 : 1)
