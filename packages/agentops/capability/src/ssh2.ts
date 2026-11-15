/**
 * Interop access to the `ssh2` CommonJS exports.
 *
 * `ssh2` ships CommonJS, and Node's static named-export detection exposes only
 * part of its surface — `Client` is importable as a named export while `Server`
 * is not. Loading the module through `createRequire` keeps every export
 * addressable from this ESM package.
 *
 * @module @agentops/dsh-capability/ssh2
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const ssh2 = require('ssh2') as typeof import('ssh2')

/** ssh2 client constructor. */
export const Client = ssh2.Client

/** ssh2 server constructor. */
export const Server = ssh2.Server
