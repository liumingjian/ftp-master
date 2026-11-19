// Fails when src/api/schema.gen.ts was not regenerated after api/openapi.yaml
// changed. Runs before every build, so contract drift fails the frontend build.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const committed = join(web, 'src', 'api', 'schema.gen.ts')
const dir = mkdtempSync(join(tmpdir(), 'ftp-master-api-'))
const fresh = join(dir, 'schema.gen.ts')

try {
  execFileSync(join(web, 'node_modules', '.bin', 'openapi-typescript'), [join(web, '..', 'api', 'openapi.yaml'), '-o', fresh], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (readFileSync(fresh, 'utf8') !== readFileSync(committed, 'utf8')) {
    console.error('api/openapi.yaml and web/src/api/schema.gen.ts disagree; run `make generate`')
    process.exit(1)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
