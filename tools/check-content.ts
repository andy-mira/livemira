/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Checks what Git tracks against the content rules: no local paths, no development-process traces, no secrets, and
// public documentation in both languages with the same examples.
// Usage: node tools/check-content.ts   (reads the files `git ls-files` lists)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export interface TrackedFile {
  readonly path: string;
  readonly text: string;
}

export interface ContentViolation {
  readonly where: string;
  readonly message: string;
}

/** Text that never belongs in the product, wherever it appears. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly message: string }[] = [
  {
    pattern: /(?:^|[\s'"`(=])\/(?:Users|Volumes|home|private\/tmp)\//m,
    message: 'a local absolute path',
  },
  {
    pattern: /\b(?:Claude|Codex|Anthropic|OpenAI|ChatGPT|Copilot)\b/,
    message: 'an assistant or tool attribution',
  },
  { pattern: /\bWebAREngine\b|\bwebar-engine\b/i, message: 'the superseded project name' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: 'a private key' },
  {
    pattern: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,})\b/,
    message: 'a credential',
  },
];

/** Development-process traces in prose (documentation and comments): internal rounds and the ignored notes folder. */
const PROSE_ONLY: readonly { readonly pattern: RegExp; readonly message: string }[] = [
  {
    pattern: /\bround ?\d+\b|第\s*[0-9一二三四五六七八九十]+\s*轮|\br\d{1,2}\b/i,
    message: 'an internal round label',
  },
  { pattern: /\bDocs\//, message: 'a reference to the internal notes' },
];

/** The checker and its test spell out what they look for. */
const SELF = new Set(['tools/check-content.ts', 'tools/check-content.test.ts']);

/** Files that may name the ignored notes folder: the ignore lists themselves. */
const IGNORE_LISTS = new Set(['.gitignore', '.prettierignore', 'eslint.config.mjs']);

/**
 * The repository's two top-level READMEs carry an owner-approved "Made with AI" credits section that names the
 * building agents. That one section is an explicit exception; the attribution ban still applies everywhere else.
 */
const ATTRIBUTION_ALLOWLIST = new Set(['README.md', 'README.zh-CN.md']);

/** True when the attribution ban must not flag this file. */
function attributionAllowed(file: TrackedFile): boolean {
  if (ATTRIBUTION_ALLOWLIST.has(file.path)) {
    const text = file.text;
    const begin = text.indexOf('## Made with AI');
    if (begin >= 0) {
      const end = text.indexOf('\n## ', begin + 1);
      const section = end < 0 ? text.slice(begin) : text.slice(begin, end);
      return !/\b(?:Claude|Codex|Anthropic|OpenAI|ChatGPT|Copilot)\b/.test(
        text.slice(0, begin) + text.slice(begin + section.length),
      );
    }
  }
  return false;
}

const BINARY = /\.(?:png|jpe?g|webm|mp4|wasm|ico|gif|tgz|zip)$/i;

/** Comments of a source file (line and block), joined; documentation is prose as a whole. */
function prose(file: TrackedFile): string {
  if (file.path.endsWith('.md')) return file.text;
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.path)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const comments = new Map<number, string>();
    const visit = (node: ts.Node): void => {
      const ranges = [
        ...(ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(file.text, node.end) ?? []),
      ];
      for (const { pos, end } of ranges) comments.set(pos, file.text.slice(pos, end));
      for (const child of node.getChildren(source)) visit(child);
    };
    visit(source);
    return [...comments.values()].join('\n');
  }
  const comments = file.text.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  return comments.join('\n');
}

export function findContentViolations(files: readonly TrackedFile[]): ContentViolation[] {
  const violations: ContentViolation[] = [];
  for (const file of files) {
    if (BINARY.test(file.path) || SELF.has(file.path)) continue;
    for (const { pattern, message } of FORBIDDEN) {
      if (message === 'an assistant or tool attribution' && attributionAllowed(file)) continue;
      if (pattern.test(file.text)) violations.push({ where: file.path, message });
    }
    const text = prose(file);
    for (const { pattern, message } of PROSE_ONLY) {
      if (message === 'a reference to the internal notes' && IGNORE_LISTS.has(file.path)) continue;
      if (pattern.test(text)) violations.push({ where: file.path, message });
    }
  }
  return violations;
}

/** Public documents that exist in English and Simplified Chinese. */
export const BILINGUAL_DOCUMENTS: readonly string[] = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'documentation/migration-0.2-to-0.3.md',
  'packages/sdk/README.md',
  'packages/tracking-visuals/README.md',
  'packages/recognition-diagnostics/README.md',
  'packages/target-quality/README.md',
  'packages/ui/README.md',
  'apps/demo/README.md',
];

const chinese = (file: string): string => file.replace(/\.md$/, '.zh-CN.md');

/**
 * The code examples of a document, reduced to what runs: comments, string contents and HTML text are localized,
 * everything else must be the same in both languages.
 */
export function examples(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(([, code]) =>
    code!
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(^|\s)#[^\n]*/g, '$1')
      .replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, "''")
      .replace(/>[^<>\n]*</g, '><')
      .replace(/[ \t]+$/gm, ''),
  );
}

export function findBilingualViolations(files: ReadonlyMap<string, string>): ContentViolation[] {
  const violations: ContentViolation[] = [];
  for (const english of BILINGUAL_DOCUMENTS) {
    const zh = chinese(english);
    const en = files.get(english);
    const cn = files.get(zh);
    if (en === undefined || cn === undefined) {
      violations.push({
        where: english,
        message: `needs both ${path.basename(english)} and ${path.basename(zh)}`,
      });
      continue;
    }
    const nav = `[English](${path.basename(english)}) | [简体中文](${path.basename(zh)})`;
    for (const [where, text] of [
      [english, en],
      [zh, cn],
    ] as const) {
      if (!text.includes(nav))
        violations.push({ where, message: 'missing the language navigation line' });
    }
    const a = examples(en);
    const b = examples(cn);
    if (a.length !== b.length) {
      violations.push({
        where: zh,
        message: `has ${b.length} code examples, the English one ${a.length}`,
      });
    } else {
      a.forEach((code, i) => {
        if (code !== b[i])
          violations.push({
            where: zh,
            message: `code example ${i + 1} differs from the English one`,
          });
      });
    }
  }
  return violations;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && !BINARY.test(p));
  const files = paths.map((p) => ({ path: p, text: readFileSync(path.join(root, p), 'utf8') }));
  const violations = [
    ...findContentViolations(files),
    ...findBilingualViolations(new Map(files.map((f) => [f.path, f.text]))),
  ];
  for (const v of violations) console.error(`${v.where}: ${v.message}`);
  if (violations.length > 0) process.exitCode = 1;
  else console.log(`content ok (${files.length} files)`);
}
