// src/gem/archiveTar.ts
// Gem a FileTree into a single .tar.gz buffer and back — the archive's transport/shipping form
// (the directory tree is the canonical form). Dependency-free: a minimal POSIX ustar writer/reader
// over node:zlib gzip. In-process only (no disk/network), so the pure core stays pure.
import { gzipSync, gunzipSync } from "node:zlib";
import type { FileTree } from "./archive.js";

const BLOCK = 512;

// Write `value` as a NUL-terminated octal ASCII field of width `len` at `offset`.
function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  const s = value.toString(8).padStart(len - 1, "0").slice(-(len - 1));
  buf.write(s + "\0", offset, "latin1");
}

// Read a NUL-trimmed string field of width `len` at `offset`.
function readStr(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString("utf8");
}

export function packTar(files: FileTree): Buffer {
  const blocks: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = Buffer.from(files[path], "utf8");
    const header = Buffer.alloc(BLOCK);
    header.write(path, 0, "utf8");        // name (paths are short; prefix field unused)
    writeOctal(header, 0o644, 100, 8);    // mode
    writeOctal(header, 0, 108, 8);        // uid
    writeOctal(header, 0, 116, 8);        // gid
    writeOctal(header, content.length, 124, 12); // size
    writeOctal(header, 0, 136, 12);       // mtime (fixed 0 -> deterministic header)
    header[156] = 0x30;                   // typeflag '0' = regular file
    header.write("ustar\0", 257, "latin1"); // magic
    header.write("00", 263, "latin1");    // version
    // checksum: sum all 512 bytes with the chksum field as spaces, then write it back.
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0").slice(-6) + "\0 ", 148, "latin1");
    blocks.push(header, content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}

export function unpackTar(buf: Buffer): FileTree {
  const tar = gunzipSync(buf);
  const files: FileTree = {};
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const name = readStr(tar, off, 100);
    if (name === "") break; // zero block => end of archive
    const prefix = readStr(tar, off + 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readStr(tar, off + 124, 12).trim() || "0", 8);
    const typeflag = tar[off + 156];
    off += BLOCK;
    if (typeflag === 0x30 || typeflag === 0) {
      files[full] = tar.subarray(off, off + size).toString("utf8");
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
