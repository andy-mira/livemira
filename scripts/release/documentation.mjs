// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Adjust only the bilingual navigation when a guide is copied to a different filename.
import path from 'node:path';
export function documentLanguageLinks(text, destination) {
  const name = path.posix.basename(destination);
  const english = name.replace(/\.zh-CN\.md$/, '.md');
  const chinese = english.replace(/\.md$/, '.zh-CN.md');
  const bar = `[English](${english}) | [简体中文](${chinese})`;
  const marker = /^\[English\]\([^\n)]+\) \| \[简体中文\]\([^\n)]+\)$/gm;
  const matches = [...text.matchAll(marker)];
  if (matches.length !== 1) throw new Error(`Expected one language navigation bar in ${destination}`);
  return text.replace(marker, bar);
}
export function materializeDocumentation(text, metadata) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!(key in metadata)) throw new Error(`Unknown documentation field ${key}`);
    return String(metadata[key]);
  });
}
