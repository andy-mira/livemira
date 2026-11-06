// SPDX-License-Identifier: Apache-2.0
// Relative links of the Markdown files in a directory tree: which ones point at nothing. The release tool runs it on
// the release it has just assembled, so a guide never ships with a dead link.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );
}

/** Links of a Markdown text, outside code fences and code spans: `[text](target)` and `![alt](target)`. */
export function linkTargets(markdown: string): string[] {
  const out: string[] = [];
  let isFenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced;
      continue;
    }
    if (isFenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]!);
  }
  return out;
}

/** `file → target` for every relative link (no scheme, no `#anchor`-only) that does not resolve inside `root`. */
export function brokenLinks(root: string): string[] {
  const base = resolve(root);
  const broken: string[] = [];
  for (const file of markdownFiles(base)) {
    for (const raw of linkTargets(readFileSync(file, 'utf8'))) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) continue;
      const path = decodeURIComponent(raw.split('#')[0]!.split('?')[0]!);
      if (!path) continue;
      const target = resolve(dirname(file), path);
      const isInside = target === base || target.startsWith(base + sep);
      if (!isInside || !existsSync(target)) broken.push(`${relative(base, file)} → ${raw}`);
    }
  }
  return broken.sort();
}
