// Deterministic, offline probe material. No network, no fixtures on disk, no provider
// calls: every byte a probe sends is generated here so a passing result cannot come
// from a cached asset, a guessable constant, or an earlier run's leftovers.
import {deflateSync} from 'node:zlib';
import {randomInt, randomUUID} from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = bytes => {
  let c = 0xFFFFFFFF;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}
/** Encode one solid-color 8-bit truecolor PNG without an image dependency. */
export function solidPng(width, height, [red, green, blue]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride; raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = red; raw[at + 1] = green; raw[at + 2] = blue;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Widely separated hues so a correct answer reflects perception, not a near-miss
// between two similar swatches that a grader would have to interpret charitably.
export const PROBE_COLORS = Object.freeze([
  {name: 'red', rgb: [220, 20, 20]}, {name: 'green', rgb: [20, 170, 20]},
  {name: 'blue', rgb: [20, 40, 220]}, {name: 'yellow', rgb: [240, 220, 20]},
  {name: 'magenta', rgb: [220, 20, 200]}, {name: 'cyan', rgb: [20, 200, 220]},
  {name: 'orange', rgb: [240, 130, 20]}, {name: 'purple', rgb: [110, 20, 190]},
]);
export const IMAGE_PROBE_PANELS = 2;
/** One blind guess is 1/64 across two panels; a pass is evidence the raster was read. */
export function createImageProbe(pick = () => randomInt(PROBE_COLORS.length)) {
  const chosen = [];
  while (chosen.length < IMAGE_PROBE_PANELS) {
    const color = PROBE_COLORS[pick()];
    // Distinct colors keep the expected answer unambiguous and the guess space honest.
    if (!chosen.includes(color)) chosen.push(color);
  }
  const names = PROBE_COLORS.map(c => c.name).join(', ');
  return {
    images: chosen.map(color => ({data: solidPng(48, 48, color.rgb), mediaType: 'image/png', name: `probe-${color.name}.png`})),
    expected: 'IMAGE:' + chosen.map(c => c.name).join(':'),
    instruction: `You are given ${IMAGE_PROBE_PANELS} images, each a single solid color. Allowed color names: ${names}. Reply with exactly IMAGE:<first image color>:<second image color> and no other text.`,
    verify: text => text.trim() === 'IMAGE:' + chosen.map(c => c.name).join(':'),
  };
}
/** Structured output is checked by parsing, never by reading prose that claims JSON. */
export function createStructuredProbe(nonce = randomUUID()) {
  const total = randomInt(11, 99);
  return {
    instruction: `Return exactly one JSON object and no other text, no code fence. It must have keys "nonce" (string), "sum" (number) and "ok" (boolean). Set nonce to ${nonce}, sum to ${total}, and ok to true.`,
    verify(text) {
      try {
        const value = JSON.parse(text.trim());
        return !!value && typeof value === 'object' && !Array.isArray(value) &&
          value.nonce === nonce && value.sum === total && value.ok === true;
      } catch {return false;}
    },
  };
}
