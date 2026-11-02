import { expect } from 'chai'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { crc32, deflateRawSync } from 'zlib'
import { readDbfRecords } from '../simulator/tools/dbf'
import {
  AMSA_COLUMNS,
  inBoundingBox,
  parseAmsaTimestamp,
  prepareAmsa,
  preparePiraeus
} from '../simulator/tools/sources'
import { listZipEntries, openZipEntry } from '../simulator/tools/zip'

interface Entry {
  name: string
  data: Buffer
  deflate?: boolean
}

function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function makeDbf(fields: [string, number][], rows: string[][]): Buffer {
  const headerLength = 32 + fields.length * 32 + 1
  const recordLength = 1 + fields.reduce((sum, [, length]) => sum + length, 0)
  const header = Buffer.alloc(headerLength)
  header[0] = 3
  header.writeUInt32LE(rows.length, 4)
  header.writeUInt16LE(headerLength, 8)
  header.writeUInt16LE(recordLength, 10)
  fields.forEach(([name, length], i) => {
    header.write(name, 32 + i * 32, 'latin1')
    header[32 + i * 32 + 11] = 'C'.charCodeAt(0)
    header[32 + i * 32 + 16] = length
  })
  header[headerLength - 1] = 0x0d
  const records = rows.map((row) => {
    const record = Buffer.alloc(recordLength, ' ')
    let p = 1
    row.forEach((value, i) => {
      record.write(value.padEnd(fields[i][1]), p, 'latin1')
      p += fields[i][1]
    })
    return record
  })
  return Buffer.concat([header, ...records, Buffer.from([0x1a])])
}

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

describe('simulator data tools', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sk-simulator-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('zip', () => {
    it('lists entries and streams stored and deflated ones', async () => {
      const zip = path.join(dir, 'a.zip')
      writeFileSync(
        zip,
        makeZip([
          { name: 'stored.txt', data: Buffer.from('plain') },
          {
            name: 'dir/deflated.txt',
            data: Buffer.from('x'.repeat(1000)),
            deflate: true
          }
        ])
      )
      const names = (await listZipEntries(zip)).map((e) => e.name)
      expect(names).to.deep.equal(['stored.txt', 'dir/deflated.txt'])
      expect(await text(await openZipEntry(zip, 'stored.txt'))).to.equal(
        'plain'
      )
      expect(await text(await openZipEntry(zip, 'dir/deflated.txt'))).to.equal(
        'x'.repeat(1000)
      )
    })

    it('rejects a missing entry and a file that is not a zip', async () => {
      const zip = path.join(dir, 'a.zip')
      writeFileSync(zip, makeZip([{ name: 'one', data: Buffer.from('1') }]))
      await openZipEntry(zip, 'two').then(
        () => expect.fail('expected an error'),
        (e: Error) => expect(e.message).to.contain('no entry named two')
      )
      const notZip = path.join(dir, 'not.zip')
      writeFileSync(notZip, 'hello')
      await listZipEntries(notZip).then(
        () => expect.fail('expected an error'),
        (e: Error) => expect(e.message).to.contain('not a ZIP archive')
      )
    })
  })

  describe('dbf', () => {
    it('reads every record, skipping deleted ones, across chunk boundaries', async () => {
      const dbf = makeDbf(
        [
          ['name', 6],
          ['speed', 5]
        ],
        [
          ['one', '1.5'],
          ['two', '2.5'],
          ['three', '3.5']
        ]
      )
      dbf[dbf.readUInt16LE(8) + dbf.readUInt16LE(10)] = 0x2a // delete the second record
      const chunks = Array.from({ length: Math.ceil(dbf.length / 7) }, (_, i) =>
        dbf.subarray(i * 7, i * 7 + 7)
      )
      const records = []
      for await (const r of readDbfRecords(Readable.from(chunks)))
        records.push(r)
      expect(records).to.deep.equal([
        { name: 'one', speed: '1.5' },
        { name: 'three', speed: '3.5' }
      ])
    })
  })

  describe('AMSA', () => {
    it('reads its timestamps as UTC, ignoring fractions and stray AM/PM', () => {
      const expected = Date.UTC(2026, 7, 7, 15, 33, 47)
      expect(parseAmsaTimestamp('07/08/2026 15:33:47')).to.equal(expected)
      expect(parseAmsaTimestamp('07/08/2026 15:33:47 PM')).to.equal(expected)
      expect(parseAmsaTimestamp('07/08/2026 15:33:47.764')).to.equal(expected)
      expect(() => parseAmsaTimestamp('2026-08-07')).to.throw('unrecognised')
    })

    it('tests a bounding box inclusively', () => {
      expect(inBoundingBox(150, -25, [148, -28, 154, -20])).to.equal(true)
      expect(inBoundingBox(148, -28, [148, -28, 154, -20])).to.equal(true)
      expect(inBoundingBox(147.9, -25, [148, -28, 154, -20])).to.equal(false)
    })

    it('cuts a monthly download to the window and the area', async () => {
      const fields: [string, number][] = [
        ['craft_id', 19],
        ['longitude', 19],
        ['latitude', 19],
        ['course', 12],
        ['speed', 12],
        ['type', 20],
        ['length', 12],
        ['beam', 12],
        ['draught', 12],
        ['timestamp', 30]
      ]
      const row = (lon: string, lat: string, time: string) => [
        '3.73575787390e+10',
        lon,
        lat,
        '3.03300e+02',
        '5.40000e+00',
        'Sailing',
        '1.20000e+01',
        '4.00000e+00',
        '0.00000e+00',
        time
      ]
      const dbf = makeDbf(fields, [
        row('150.5', '-25.0', '21/08/2026 01:00:00 AM'),
        row('150.5', '-25.0', '25/08/2026 01:00:00'),
        row('100.0', '-25.0', '21/08/2026 01:00:00')
      ])
      const inner = makeZip([
        {
          name: 'cts_srr_08_2026_pt/cts_srr_08_2026_pt.dbf',
          data: dbf,
          deflate: true
        }
      ])
      writeFileSync(
        path.join(dir, 'download.zip'),
        makeZip([
          { name: 'meta.pdf', data: Buffer.from('pdf') },
          { name: 'cts_srr_08_2026_pt.zip', data: inner }
        ])
      )

      const result = await prepareAmsa(
        {
          source: 'amsa-cts',
          archive: 'download.zip',
          start: '2026-08-20T18:00:00Z',
          end: '2026-08-24T00:00:00Z',
          bbox: [148.4, -28, 154, -19.8]
        },
        dir,
        path.join(dir, 'cache'),
        path.join(dir, 'out')
      )

      expect(result).to.deep.equal({ points: 1, vessels: 1 })
      const lines = readFileSync(path.join(dir, 'out', 'ais.csv'), 'utf8')
        .trim()
        .split('\n')
      expect(lines[0]).to.equal(AMSA_COLUMNS.join(','))
      expect(lines[1]).to.equal(
        '37357578739,2026-08-21T01:00:00.000Z,-25,150.5,5.4,303.3,Sailing,12,4,0'
      )
    })
  })

  describe('Piraeus', () => {
    it('cuts the reports, vessel types and weather to the window', async () => {
      const start = Date.UTC(2018, 6, 13, 11)
      const csv = [
        'timestamp,vessel_id,lon,lat,heading,speed,course',
        `${start - 1},a,23.6,37.9,0,0,0`,
        `${start},a,23.6,37.9,10,5,10`,
        `${start + 1000},b,23.5,37.8,20,6,20`
      ].join('\n')
      writeFileSync(
        path.join(dir, 'dynamic.zip'),
        makeZip([
          { name: 'jul.csv', data: Buffer.from(csv + '\n'), deflate: true }
        ])
      )
      writeFileSync(
        path.join(dir, 'static.zip'),
        makeZip([
          {
            name: 'static.csv',
            data: Buffer.from('vessel_id,country,shiptype\n')
          }
        ])
      )
      const weather = makeDbf(
        [
          ['timestamp', 20],
          ['timestamp_', 12],
          ['WSPD', 8]
        ],
        [
          ['2018-07-13 10:00:00', '0', '1.0'],
          ['2018-07-13 12:00:00', '0', '2.0']
        ]
      )
      writeFileSync(
        path.join(dir, 'weather.zip'),
        makeZip([{ name: 'w.dbf', data: weather }])
      )

      const result = await preparePiraeus(
        {
          source: 'piraeus-ais',
          start: '2018-07-13T11:00:00Z',
          end: '2018-07-14T07:00:00Z',
          dynamicArchive: 'dynamic.zip',
          dynamicEntry: 'jul.csv',
          staticArchive: 'static.zip',
          staticEntry: 'static.csv',
          weatherArchive: 'weather.zip',
          weatherEntry: 'w.dbf'
        },
        dir,
        path.join(dir, 'out')
      )

      expect(result).to.deep.equal({ points: 2, vessels: 2, weatherRows: 1 })
      expect(
        readFileSync(path.join(dir, 'out', 'weather-gfs.csv'), 'utf8')
      ).to.equal('timestamp,WSPD\n2018-07-13 12:00:00,2.0\n')
    })
  })
})
