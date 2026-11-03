import { inflateSync } from "node:zlib";
import { MAX_SIGNATURE_BYTES, MAX_SIGNATURE_SIDE, MIN_SIGNATURE_EXTENT, MIN_SIGNATURE_INK } from "@/lib/share-validation";

/*
 * The on-screen signature (a PNG data URL from the canvas). It is decoded here, not only sniffed: a real PNG, a size cap, and
 * enough drawn pixels that it is not a blank canvas. Pure (node:zlib only) so it is unit-tested with generated PNGs.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export type SignatureCode = "format" | "too_large" | "too_small" | "dimensions" | "unsupported" | "blank";
export type SignatureResult = { ok: true; bytes: Buffer; width: number; height: number; ink: number } | { ok: false; code: SignatureCode };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** Decodes a PNG data URL and counts the drawn pixels. */
export function inspectSignature(dataUrl: unknown): SignatureResult {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_SIGNATURE_BYTES * 1.4) return { ok: false, code: "too_large" };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { ok: false, code: "format" };
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, code: "too_large" };
  if (bytes.length < 80 || !PNG_SIG.every((b, i) => bytes[i] === b)) return { ok: false, code: "format" };
  let width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
  const idat: Buffer[] = [];
  let off = 8, sawEnd = false;
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off), type = bytes.toString("latin1", off + 4, off + 8);
    if (len > bytes.length - off - 12) return { ok: false, code: "format" };
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      if (len !== 13) return { ok: false, code: "format" };
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") { sawEnd = true; break; }
    off += 12 + len;
  }
  if (!sawEnd || width < 1 || height < 1 || ctype < 0 || idat.length === 0) return { ok: false, code: "format" };
  if (width > MAX_SIGNATURE_SIDE || height > MAX_SIGNATURE_SIDE) return { ok: false, code: "dimensions" };
  if (width < 80 || height < 30) return { ok: false, code: "too_small" };
  const ch = CHANNELS[ctype];
  if (!ch || depth !== 8 || interlace !== 0) return { ok: false, code: "unsupported" };
  const stride = width * ch;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 16 }); } catch { return { ok: false, code: "format" }; }
  if (raw.length < (stride + 1) * height) return { ok: false, code: "format" };
  // undo the scanline filters, then count the pixels that carry ink
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  let ink = 0, minX = width, maxX = -1, minY = height, maxY = -1, bg = -1;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    if (f > 4) return { ok: false, code: "format" };
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      cur[i] = f === 0 ? x : f === 1 ? (x + a) & 255 : f === 2 ? (x + b) & 255 : f === 3 ? (x + ((a + b) >> 1)) & 255 : (x + paeth(a, b, c)) & 255;
    }
    for (let px = 0; px < width; px++) {
      const o = px * ch;
      let drawn: boolean;
      if (ctype === 6) drawn = cur[o + 3] > 40;
      else if (ctype === 4) drawn = cur[o + 1] > 40;
      else {
        const v = ctype === 0 ? cur[o] : (cur[o] + cur[o + 1] + cur[o + 2]) / 3;
        if (bg < 0) bg = v;
        drawn = Math.abs(v - bg) > 60;
      }
      if (drawn) { ink++; if (px < minX) minX = px; if (px > maxX) maxX = px; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    cur.copy(prev);
  }
  if (ink < MIN_SIGNATURE_INK || Math.max(maxX - minX, maxY - minY) + 1 < MIN_SIGNATURE_EXTENT) return { ok: false, code: "blank" };
  return { ok: true, bytes, width, height, ink };
}

export const SIGNATURE_MESSAGES: Record<SignatureCode, [string, string]> = {
  format: ["التوقيع غير صالح. وقّع في المربع من جديد.", "The signature is not valid. Sign in the box again."],
  too_large: ["صورة التوقيع كبيرة جداً.", "The signature image is too large."],
  too_small: ["صورة التوقيع صغيرة جداً.", "The signature image is too small."],
  dimensions: ["أبعاد التوقيع كبيرة جداً.", "The signature dimensions are too large."],
  unsupported: ["صيغة التوقيع غير مدعومة.", "The signature format is not supported."],
  blank: ["التوقيع فارغ أو قصير جداً. ارسم توقيعك بوضوح داخل المربع.", "The signature is empty or too short. Draw your signature clearly inside the box."],
};
