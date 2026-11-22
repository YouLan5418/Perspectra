import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { locked, writeAtomic } from './source-files.ts'
import { isDeepStrictEqual } from 'node:util'
import { checkPageTargets, readPageElements } from '../runtime/activity-page-elements.ts'
import {
  activityPageAssets,
  activityPage,
  activityAssetPath,
  activityPagesFile,
  readActivityPages,
} from '../runtime/activity-pages.ts'
import { packActivityCatalog, checkPageOperations } from '../runtime/activity-page-catalog.ts'
import { EditConflict, packPath, readProject } from './project.ts'

export function pageBindings(root: string) {
  const file = packPath(root, activityPagesFile)
  return readActivityPages(existsSync(file) ? readFileSync(file) : undefined)
}
function pageFiles(root: string) {
  const files: string[] = []
  function visit(dir: string) {
    for (const entry of readdirSync(packPath(root, 'frontend/' + dir), { withFileTypes: true })) {
      const path = dir + '/' + entry.name
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(html|css|png|jpe?g|webp|gif|svg)$/i.test(path)) files.push(path)
    }
  }
  if (existsSync(packPath(root, 'frontend/activities'))) visit('activities')
  return files.sort()
}
export function withDraftActivities(
  menus: Awaited<ReturnType<typeof packActivityCatalog>>,
  project: ReturnType<typeof readProject>,
) {
  for (const g of project.graphs)
    menus.set(g.key, {
      title: g.title,
      phases: ['choice'],
      operations: g.choices.map(c => ({ id: 'activity:' + c.id, label: c.label })),
    })
  return menus
}
export async function activityPages(source: string) {
  const root = realpathSync(source),
    project = readProject(root),
    menus = withDraftActivities(await packActivityCatalog(root), project)
  return {
    activities: [...menus].map(([key, menu]) => ({ key, title: menu.title })),
    declarations: Object.fromEntries(menus),
    files: pageFiles(root),
    bindings: pageBindings(root),
    characters: project.characters,
    scenes: project.scenes,
  }
}
export async function saveActivityPage(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    book = await activityPages(root),
    key = body.key
  if (
    typeof key !== 'string' ||
    !key ||
    (!book.activities.some(a => a.key === key) && !(body.page === null && Object.hasOwn(book.bindings, key)))
  )
    throw new TypeError('请选择包内活动')
  const next = body.page === null ? null : activityPage(body.page),
    base = body.base === null ? null : activityPage(body.base)
  return locked(root, () => {
    const pages = pageBindings(root),
      current = Object.hasOwn(pages, key) ? pages[key]! : null
    if (!isDeepStrictEqual(base, current) && !isDeepStrictEqual(next, current))
      throw new EditConflict(key, base, current, next)
    if (next) {
      for (const f of activityPageAssets(next))
        if (
          f &&
          (!book.files.includes(f) || !lstatSync(packPath(root, 'frontend/' + f), { throwIfNoEntry: false })?.isFile())
        )
          throw new TypeError('找不到页面资源：' + f)
      const layout = readPageElements(readFileSync(packPath(root, 'frontend/' + next.html), 'utf8'))
      checkPageTargets(layout, next.elements ?? [])
      checkPageOperations(next, book.declarations[key]!, layout)
      Object.defineProperty(pages, key, { value: next, enumerable: true, configurable: true, writable: true })
    } else delete pages[key]
    if (!isDeepStrictEqual(next, current)) writeAtomic(root, activityPagesFile, JSON.stringify(pages, null, 2) + '\n')
    return { key, page: next }
  })
}
export function importActivityPageFile(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    name = String(body.path).toLowerCase()
  const kind = name.endsWith('.css') ? 'css' : name.endsWith('.html') ? 'html' : 'image',
    path = activityAssetPath(body.path, kind)
  let bytes: Buffer
  if (kind === 'image') {
    if (
      typeof body.base64 !== 'string' ||
      !body.base64.length ||
      body.base64.length > Math.ceil((4 * 1024 * 1024) / 3) * 4
    )
      throw new TypeError('请提供最多 4 MiB 的图片')
    bytes = Buffer.from(body.base64, 'base64')
    if (bytes.toString('base64') !== body.base64) throw new TypeError('图片数据格式无效')
  } else {
    if (typeof body.text !== 'string') throw new TypeError('请提供 HTML 或 CSS 文本')
    bytes = Buffer.from(body.text)
  }
  if (bytes.length > 4 * 1024 * 1024) throw new TypeError('每次可导入最多 4 MiB 的文件')
  return locked(root, () => {
    const file = packPath(root, 'frontend/' + path)
    if (existsSync(file)) {
      if (readFileSync(file).equals(bytes)) return { path }
      throw new TypeError('已有同名文件，请改名或在源文件中编辑：' + path)
    }
    writeAtomic(root, 'frontend/' + path, bytes)
    return { path }
  })
}
