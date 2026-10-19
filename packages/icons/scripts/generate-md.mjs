import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { $ } from 'zx'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('@material-symbols/svg-400/outlined/home.svg'))

await rm('md', { recursive: true, force: true })
await $`pnpm exec svgr --filename-case kebab --typescript --jsx-runtime automatic --svgo-config svgo.config.json --out-dir md -- ${source}`
