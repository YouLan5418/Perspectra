import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { packPath } from './project.ts'
export function writeAtomic(root: string, path: string, text: string | Buffer) {
  const to = packPath(root, path),
    temp = packPath(root, path + '.' + randomUUID() + '.tmp')
  mkdirSync(dirname(to), { recursive: true })
  try {
    writeFileSync(temp, text, { flag: 'wx' })
    renameSync(temp, to)
  } finally {
    rmSync(temp, { force: true })
  }
}
export function acquireSourceLock(root: string) {
  const path = packPath(root, '.perspectra-editor-save.lock')
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('另一编辑正在保存，请稍后重试')
    throw e
  }
  return () => {
    closeSync(fd)
    rmSync(path, { force: true })
  }
}
export function locked<T>(root: string, update: () => T): T {
  const release = acquireSourceLock(root)
  try {
    return update()
  } finally {
    release()
  }
}
