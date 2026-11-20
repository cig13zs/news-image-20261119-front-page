// make.fun entry — news-image-20261119
// "Sum up 19 November's world news in one image"
//
// This program writes exactly one image to /output/entry.png (outside the
// grader's container, to $MAKEFUN_OUTPUT_DIR instead). It does not generate the
// picture at run time: it ships entry.png beside this file and reproduces it
// byte for byte, so the two runs the grader performs are identical by
// construction.
//
// Before writing, it validates the shipped image against every requirement the
// bounty's gate enforces on the bytes themselves:
//   * a whole PNG (signature, every chunk's CRC, a complete IDAT stream that
//     inflates to exactly the scanline count its header describes), or a whole
//     JPEG (SOI ... EOI);
//   * at most 1 MiB;
//   * at most 1024 by 1024 pixels.
// A failure here is a bug in the entry, not in the grader, so it exits non-zero
// with the specific problem rather than writing an image that would be invalid.
//
// Standard library only. No network. No randomness, no clock, no environment
// dependence except the output directory.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const MAX_BYTES = 1024 * 1024;
const MAX_DIM = 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard CRC-32 (IEEE 802.3), computed locally so the program depends on no
 *  particular Node release for zlib.crc32. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ImageInfo = { format: 'png' | 'jpeg'; width: number; height: number };

/**
 * Validate a whole PNG: signature, chunk CRCs, IHDR geometry, and the promise
 * that the concatenated IDAT stream inflates to exactly the scanlines the
 * header implies (the gate's "image data its header describes").
 */
export function inspectPng(buf: Buffer): ImageInfo {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: bad signature');
  }
  let pos = 8;
  let header: ImageInfo | null = null;

  // IHDR fields needed to compute the expected raw scanline length.
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat: Buffer[] = [];
  let sawEnd = false;

  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`truncated chunk ${type}`);
    const data = buf.subarray(dataStart, dataEnd);
    const stored = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(pos + 4, dataEnd)) !== stored) {
      throw new Error(`bad CRC in chunk ${type}`);
    }
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('IHDR is not 13 bytes');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width === 0 || height === 0) throw new Error('zero-sized image');
      header = { format: 'png', width, height };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      pos = dataEnd + 4;
      break;
    }
    pos = dataEnd + 4;
  }

  if (!header) throw new Error('no IHDR chunk');
  if (!sawEnd) throw new Error('no IEND chunk: the file is truncated');
  if (idat.length === 0) throw new Error('no IDAT chunk');

  const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  if (interlace === 0) {
    const stride = Math.ceil((width * channels * bitDepth) / 8) + 1;
    const expected = stride * height;
    if (raw.length !== expected) {
      throw new Error(`image data is ${raw.length} bytes, header implies ${expected}`);
    }
  }
  return header;
}

/** Minimal whole-JPEG check: SOI at the start, EOI at the end. */
export function inspectJpeg(buf: Buffer): ImageInfo {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG: no SOI');
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    throw new Error('not a whole JPEG: no EOI');
  }
  // Walk the marker chain to the first SOFn for the frame size.
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(pos + 5);
      const width = buf.readUInt16BE(pos + 7);
      return { format: 'jpeg', width, height };
    }
    pos += 2 + length;
  }
  throw new Error('no SOF marker in JPEG');
}

/** Validate the shipped image against the bounty's byte-level requirements. */
export function inspectEntryImage(buf: Buffer): ImageInfo {
  if (buf.length === 0) throw new Error('entry image is empty');
  if (buf.length > MAX_BYTES) {
    throw new Error(`entry image is ${buf.length} bytes, over the ${MAX_BYTES}-byte cap`);
  }
  const info = buf.subarray(0, 8).equals(PNG_SIGNATURE) ? inspectPng(buf) : inspectJpeg(buf);
  if (info.width > MAX_DIM || info.height > MAX_DIM) {
    throw new Error(`entry image is ${info.width}x${info.height}, over the ${MAX_DIM}x${MAX_DIM} cap`);
  }
  return info;
}

function main(): void {
  const source = fileURLToPath(new URL('./entry.png', import.meta.url));
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const destination = join(outDir, 'entry.png');

  const image = readFileSync(source);
  const info = inspectEntryImage(image);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(destination, image); // identical bytes, so both runs match
  process.stdout.write(
    `entry.png: ${info.format} ${info.width}x${info.height}, ${image.length} bytes -> ${destination}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
