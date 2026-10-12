// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Copies the compute shaders and the pinned prebuilt WebAssembly modules into dist/ and points compiled imports of @livemira/contracts at dist/contracts.
import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
await mkdir(new URL('../../dist/compute/shaders/',import.meta.url),{recursive:true});
await copyFile(new URL('../../packages/compute/shaders/gray.wgsl',import.meta.url),new URL('../../dist/compute/shaders/gray.wgsl',import.meta.url));
await copyFile(new URL('../../packages/compute/shaders/hamming.wgsl',import.meta.url),new URL('../../dist/compute/shaders/hamming.wgsl',import.meta.url));
for(const variant of ['scalar','simd']){
  await mkdir(new URL(`../../dist/compute/artifacts/${variant}/`,import.meta.url),{recursive:true});
  for(const name of ['compute.mjs','compute.wasm'])await copyFile(new URL(`../../packages/compute/artifacts/${variant}/${name}`,import.meta.url),new URL(`../../dist/compute/artifacts/${variant}/${name}`,import.meta.url));
}
const dist=fileURLToPath(new URL('../../dist/',import.meta.url));
async function rewrite(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await rewrite(file);else if(/\.(js|mjs)$/.test(entry.name)){const text=await readFile(file,'utf8');let relative=path.relative(path.dirname(file),path.join(dist,'contracts/src/index.js')).replaceAll('\\','/');if(!relative.startsWith('.'))relative='./'+relative;const updated=text.replace(/(['"])@livemira\/contracts\1/g,JSON.stringify(relative));if(updated!==text)await writeFile(file,updated);}}}
await rewrite(dist);
