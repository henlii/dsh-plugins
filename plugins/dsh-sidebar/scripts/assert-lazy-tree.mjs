#!/usr/bin/env node
// File tree must list one directory at a time with no entry/depth cap.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const host = readFileSync(join(dir, '../src/index.js'), 'utf8')
const client = readFileSync(join(dir, '../src/client.js'), 'utf8')

if (!host.includes('${API_PREFIX}/listdir')) {
  console.error('lazy tree: missing /api/dsh-sidebar/listdir route')
  process.exit(1)
}
if (!host.includes('async function listLevel')) {
  console.error('lazy tree: missing one-level listLevel')
  process.exit(1)
}
if (host.includes('maxEntries') || host.includes('maxDepth')) {
  console.error('lazy tree: host still has quantity/depth caps')
  process.exit(1)
}
if (host.includes('await buildTree(') || host.includes('function buildTree')) {
  console.error('lazy tree: recursive buildTree must not remain')
  process.exit(1)
}
if (!client.includes('fileRpc("listdir"') && !client.includes("fileRpc('listdir'")) {
  console.error('lazy tree: client must fetch listdir when expanding a folder')
  process.exit(1)
}
if (client.includes('最大条目数') || client.includes('最大深度')) {
  console.error('lazy tree: settings UI still exposes quantity/depth caps')
  process.exit(1)
}
if (client.includes('maxEntries') || /maxDepth/.test(client)) {
  console.error('lazy tree: client still carries quantity/depth caps')
  process.exit(1)
}
console.log('lazy tree: ok')
