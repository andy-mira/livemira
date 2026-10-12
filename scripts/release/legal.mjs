// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Release attribution comes from the root package metadata; upstream notices remain unchanged.
import { ROOT_METADATA } from './release-version.mjs';
export const COPYRIGHT_NOTICE = `Copyright ${ROOT_METADATA.livemira.copyrightYear} ${ROOT_METADATA.author}`;
export const AUTHOR = ROOT_METADATA.author;   // package.json "author" value; documents print it as "Author: Andy (@andy-mira)"
export const SPDX_LICENSE_ID = ROOT_METADATA.license;
// Legal files at the root of the repository, of every SDK package and of every curated drop (the central layout lists them too).
export const LEGAL_FILES = ['LICENSE', 'NOTICE'];
// Public documents whose bytes are copied into releases or exports: a change to any of them must make a package or build identity dirty.
export const LEGAL_SOURCE_SCOPE = ['LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'scripts/release/legal.mjs'];

// Concise legal comment for the first lines of every standalone runtime file. `/*!` keeps it a legal comment for minifiers.
export function legalBanner(summary) {
  if (typeof summary !== 'string' || !summary || /[\r\n]|\*\//.test(summary)) throw new Error('legal banner summary must be one line without a comment terminator');
  return `/*! ${COPYRIGHT_NOTICE}\n * SPDX-License-Identifier: ${SPDX_LICENSE_ID}\n * ${summary}\n */`;
}
// Removes only `/*! ... */` legal comments, so a legal URL inside one is not mistaken for a runtime network reference. Code and strings are untouched.
export const withoutLegalComments = text => text.replace(/\/\*![\s\S]*?\*\//g, '');
