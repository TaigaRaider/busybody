/**
 * Generates the PWA icons for the client from pure geometry — no image
 * libraries, just node:zlib and a hand-rolled PNG encoder.
 *
 * The Tabloid's mark is a chalk-coloured diamond on the slate background (the
 * same mark as public/favicon.svg, minus the white plate so it reads on dark
 * home screens). Outputs land in client/public/icons/:
 *
 *   icon-192.png             192x192  "any"        — Chromium install icon
 *   icon-512.png             512x512  "any"        — high-res install icon
 *   maskable-512.png         512x512  "maskable"   — full-bleed, glyph in the
 *                                                   safe zone for adaptive icons
 *   apple-touch-icon-180.png 180x180               — iOS home-screen icon
 *
 * Everything is committed to the repo, so builds and CI never need to run this
 * script — it only exists so the artwork is reproducible. Run it after touching
 * the geometry or palette:
 *
 *   node scripts/generate-pwa-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "client",
  "public",
  "icons",
);

/** The app's chalk palette is warm; the Lobby default chalk is #e06c75. */
const CHALK = [224, 108, 117];
/** Matches the app theme (--black / --gray-900): a near-black slate. */
const SLATE = [17, 17, 17];

/**
 * Render one icon. `glyph` is the diamond's half-width as a fraction of the
 * canvas; `bleed` true for maskable icons (full-bleed background, smaller
 * glyph well inside the safe zone).
 */
function renderIcon(size, { glyph = 0.3, bleed = false }) {
  const S = 4; // supersample factor — 4x4 subpixels per pixel, box-filtered
  const big = size * S;
  const img = new Uint8Array(big * big * 4);

  const half = glyph * size; // diamond "radius" in canvas units
  const corner = bleed ? 0 : size * 0.18; // rounded-corner radius
  const inset = bleed ? 0 : corner;

  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      // Subpixel centre in canvas coordinates.
      const px = (x + 0.5) / S;
      const py = (y + 0.5) / S;

      // Inside the rounded square? (dx,dy) relative to the nearest corner.
      const dx = Math.max(
        inset,
        Math.min(size - inset, px),
      ) - px;
      const dy = Math.max(
        inset,
        Math.min(size - inset, py),
      ) - py;
      const inPlate = bleed || (dx * dx + dy * dy <= corner * corner);

      // Inside the chalk diamond?
      const inDiamond =
        Math.abs(px - cx) + Math.abs(py - cy) <= half;

      const o = (y * big + x) * 4;
      if (inPlate) {
        const c = inDiamond ? CHALK : SLATE;
        img[o] = c[0];
        img[o + 1] = c[1];
        img[o + 2] = c[2];
        img[o + 3] = 255;
      } else {
        img[o + 3] = 0; // transparent outside the plate
      }
    }
  }

  // Box-filter each 4x4 subpixel block down to the final pixel.
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const o = ((y * S + sy) * big + (x * S + sx)) * 4;
          // Straight alpha over a black canvas for the downsample pass, then
          // unpremultiply at the end — good enough for hard-edged geometry.
          const w = img[o + 3] / 255;
          r += img[o] * w;
          g += img[o + 1] * w;
          b += img[o + 2] * w;
          a += img[o + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      if (a > 0) {
        const aa = a / n;
        out[o] = Math.round(r / n / (aa / 255));
        out[o + 1] = Math.round(g / n / (aa / 255));
        out[o + 2] = Math.round(b / n / (aa / 255));
        out[o + 3] = Math.round(aa);
      } else {
        out[o + 3] = 0;
      }
    }
  }
  return out;
}

/* ------------------------------ minimal PNG ------------------------------ */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression / filter / interlace default to 0

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * size * 4, (y + 1) * size * 4).forEach(
      (v, i) => (raw[y * (size * 4 + 1) + 1 + i] = v),
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------- run ---------------------------------- */

const JOBS = [
  ["icon-192.png", 192, { glyph: 0.3 }],
  ["icon-512.png", 512, { glyph: 0.3 }],
  ["maskable-512.png", 512, { glyph: 0.22, bleed: true }],
  ["apple-touch-icon-180.png", 180, { glyph: 0.3 }],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, opts] of JOBS) {
  const png = encodePNG(size, renderIcon(size, opts));
  const path = join(OUT_DIR, name);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}