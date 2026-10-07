import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { preflightSave } from './save-preflight.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [packPath, dataDirectory] = process.argv.slice(2)
  if (!packPath || !dataDirectory) throw new Error('preflight requires pack path and data directory')
  try {
    process.stdout.write(JSON.stringify(await preflightSave(packPath, dataDirectory)) + '\n')
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : '存档预检失败')
    process.exitCode = 1
  }
}
