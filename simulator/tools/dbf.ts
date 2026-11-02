import { Readable } from 'stream'

// dBASE III table, as found in the .dbf beside a Shapefile. Values are returned as the
// trimmed text the file stores; callers convert the columns they use.
const HEADER_LENGTH = 32
const FIELD_DESCRIPTOR_LENGTH = 32
const FIELD_TERMINATOR = 0x0d
const DELETED_FLAG = 0x2a
const FIELD_NAME_LENGTH = 11
const FIELD_LENGTH_OFFSET = 16

export type DbfRecord = Record<string, string>

interface Field {
  name: string
  offset: number
  length: number
}

interface Layout {
  recordCount: number
  headerLength: number
  recordLength: number
  fields: Field[]
}

function parseLayout(header: Buffer): Layout {
  const fields: Field[] = []
  let offset = 1 // byte 0 of each record is the deletion flag
  for (
    let p = HEADER_LENGTH;
    header[p] !== FIELD_TERMINATOR;
    p += FIELD_DESCRIPTOR_LENGTH
  ) {
    const rawName = header.subarray(p, p + FIELD_NAME_LENGTH)
    const end = rawName.indexOf(0)
    const length = header[p + FIELD_LENGTH_OFFSET]
    fields.push({
      name: rawName.toString('latin1', 0, end < 0 ? FIELD_NAME_LENGTH : end),
      offset,
      length
    })
    offset += length
  }
  return {
    recordCount: header.readUInt32LE(4),
    headerLength: header.readUInt16LE(8),
    recordLength: header.readUInt16LE(10),
    fields
  }
}

export async function* readDbfRecords(
  source: Readable
): AsyncGenerator<DbfRecord> {
  let buffer: Buffer = Buffer.alloc(0)
  let layout: Layout | undefined
  let emitted = 0

  for await (const chunk of source) {
    buffer = buffer.length
      ? Buffer.concat([buffer, chunk as Buffer])
      : (chunk as Buffer)

    if (!layout) {
      if (buffer.length < HEADER_LENGTH) continue
      const headerLength = buffer.readUInt16LE(8)
      if (buffer.length < headerLength) continue
      layout = parseLayout(buffer.subarray(0, headerLength))
      buffer = buffer.subarray(headerLength)
    }

    let p = 0
    while (
      p + layout.recordLength <= buffer.length &&
      emitted < layout.recordCount
    ) {
      if (buffer[p] !== DELETED_FLAG) {
        const record: DbfRecord = {}
        for (const field of layout.fields) {
          record[field.name] = buffer
            .toString(
              'latin1',
              p + field.offset,
              p + field.offset + field.length
            )
            .trim()
        }
        yield record
      }
      emitted++
      p += layout.recordLength
    }
    buffer = buffer.subarray(p)
    if (emitted >= layout.recordCount) {
      source.destroy()
      return
    }
  }
}
