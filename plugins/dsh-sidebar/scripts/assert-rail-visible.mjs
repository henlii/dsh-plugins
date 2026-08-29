#!/usr/bin/env node
// Official layout defaults details to 0px. The 44px icon rail is
// position:fixed so it stays clickable while the column is closed.
// contain:layout on the slot root makes that fixed rail a descendant of
// the 0-width overflow:hidden details column, so the whole right sidebar
// disappears. Paint isolation belongs on the content body, not the root.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const client = readFileSync(join(dir, '../src/client.js'), 'utf8')

const rootRules = [...client.matchAll(/\[data-dsh-sidebar-root\]\{[^}]*\}/g)].map((m) => m[0])
if (rootRules.length === 0) {
  console.error('sidebar rail: missing [data-dsh-sidebar-root] rule')
  process.exit(1)
}
if (rootRules.some((rule) => /contain\s*:\s*layout/.test(rule))) {
  console.error('sidebar rail: contain:layout on the slot root traps the fixed rail in the 0-width details column')
  process.exit(1)
}
if (!client.includes('.dsh-sb-rail{position:fixed')) {
  console.error('sidebar rail: expected a viewport-fixed 44px rail while details is collapsed')
  process.exit(1)
}
if (!/useEffect\(\s*\(\)\s*=>\s*\{[^}]*openDetails[\s\S]*?\},\s*\[sessionId\]\)/.test(client)) {
  console.error('sidebar rail: expected openDetails on session mount so the details column is not left at 0')
  process.exit(1)
}
if (!client.includes('const inject = ["slots", "layout"]')) {
  console.error('sidebar rail: expected cordis inject of layout so openDetails is wired')
  process.exit(1)
}
console.log('sidebar rail: ok')
