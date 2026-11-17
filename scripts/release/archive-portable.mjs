import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep, join } from 'node:path'
import { createDeflateRaw, createInflateRaw } from 'node:zlib'
import { Transform, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'

if (!process.argv[2]) throw new Error('usage: archive-portable.mjs <program-root>')
const root = resolve(process.argv[2]),
  zip = root + '.zip',
  checksum = zip + '.sha256'
await access(join(root, '验收记录.md'))
const buildInfo = JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'))
if (buildInfo.memoryRuntime !== 'Node worker' || !buildInfo.onnxruntimeNode)
  throw new Error('Refusing to archive a package without the Node memory runtime.')
// A native launch from this folder writes player data to its default data directory.
if (await exists(join(root, 'data')))
  throw new Error('Package contains a data folder from a local launch; rebuild or remove it before archiving.')
if (await exists(zip)) throw new Error('Archive already exists; choose a new release path.')
if (await exists(checksum)) throw new Error('SHA-256 file already exists; choose a new release path.')

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crcUpdate = (crc, bytes) => {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}
const dosDateTime = date => {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  }
}
const u16 = (buffer, offset, value) => buffer.writeUInt16LE(value, offset)
const u32 = (buffer, offset, value) => buffer.writeUInt32LE(value >>> 0, offset)
const maxZip32 = 0xffffffff
const files = []
async function collect(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === '__pycache__') continue
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error('Link rejected: ' + path)
    if (info.isDirectory()) await collect(path)
    else if (info.isFile()) files.push({ path, info })
    else throw new Error('Non-file entry rejected: ' + path)
  }
}
await collect(root)
if (files.length > 0xffff) throw new Error('Archive contains too many files for ZIP32.')
for (const { path } of files) {
  const name = relative(root, path).split(sep).join('/')
  if (/\.(?:py|pyc)$/iu.test(name) || /(?:^|\/)(?:python|__pycache__)(?:\/|$)/iu.test(name))
    throw new Error('Python runtime/source is not allowed in the Node-only release: ' + name)
}

const output = createWriteStream(zip, { flags: 'wx' })
const outputDone = finished(output)
let offset = 0
const write = async bytes => {
  if (offset + bytes.length > maxZip32) throw new Error('Archive exceeds ZIP32 size limits.')
  await new Promise((done, reject) => output.write(bytes, error => (error ? reject(error) : done())))
  offset += bytes.length
}
const records = []
try {
  for (const { path, info } of files) {
    const name = Buffer.from(`${basename(root)}/${relative(root, path).split(sep).join('/')}`, 'utf8')
    if (name.length > 0xffff) throw new Error('Archive path is too long: ' + path)
    const { date, time } = dosDateTime(info.mtime)
    const localOffset = offset
    const flags = 0x0808 // UTF-8 names and a trailing data descriptor.
    const local = Buffer.alloc(30)
    u32(local, 0, 0x04034b50)
    u16(local, 4, 20)
    u16(local, 6, flags)
    u16(local, 8, 8)
    u16(local, 10, time)
    u16(local, 12, date)
    u16(local, 26, name.length)
    await write(local)
    await write(name)

    let crc = 0xffffffff,
      uncompressedSize = 0,
      compressedSize = 0
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        crc = crcUpdate(crc, chunk)
        uncompressedSize += chunk.length
        if (uncompressedSize > maxZip32) done(new Error('File exceeds ZIP32 size limits: ' + path))
        else done(null, chunk)
      },
    })
    const deflater = createDeflateRaw({ level: 6 })
    const encoding = pipeline(createReadStream(path), meter, deflater)
    for await (const chunk of deflater) {
      compressedSize += chunk.length
      if (compressedSize > maxZip32) throw new Error('Compressed file exceeds ZIP32 size limits: ' + path)
      await write(chunk)
    }
    await encoding
    crc = (crc ^ 0xffffffff) >>> 0
    const descriptor = Buffer.alloc(16)
    u32(descriptor, 0, 0x08074b50)
    u32(descriptor, 4, crc)
    u32(descriptor, 8, compressedSize)
    u32(descriptor, 12, uncompressedSize)
    await write(descriptor)
    records.push({
      name,
      flags,
      date,
      time,
      localOffset,
      dataOffset: localOffset + 30 + name.length,
      crc,
      compressedSize,
      uncompressedSize,
    })
  }

  const centralOffset = offset
  for (const item of records) {
    const header = Buffer.alloc(46)
    u32(header, 0, 0x02014b50)
    u16(header, 4, 0x031e) // Unix creator, version 3.0.
    u16(header, 6, 20)
    u16(header, 8, item.flags)
    u16(header, 10, 8)
    u16(header, 12, item.time)
    u16(header, 14, item.date)
    u32(header, 16, item.crc)
    u32(header, 20, item.compressedSize)
    u32(header, 24, item.uncompressedSize)
    u16(header, 28, item.name.length)
    u32(header, 38, 0x81a40000) // Regular file, mode 0644.
    u32(header, 42, item.localOffset)
    await write(header)
    await write(item.name)
  }
  const centralSize = offset - centralOffset
  if (centralOffset > maxZip32 || centralSize > maxZip32) throw new Error('Archive exceeds ZIP32 size limits.')
  const end = Buffer.alloc(22)
  u32(end, 0, 0x06054b50)
  u16(end, 8, records.length)
  u16(end, 10, records.length)
  u32(end, 12, centralSize)
  u32(end, 16, centralOffset)
  await write(end)
  output.end()
  await outputDone

  for (const item of records) {
    let actualCrc = 0xffffffff,
      actualSize = 0
    const check = new Writable({
      write(chunk, _encoding, done) {
        actualCrc = crcUpdate(actualCrc, chunk)
        actualSize += chunk.length
        done()
      },
    })
    const end = item.dataOffset + item.compressedSize - 1
    await pipeline(createReadStream(zip, { start: item.dataOffset, end }), createInflateRaw(), check)
    actualCrc = (actualCrc ^ 0xffffffff) >>> 0
    if (actualCrc !== item.crc || actualSize !== item.uncompressedSize)
      throw new Error('ZIP CRC failed: ' + item.name.toString('utf8'))
  }
} catch (error) {
  output.destroy()
  await outputDone.catch(() => {})
  await rm(zip, { force: true })
  throw error
}

const hash = createHash('sha256')
for await (const bytes of createReadStream(zip)) hash.update(bytes)
await writeFile(checksum, hash.digest('hex') + '  ' + basename(zip) + '\n', { flag: 'wx' })
console.log('ZIP CRC verified; ' + files.length + ' files')
console.log('SHA-256 written: ' + checksum)

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
