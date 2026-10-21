import { cp, mkdir } from 'node:fs/promises'
import { copyMemoryRuntime } from './copy-memory-runtime.mjs'
await mkdir('dist/backend/frontend-assets', { recursive: true })
await cp('packages/frontend/assets', 'dist/backend/frontend-assets', { recursive: true })
await copyMemoryRuntime('dist/backend')
