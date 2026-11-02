import { createReadStream } from 'fs'
import { open } from 'fs/promises'
import { Readable } from 'stream'
import { createInflateRaw } from 'zlib'

// Enough of the ZIP format to stream one entry out of an archive. The source archives
// (AMSA, Piraeus, Geoscience Australia) are all plain stored/deflated ZIPs under 4 GB.
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff
const EOCD_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff
const CENTRAL_HEADER_LENGTH = 46
const LOCAL_HEADER_LENGTH = 30
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

export async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const file = await open(zipPath, 'r')
  try {
    const { size } = await file.stat()
    const tailLength = Math.min(size, EOCD_LENGTH + MAX_COMMENT_LENGTH)
    const tail = Buffer.alloc(tailLength)
    await file.read(tail, 0, tailLength, size - tailLength)

    let eocd = -1
    for (let i = tailLength - EOCD_LENGTH; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) {
      throw new Error(`${zipPath} is not a ZIP archive`)
    }

    const count = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
      throw new Error(`${zipPath} is a ZIP64 archive, which is not supported`)
    }

    const directory = Buffer.alloc(directorySize)
    await file.read(directory, 0, directorySize, directoryOffset)

    const entries: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (directory.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
        throw new Error(`${zipPath}: damaged central directory`)
      }
      const nameLength = directory.readUInt16LE(p + 28)
      const extraLength = directory.readUInt16LE(p + 30)
      const commentLength = directory.readUInt16LE(p + 32)
      const entry: ZipEntry = {
        name: directory.toString(
          'utf8',
          p + CENTRAL_HEADER_LENGTH,
          p + CENTRAL_HEADER_LENGTH + nameLength
        ),
        method: directory.readUInt16LE(p + 10),
        compressedSize: directory.readUInt32LE(p + 20),
        size: directory.readUInt32LE(p + 24),
        localHeaderOffset: directory.readUInt32LE(p + 42)
      }
      if (
        entry.compressedSize === ZIP64_MARKER ||
        entry.size === ZIP64_MARKER ||
        entry.localHeaderOffset === ZIP64_MARKER
      ) {
        throw new Error(
          `${zipPath}: ${entry.name} needs ZIP64, which is not supported`
        )
      }
      entries.push(entry)
      p += CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength
    }
    return entries
  } finally {
    await file.close()
  }
}

export async function openZipEntry(
  zipPath: string,
  name: string
): Promise<Readable> {
  const entry = (await listZipEntries(zipPath)).find((e) => e.name === name)
  if (!entry) {
    throw new Error(`${zipPath} has no entry named ${name}`)
  }

  const file = await open(zipPath, 'r')
  const header = Buffer.alloc(LOCAL_HEADER_LENGTH)
  try {
    await file.read(header, 0, LOCAL_HEADER_LENGTH, entry.localHeaderOffset)
  } finally {
    await file.close()
  }
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`${zipPath}: damaged local header for ${name}`)
  }

  const start =
    entry.localHeaderOffset +
    LOCAL_HEADER_LENGTH +
    header.readUInt16LE(26) +
    header.readUInt16LE(28)
  if (entry.compressedSize === 0) {
    return Readable.from([])
  }
  const raw = createReadStream(zipPath, {
    start,
    end: start + entry.compressedSize - 1
  })

  if (entry.method === METHOD_STORED) {
    return raw
  }
  if (entry.method === METHOD_DEFLATE) {
    return raw.pipe(createInflateRaw())
  }
  raw.destroy()
  throw new Error(`${zipPath}: ${name} uses compression method ${entry.method}`)
}
