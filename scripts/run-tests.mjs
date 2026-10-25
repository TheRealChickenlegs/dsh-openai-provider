/**
 * Run every `test/*.test.mjs` in one Node process, failing on the first file that
 * exits non-zero. Node's built-in test runner needs no extra dependency.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const dir = path.join(process.cwd(), 'test')
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.error(`FAILED ${file}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed`)
  process.exit(1)
}
console.log(`\n${files.length} test file(s) passed`)
