/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { compileGray, serializeBundle } from './bundle.mjs';
import { LIMITS } from '../../recognition/experimental/features.mjs';

const [input, width, height, targetId, output, physicalWidth] = process.argv.slice(2);
if (!input || !width || !height || !targetId || !output) {
  console.error('Usage: node packages/target-compiler/experimental/cli.mjs input.gray width height targetId output.json [physicalWidthMeters]');
  process.exitCode = 1;
} else {
  try {
    const size = (await stat(input)).size;
    if (size > LIMITS.pixels || size !== Number(width) * Number(height)) throw new Error('INVALID_GRAY8_FILE_SIZE');
    const data = new Uint8Array(await readFile(input));
    const bundle = compileGray({ data, width: Number(width), height: Number(height) }, { targetId, physicalWidthMeters: physicalWidth === undefined ? null : Number(physicalWidth) });
    await writeFile(output, serializeBundle(bundle), { flag: 'wx' });
    console.log(JSON.stringify(bundle.quality));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
