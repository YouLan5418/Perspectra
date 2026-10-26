import { readFile, writeFile, access } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'

// The host refuses a knowledge entry longer than knowledge.json maximumCharacters: it injects whole entries
// only, so such an entry could never reach a character. This splits those entries into consecutive parts,
// each within the budget, cutting at paragraphs, then sentences, then hard. Parts keep the original
// audience, usage, keywords, constant flag, priority and when; review the keywords of each part afterwards.
// A document also referenced outside documents/knowledge files is reported, never split.
try {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const maxIndex = args.indexOf('--max')
  const positional = args.filter((arg, index) => !arg.startsWith('--') && (maxIndex < 0 || index !== maxIndex + 1))
  if (positional.length !== 1) throw new Error('usage: split-knowledge.mjs <source-directory> [--max <characters>] [--dry-run]')
  const root = resolve(positional[0])
  const readJson = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
  const source = await readJson('worldpack.source.json')
  if (!source.assetFiles?.includes('knowledge.json')) throw new Error('knowledge.json is not listed in assetFiles')
  const knowledge = await readJson('knowledge.json')
  const limit = maxIndex >= 0 ? Number(args[maxIndex + 1]) : knowledge.maximumCharacters
  if (!Number.isSafeInteger(limit) || limit < 100 || limit > knowledge.maximumCharacters)
    throw new Error(`--max must be an integer from 100 to maximumCharacters (${knowledge.maximumCharacters})`)

  const documentFiles = await Promise.all(source.documentFiles.map(async file => ({ file, data: await readJson(file) })))
  const documents = new Map()
  for (const { file, data } of documentFiles) for (const document of data.documents) documents.set(document.documentId, { file, document })
  // Every other JSON file the pack lists: a document ID quoted there is used for more than knowledge.
  const otherJson = [
    source.worldFile, ...source.characterFiles, ...source.locationFiles, ...source.entityFiles, ...source.sceneFiles,
    ...source.playerSlotFiles, ...source.presentationFiles, ...source.cognitionFiles, ...source.memoryFiles,
    ...(source.assertionFiles ?? []), source.reactionFile, source.manifestationFile, source.interactionFile,
    ...source.assetFiles.filter(file => file.endsWith('.json') && file !== 'knowledge.json'),
  ].filter(Boolean)
  const otherText = (await Promise.all(otherJson.map(file => readFile(join(root, file), 'utf8')))).join('\n')

  const report = { maximumCharacters: knowledge.maximumCharacters, partLimit: limit, split: [], skipped: [] }
  const writes = [] // [path, text], applied only after every entry is planned
  const newEntries = []
  for (const entry of knowledge.entries) {
    newEntries.push(entry)
    const found = documents.get(entry.documentId)
    if (!found) throw new Error(`knowledge entry ${entry.documentId} has no document`)
    const { file: documentFile, document } = found
    const text = await readFile(join(root, document.contentRef), 'utf8')
    if (text.length <= knowledge.maximumCharacters && text.length <= limit) continue
    if (otherText.includes(JSON.stringify(entry.documentId))) {
      report.skipped.push({ documentId: entry.documentId, length: text.length, reason: 'referenced outside documents and knowledge; split by hand' })
      continue
    }
    const parts = split(text, limit)
    const base = document.contentRef.replace(/\.md$/u, '')
    const pad = String(parts.length).length < 3 ? 3 : String(parts.length).length
    const planned = []
    for (let index = 0; index < parts.length; index++) {
      // Part 1 keeps the original ID and file, so anything already pointing at it stays valid.
      const documentId = index === 0 ? document.documentId : `${document.documentId}-part-${String(index + 1).padStart(pad, '0')}`
      const contentRef = index === 0 ? document.contentRef : posix.join(posix.dirname(base), `${posix.basename(base)}.part-${String(index + 1).padStart(pad, '0')}.md`)
      if (index > 0) {
        if (documents.has(documentId)) throw new Error(`document ${documentId} already exists`)
        if (await exists(join(root, contentRef))) throw new Error(`${contentRef} already exists; refusing to overwrite`)
        const copy = { ...document, documentId, contentRef }
        const holder = documentFiles.find(item => item.file === documentFile).data.documents
        holder.splice(holder.indexOf(documents.get(planned.at(-1)?.documentId ?? document.documentId).document) + 1, 0, copy)
        documents.set(documentId, { file: documentFile, document: copy })
        source.markdownFiles.splice(source.markdownFiles.indexOf(planned.at(-1)?.contentRef ?? document.contentRef) + 1, 0, contentRef)
        newEntries.push({ ...entry, documentId })
      }
      writes.push([contentRef, parts[index]])
      planned.push({ documentId, contentRef, length: parts[index].length })
    }
    report.split.push({ documentId: entry.documentId, length: text.length, parts: planned })
  }
  if (!dryRun && report.split.length) {
    for (const [path, text] of writes) await writeFile(join(root, path), text)
    for (const { file, data } of documentFiles) await writeFile(join(root, file), JSON.stringify(data, null, 2) + '\n')
    await writeFile(join(root, 'knowledge.json'), JSON.stringify({ ...knowledge, entries: newEntries }, null, 2) + '\n')
    await writeFile(join(root, 'worldpack.source.json'), JSON.stringify(source, null, 2) + '\n')
  }
  console.log(JSON.stringify({ ...report, written: !dryRun && report.split.length > 0 }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

/** Greedy pieces of at most `limit` UTF-16 units, the unit the host measures with. */
function split(text, limit) {
  const pieces = []
  const pack = units => {
    let current = ''
    for (const unit of units) {
      if (current.length + unit.length <= limit) current += unit
      else {
        if (current) pieces.push(current)
        current = unit
      }
    }
    if (current) pieces.push(current)
  }
  const fit = unit => {
    if (unit.length <= limit) return [unit]
    const sentences = unit.match(/[^。！？!?\n]*[。！？!?\n]+|[^。！？!?\n]+$/gu) ?? [unit]
    return sentences.flatMap(sentence =>
      sentence.length <= limit ? [sentence] : Array.from({ length: Math.ceil(sentence.length / limit) }, (_, i) => sentence.slice(i * limit, (i + 1) * limit)),
    )
  }
  // Paragraphs keep their trailing blank lines so rejoining the parts gives back the original text.
  const paragraphs = text.match(/[\s\S]*?(?:\n\s*\n|$)/gu).filter(Boolean)
  pack(paragraphs.flatMap(fit))
  return pieces
}
