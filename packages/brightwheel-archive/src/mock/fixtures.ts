import { createHash } from 'node:crypto';

/**
 * Genuinely valid media files, built from the specifications in code.
 *
 * The mock used to serve an SVG under a `.jpg` name. That was enough to exercise
 * downloading and de-duplication, but ExifTool cannot write into an SVG, so every mock
 * photo quietly degraded to the JSON sidecar and no test ever proved that a single tag was
 * embedded. These generators produce a baseline JPEG and an ISO BMFF MP4 that ExifTool,
 * ffprobe and ordinary viewers all accept, so the metadata path is tested for real.
 *
 * They are generated rather than checked in because this repository must never contain a
 * binary media file: a fixture that starts as a placeholder is one careless commit away
 * from being a real photograph. Both outputs are deterministic in the activity id, so the
 * same fake photo always has the same bytes and the same colour.
 */

/** A pleasant, deterministic colour for an id, as 8-bit RGB. */
function colourFor(id: string): [number, number, number] {
  const hue = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 4), 16) % 360;
  // HSL(hue, 65%, 70%) -> RGB, the pastel range the old SVG placeholders used.
  const s = 0.65;
  const l = 0.7;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector]!;
  return [Math.round((r! + m) * 255), Math.round((g! + m) * 255), Math.round((b! + m) * 255)];
}

// ---------------------------------------------------------------- JPEG

/**
 * Entropy-coded segment writer: MSB-first bits, with the byte stuffing the JPEG spec
 * requires (a 0xFF data byte is followed by 0x00 so it cannot be mistaken for a marker).
 */
class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  put(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flush();
    }
  }

  private flush(): void {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00);
    this.acc = 0;
    this.count = 0;
  }

  /** Pad the final byte with 1-bits, as the spec says, and return the segment. */
  end(): Buffer {
    if (this.count > 0) this.put(0xff, 8 - this.count);
    return Buffer.from(this.bytes);
  }
}

/** Huffman codes from a DHT segment's BITS/HUFFVAL lists (ITU T.81 Annex C). */
function huffmanCodes(bits: readonly number[], values: readonly number[]): Map<number, { code: number; length: number }> {
  const out = new Map<number, { code: number; length: number }>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]!; i++) out.set(values[k++]!, { code: code++, length });
    code <<= 1;
  }
  return out;
}

// The standard luminance DC table from T.81 Annex K.3: one code per magnitude category.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0] as const;
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
// A flat block has no AC coefficients at all, so the AC table only needs end-of-block.
// ZRL is included so the table has two codes and neither is the forbidden all-ones code.
const AC_BITS = [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as const;
const AC_VALUES = [0x00, 0xf0] as const;

/** A marker segment: 0xFF, marker, two-byte length (which counts itself), payload. */
function segment(marker: number, payload: Buffer): Buffer {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
}

/**
 * A baseline JPEG of one solid colour.
 *
 * Structure, in order: SOI, APP0 (JFIF), DQT, SOF0, DHT (DC), DHT (AC), SOS, the
 * entropy-coded scan, EOI. Three components, no chroma subsampling, one quantisation
 * and one pair of Huffman tables shared by every component.
 *
 * A flat 8x8 block has exactly one non-zero DCT coefficient, DC = 8 x (value - 128). The
 * quantisation table is all 8s so the quantised DC is simply `value - 128`, and every
 * block after the first in a component codes a DC difference of zero followed by
 * end-of-block: four bits per block. The whole file is a few hundred bytes.
 */
export function placeholderJpeg(id: string, width = 64, height = 48): Buffer {
  const [r, g, b] = colourFor(id);
  // JFIF YCbCr, clamped to the 8-bit range.
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const components = [
    clamp(0.299 * r + 0.587 * g + 0.114 * b),
    clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
    clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
  ];

  const app0 = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 8)]));
  const sof0 = segment(
    0xc0,
    Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
  );
  const dhtDc = segment(0xc4, Buffer.from([0x00, ...DC_BITS, ...DC_VALUES]));
  const dhtAc = segment(0xc4, Buffer.from([0x10, ...AC_BITS, ...AC_VALUES]));
  const sos = segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));

  const dc = huffmanCodes(DC_BITS, DC_VALUES);
  const eob = huffmanCodes(AC_BITS, AC_VALUES).get(0x00)!;
  const writer = new BitWriter();
  const predictor = [0, 0, 0];
  const mcus = Math.ceil(width / 8) * Math.ceil(height / 8);
  for (let mcu = 0; mcu < mcus; mcu++) {
    for (let c = 0; c < 3; c++) {
      const coefficient = components[c]! - 128;
      const diff = coefficient - predictor[c]!;
      predictor[c] = coefficient;
      // DC differences are coded as a magnitude category, then that many bits: the value
      // itself when positive, its one's complement when negative.
      let category = 0;
      for (let magnitude = Math.abs(diff); magnitude > 0; magnitude >>= 1) category++;
      const symbol = dc.get(category)!;
      writer.put(symbol.code, symbol.length);
      if (category > 0) writer.put(diff >= 0 ? diff : (diff - 1) & ((1 << category) - 1), category);
      writer.put(eob.code, eob.length);
    }
  }

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    dqt,
    sof0,
    dhtDc,
    dhtAc,
    sos,
    writer.end(),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---------------------------------------------------------------- MP4

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const fourcc = (s: string): Buffer => Buffer.from(s, 'latin1');

/** An ISO BMFF box: 32-bit size including the header, four-character type, payload. */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), fourcc(type), body]);
}

/** A "full" box carries a version byte and 24 bits of flags before its payload. */
function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(type, Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
}

/** The identity transformation matrix, in the 16.16 / 2.30 fixed-point layout the spec uses. */
const IDENTITY_MATRIX = Buffer.concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

/**
 * QuickTime and MP4 count seconds from 1904-01-01 UTC, not 1970. This is the creation
 * time a transcoder would stamp on the container at upload, which is precisely the wrong
 * time this tool exists to correct — so the fixture carries it, and a test can prove it
 * was overwritten with the capture time.
 */
export const MP4_CONTAINER_CREATED = new Date('2026-09-18T12:00:00Z');
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * A one-second, one-frame MP4 whose single sample is the JPEG placeholder for the same
 * id, stored as a Motion JPEG track. That keeps the video the same colour as the photo
 * and needs no codec beyond the JPEG generator above.
 *
 * Box tree:
 *
 *   ftyp                      brand isom
 *   moov
 *     mvhd                    timescale, duration, creation and modification time
 *     trak
 *       tkhd                  track id 1, enabled, dimensions
 *       mdia
 *         mdhd                media timescale and duration
 *         hdlr                'vide'
 *         minf
 *           vmhd
 *           dinf / dref / url  the data lives in this file
 *           stbl
 *             stsd / jpeg     the sample description
 *             stts            one sample lasting the whole movie
 *             stsc            one chunk of one sample
 *             stsz            the sample's size
 *             stco            the chunk's absolute file offset, into mdat
 *   mdat                      the JPEG frame
 *
 * `moov` precedes `mdat`, the "fast start" layout, so `stco` points past a box whose
 * size is not known until it is built. It is built twice: once to measure, once for real.
 * Putting `moov` first also means ExifTool must rewrite the chunk offset when it grows the
 * box with metadata, which is exactly the path worth testing.
 */
export function placeholderMp4(id: string): Buffer {
  const frame = placeholderJpeg(id);
  const width = 64;
  const height = 48;
  const timescale = 1000;
  const duration = 1000;
  const when = u32(Math.floor((MP4_CONTAINER_CREATED.getTime() - EPOCH_1904) / 1000));

  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('mp41'));

  const moov = (chunkOffset: number): Buffer => {
    const mvhd = fullBox(
      'mvhd', 0, 0,
      when, when, u32(timescale), u32(duration),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), IDENTITY_MATRIX,
      Buffer.alloc(24), u32(2),
    );
    // Flags 7: track enabled, in movie, in preview.
    const tkhd = fullBox(
      'tkhd', 0, 7,
      when, when, u32(1), u32(0), u32(duration), Buffer.alloc(8),
      u16(0), u16(0), u16(0), u16(0), IDENTITY_MATRIX, u32(width << 16), u32(height << 16),
    );
    // 0x55c4 is the packed ISO 639-2 code "und" (undetermined language).
    const mdhd = fullBox('mdhd', 0, 0, when, when, u32(timescale), u32(duration), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), Buffer.alloc(12), fourcc('VideoHandler\0'));
    const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
    // Flag 1 on the url entry: the media is in this file, so the entry has no location.
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    // A VisualSampleEntry: 72 dpi, one frame per sample, 24-bit depth, empty compressor name.
    const jpeg = box(
      'jpeg',
      Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12),
      u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
      Buffer.alloc(32), u16(0x0018), u16(0xffff),
    );
    const stbl = box(
      'stbl',
      fullBox('stsd', 0, 0, u32(1), jpeg),
      fullBox('stts', 0, 0, u32(1), u32(1), u32(duration)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(1), u32(frame.length)),
      fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
    );
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('moov', mvhd, box('trak', tkhd, mdia));
  };

  const moovSize = moov(0).length;
  return Buffer.concat([ftyp, moov(ftyp.length + moovSize + 8), box('mdat', frame)]);
}
