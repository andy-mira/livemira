// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// The release version has one source: "version" of the root package.json. Release generators, banners and descriptions read it here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT_PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
// Canonical release guide: a generic path, so that it is not renamed on every release.
export const RELEASE_GUIDE = 'docs/release/livemira-release.md';
// SemVer 2.0: reject leading zeroes and empty prerelease/build identifiers.
const NUM = '(?:0|[1-9][0-9]*)';
const PRE = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export const isReleaseVersion = value => typeof value === 'string' && SEMVER.test(value);
export const isPreviewVersion = value => value.split('+')[0].includes('-');
export const ROOT_METADATA = Object.freeze(JSON.parse(readFileSync(ROOT_PACKAGE_PATH, 'utf8')));
const textField = value => typeof value === 'string' && value.length > 0 && !/[\r\n]|\*\//.test(value);
if (!textField(ROOT_METADATA.author) || !textField(ROOT_METADATA.license) || !textField(ROOT_METADATA.livemira?.displayName) ||
    !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(ROOT_METADATA.livemira?.enginePackageName ?? '') ||
    !Number.isInteger(ROOT_METADATA.livemira?.copyrightYear) || ROOT_METADATA.livemira.copyrightYear < 2000)
  throw new Error('package.json release metadata is missing or invalid');
export const ENGINE_NAME = ROOT_METADATA.livemira.displayName;
export const ENGINE_PACKAGE_NAME = ROOT_METADATA.livemira.enginePackageName;
export function workspacePackageName(directory) {
  return JSON.parse(readFileSync(new URL(`../../packages/${directory}/package.json`, import.meta.url), 'utf8')).name;
}

export function readReleaseVersion(file = ROOT_PACKAGE_PATH) {
  const { version } = JSON.parse(readFileSync(file, 'utf8'));
  if (!isReleaseVersion(version)) throw new Error(`release version: ${file} has no valid "version": ${JSON.stringify(version)}`);
  return version;
}
export const RELEASE_VERSION = readReleaseVersion();

// Development Demo pages carry "LiveMira <version>" labels; the Demo generator materializes them from the release version instead of copying a stale literal.
export function materializeVersionLabels(html, version = RELEASE_VERSION) {
  if (!isReleaseVersion(version)) throw new Error('Invalid SemVer for page');
  html = html.replaceAll('{{ENGINE_NAME}}', ENGINE_NAME).replaceAll('{{RELEASE_VERSION}}', version);
  const escapedName = ENGINE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = new RegExp(`${escapedName} [0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?`, 'g');
  if (!label.test(html)) throw new Error('release version: the page has no "LiveMira <version>" label to materialize');
  const preview = isPreviewVersion(version);
  return html.replace(label, `${ENGINE_NAME} ${version}`)
    .replace(/\b(?:STABLE|PREVIEW)\b/g, preview ? 'PREVIEW' : 'STABLE')
    .replace(new RegExp(`(${escapedName} [0-9A-Za-z.+-]+) (?:稳定版|候选版)：`, 'g'), `$1 ${preview ? '候选版' : '稳定版'}：`);
}
