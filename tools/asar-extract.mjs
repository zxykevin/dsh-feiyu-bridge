// Read-only ASAR inspector/extractor used only for researching the installed DSH runtime.
// Usage:
//   node tools/asar-extract.mjs list <asar> [filter]
//   node tools/asar-extract.mjs extract <asar> <entryPathInAsar> <outFile>
import fs from 'node:fs';
import path from 'node:path';

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerPickleSize = sizeBuf.readUInt32LE(4);
  const header = Buffer.alloc(headerPickleSize);
  fs.readSync(fd, header, 0, headerPickleSize, 8);
  const jsonSize = header.readUInt32LE(4);
  const json = header.subarray(8, 8 + jsonSize).toString('utf8');
  return { fd, header, baseOffset: 8 + headerPickleSize, json: JSON.parse(json) };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset, unpacked: entry.unpacked });
  }
}

const [cmd, asarPath, a, b] = process.argv.slice(2);
if (!cmd || !asarPath) {
  console.error('usage: list|extract');
  process.exit(2);
}
const { fd, baseOffset, json, header } = readHeader(asarPath);
try {
  if (cmd === 'list') {
    const all = [];
    walk(json, '', all);
    const filter = a ? new RegExp(a) : null;
    for (const e of all) if (!filter || filter.test(e.path)) console.log(`${e.size}\t${e.path}`);
  } else if (cmd === 'extract') {
    const entryPath = a.replaceAll('\\', '/');
    const node = entryPath.split('/').reduce((acc, k) => acc?.files?.[k], json);
    if (!node || node.files) throw new Error(`entry not found: ${entryPath}`);
    const outFile = path.resolve(b);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    if (node.unpacked) {
      const unpacked = asarPath + '.unpacked';
      fs.copyFileSync(path.join(unpacked, entryPath), outFile);
    } else {
      const buf = Buffer.alloc(node.size);
      const readPos = baseOffset + Number(node.offset);
      let done = 0;
      while (done < buf.length) {
        done += fs.readSync(fd, buf, done, buf.length - done, readPos + done);
      }
      fs.writeFileSync(outFile, buf);
    }
    console.log(`extracted ${node.size} bytes -> ${outFile}`);
  } else {
    throw new Error(`unknown cmd ${cmd}`);
  }
} finally {
  fs.closeSync(fd);
  void header;
}
