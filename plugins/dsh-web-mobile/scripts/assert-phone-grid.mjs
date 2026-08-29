#!/usr/bin/env node
// Regression: display:none on side columns while the frame is still a
// 3-track grid (`0 1fr 0`) auto-places the conversation column into the
// first 0-width track — the phone main view goes blank.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const client = readFileSync(join(dir, '../src/client.js'), 'utf8')
const threeCol = client.includes('grid-template-columns:0 minmax(0,1fr) 0')
const noneSide = client.includes('[class$="sidebarCol"]{display:none')
  || client.includes('[class$=\\"sidebarCol\\"]{display:none')
if (threeCol && noneSide) {
  console.error('phone grid: 3-track template + display:none on sidebarCol collapses the chat column to 0 width')
  process.exit(1)
}
if (!client.includes('grid-template-columns:minmax(0,1fr)')) {
  console.error('phone grid: expected a single 1fr track while side columns are display:none')
  process.exit(1)
}
console.log('phone grid: ok')
