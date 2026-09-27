// Regenerates the SparkClip app icons from the vector master
// resources/sparkclip-icon.svg:
//
//   build/icon.png   1024px (Linux, dev window icon)
//   build/icon.ico   Windows: 16, 24, 32, 48, 64, 128, 256px (PNG entries)
//   build/icon.icns  macOS: 16-1024px (PNG entries)
//
//   npm run icons
//
// Every size is rendered from the vector, so small sizes stay crisp.
// Works on Windows, macOS and Linux.
const fs = require('node:fs')
const path = require('node:path')
const { Resvg } = require('@resvg/resvg-js')

const ROOT = path.resolve(__dirname, '../..')
const SOURCE = path.join(ROOT, 'resources/sparkclip-icon.svg')
const BUILD = path.join(ROOT, 'build')

const svg = fs.readFileSync(SOURCE, 'utf8')
const cache = new Map()
function render(size) {
  if (!cache.has(size)) {
    cache.set(size, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
  }
  return cache.get(size)
}

function writeIco(file, sizes) {
  const images = sizes.map(render)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = 6 + 16 * sizes.length
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(images[i].length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += images[i].length
    return entry
  })
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...images]))
}

// ICNS chunk types that hold PNG data, with their pixel size.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
]

function writeIcns(file) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = render(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  fs.writeFileSync(file, Buffer.concat([head, body]))
}

fs.writeFileSync(path.join(BUILD, 'icon.png'), render(1024))
writeIco(path.join(BUILD, 'icon.ico'), [16, 24, 32, 48, 64, 128, 256])
writeIcns(path.join(BUILD, 'icon.icns'))
console.log('Icons written to build/ from resources/sparkclip-icon.svg')
