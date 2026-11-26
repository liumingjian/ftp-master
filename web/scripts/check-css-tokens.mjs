// Fails when any stylesheet under web/src/ (other than tokens.css) uses
// hardcoded typography literals instead of the canonical tokens in tokens.css.
// Runs as part of `pnpm typecheck`, `pnpm build`, and CI.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(web, 'src')

const allowed = {
  'font-family': /^(var\(--font-(?:sans|mono)\)|inherit)$/,
  'font-size': /^(var\(--text-(?:2xs|xs|sm|base|md|lg|xl|2xl)\)|inherit)$/,
  'font-weight': /^(var\(--weight-(?:regular|medium|semibold)\)|inherit)$/,
  'line-height': /^(var\(--leading-(?:none|tight|snug|normal)\)|inherit|normal)$/,
}

const propRe = /^\s*(font-family|font-size|font-weight|line-height)\s*:\s*([^;]+?)\s*;/

const findings = []
for (const file of cssFiles(src)) {
  const rel = relative(src, file)
  if (rel === 'tokens.css') continue
  // Replace block comments with equivalent newlines to preserve line numbers.
  const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const lines = stripped.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = propRe.exec(lines[i])
    if (!m) continue
    const [, prop, value] = m
    if (!allowed[prop].test(value)) {
      findings.push(`${relative(web, file)}:${i + 1} uses hardcoded ${prop}: ${value}`)
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`${f}; use a typography token from src/tokens.css instead`)
  }
  process.exit(1)
}

function* cssFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* cssFiles(path)
    else if (entry.name.endsWith('.css')) yield path
  }
}
