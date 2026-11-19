// Fails when code under src/ reads or waits on the wall clock directly.
// Time-dependent code must read time through one injectable Clock, the same
// rule backend/internal/clock enforces for the service. The web app has no
// time-dependent code yet; the first one to need it adds src/clock.ts and
// lists it in clockModules below.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(web, 'src')
const clockModules = new Set([])

// Globals whose call reads or waits on the wall clock.
const bannedCalls = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame'])
// object.method pairs that read the wall clock.
const bannedMembers = new Set(['Date.now', 'performance.now'])

const findings = []
for (const path of sourceFiles(src)) {
  if (clockModules.has(relative(src, path)) || path.endsWith('.gen.ts')) continue
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const report = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart())
    findings.push(`${relative(web, path)}:${line + 1} uses ${what}`)
  }
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = `${node.expression.getText(source)}.${node.name.text}`
      const bare = name.replace(/^(window|globalThis)\./, '')
      if (bannedMembers.has(bare)) report(node, name)
      else if (bannedCalls.has(bare) && /^(window|globalThis)\./.test(name)) report(node, name)
    } else if (ts.isIdentifier(node) && bannedCalls.has(node.text) && !ts.isPropertyAccessExpression(node.parent)) {
      report(node, node.text)
    } else if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date' && !node.arguments?.length) {
      report(node, 'new Date()')
    } else if (ts.isCallExpression(node) && node.expression.getText(source) === 'Date') {
      report(node, 'Date()')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (findings.length > 0) {
  for (const f of findings) console.error(`${f}; read time through an injectable Clock instead`)
  process.exit(1)
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path
  }
}
