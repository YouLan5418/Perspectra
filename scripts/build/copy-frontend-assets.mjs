import { cp, mkdir } from 'node:fs/promises'
await mkdir('dist/backend/frontend-assets', { recursive: true })
await cp('packages/frontend/assets', 'dist/backend/frontend-assets', { recursive: true })
