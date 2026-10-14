/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, snapshotCpuFeatureOptions, validateTargetBundle, type CpuFeatureOptions, type TargetBundle, type QualityDiagnostic, type Point2 } from '@livemira/contracts';
import { ALGORITHM, ANMS_ALGORITHM, LIMITS, hamming, pyramid, validateGray, type GrayImage, type LocalFeature } from '../../recognition/experimental/features.mjs';
import { ANMS_SELECTION_ID, extractLegacyFamily } from '../../recognition/src/legacy-family.mjs';
import { hullArea } from '../../recognition/experimental/geometry.mjs';
import { ORIENTED_ALGORITHM, ORIENTED_LEVELS, extractOriented, orientedPyramid } from '../../recognition/src/oriented.mjs';

export const COMPILER_VERSION = 'webar-gray8-cpu/0.1.0';
export const ALGORITHM_VERSION = ALGORITHM;
export const ORIENTED_ALGORITHM_VERSION = ORIENTED_ALGORITHM;
/** Legacy-family detector and descriptor with ANMS spatial selection (CVPR 2005 section 3). Distinct identity: bundles and live extraction never mix it with ALGORITHM_VERSION. */
export const ANMS_ALGORITHM_VERSION = ANMS_ALGORITHM;
export const ANMS_COMPILER_VERSION = 'webar-gray8-cpu/0.3.0';
export const SUPPORTED_ALGORITHM_VERSIONS: readonly string[] = Object.freeze([ALGORITHM, ANMS_ALGORITHM, ORIENTED_ALGORITHM]);
const compilerVersionFor = (algorithmVersion: string): string => algorithmVersion === ORIENTED_ALGORITHM ? ORIENTED_COMPILER_VERSION : algorithmVersion === ANMS_ALGORITHM ? ANMS_COMPILER_VERSION : COMPILER_VERSION;
export const ORIENTED_COMPILER_VERSION = 'webar-gray8-cpu/0.2.0';
export const MAX_SERIALIZED_BYTES = 24_000_000;
export interface CompileGrayOptions { targetId: string; physicalWidthMeters?: number | null; maxFeatures?: number; levels?: number; algorithmVersion?: string; /** Default absent: reference extraction. Every option yields a byte-identical bundle; legacy family only, ignored by v2. Invalid values throw INVALID_CONFIG. */ cpuFeatures?: CpuFeatureOptions }
const invalid = (reason: string): never => { throw new EngineError('INVALID_TARGET', false, reason); };
const encoder = new TextEncoder();
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
export function diagnoseFeatures(features: readonly LocalFeature[], width: number, height: number): QualityDiagnostic[] {
  const diagnostics: QualityDiagnostic[] = [];
  const add = (code: string, message: string) => diagnostics.push({ code, message, severity: 'error' });
  if (features.length < 24) add('LOW_TEXTURE', `Only ${features.length} features; require at least 24 for this baseline.`);
  if (hullArea(features.map(f => [f.x, f.y])) / (width * height) < 0.15) add('LOW_COVERAGE', 'Features cover less than 15 percent of target area.');
  const repeated = features.filter((f, i) => features.some((g, j) => i !== j && hamming(f.descriptor, g.descriptor) <= 16)).length;
  if (features.length && repeated / features.length > 0.35) add('REPETITIVE_TEXTURE', 'More than 35 percent of descriptors have a near duplicate.');
  return diagnostics;
}
export async function compileGrayTarget(image: GrayImage, options: CompileGrayOptions): Promise<TargetBundle> {
  validateGray(image);
  // Snapshot before the first await so caller mutation cannot desynchronize hash/features.
  const snapshot = { ...image, data: new Uint8Array(image.data) };
  const { targetId, physicalWidthMeters = null, algorithmVersion = ALGORITHM } = options;
  const briefOffsets = snapshotCpuFeatureOptions(options.cpuFeatures)?.briefOffsets === true;
  if (!SUPPORTED_ALGORITHM_VERSIONS.includes(algorithmVersion)) invalid('Unsupported target algorithm; explicit recompilation required');
  const oriented = algorithmVersion === ORIENTED_ALGORITHM;
  const { maxFeatures = oriented ? 512 : 384, levels = oriented ? ORIENTED_LEVELS : 3 } = options;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) || (physicalWidthMeters !== null && (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0))) invalid('Invalid target identity or physical width');
  const { features } = oriented ? extractOriented(snapshot, { maxFeatures, levels }) : extractLegacyFamily(snapshot, algorithmVersion, { maxFeatures, levels, briefOffsets });
  const result: TargetBundle = {
    schemaVersion: 1, compilerVersion: compilerVersionFor(algorithmVersion), algorithmVersion, targetId,
    imageHash: await hash(snapshot.data), imageHashDomain: 'canonical-gray8', widthPx: snapshot.width, heightPx: snapshot.height,
    physicalWidthMeters, orientation: 'top-left',
    pyramid: (oriented ? orientedPyramid : pyramid)(snapshot, levels).map(l => ({ width: l.width, height: l.height, scale: l.scale, pixels: Array.from(l.data) })),
    features: { points: features.map(f => [f.x, f.y] as Point2), descriptorType: algorithmVersion, descriptorLength: 32, descriptors: features.flatMap(f => f.descriptor) },
    preprocessing: { pixelFormat: 'gray8', levels, maxFeatures, downsample: oriented ? 'bilinear-1.2-center' : 'box2-center', smoothing: oriented ? 'binomial3' : 'box3', orientation: oriented ? 'intensity-centroid-r12' : 'upright-only', ...(algorithmVersion === ANMS_ALGORITHM ? { selection: ANMS_SELECTION_ID } : {}) },
    diagnostics: diagnoseFeatures(features, snapshot.width, snapshot.height),
  };
  validateTargetBundle(result);
  return result;
}
export function featuresFromTarget(target: TargetBundle): LocalFeature[] {
  return target.features.points.map(([x, y], i) => ({ x, y, level: 0, score: 1,
    descriptor: target.features.descriptors.slice(i * 32, (i + 1) * 32) }));
}
export function preflightCompiledTarget(value: unknown): asserts value is TargetBundle {
  const candidate = value as Partial<TargetBundle> | null;
  // Apply the compiler's smaller allocation/work limits before the general shared validator.
  if (!candidate || !Array.isArray(candidate.features?.points) || candidate.features.points.length > LIMITS.features ||
      !Array.isArray(candidate.features?.descriptors) || candidate.features.descriptors.length > LIMITS.features * 32 ||
      !Array.isArray(candidate.pyramid) || candidate.pyramid.length > 8 ||
      candidate.pyramid.some(l => !Array.isArray(l?.pixels) || l.pixels.length > LIMITS.pixels)) invalid('Target exceeds CPU baseline bounds');
  validateTargetBundle(value);
  const t = value;
  const oriented = t.algorithmVersion === ORIENTED_ALGORITHM;
  if (!SUPPORTED_ALGORITHM_VERSIONS.includes(t.algorithmVersion) || t.compilerVersion !== compilerVersionFor(t.algorithmVersion) || t.features.descriptorType !== t.algorithmVersion ||
      t.features.descriptorLength !== 32 || t.imageHashDomain !== 'canonical-gray8' ||
      t.widthPx < 32 || t.heightPx < 32 || t.widthPx > LIMITS.dimension || t.heightPx > LIMITS.dimension || t.widthPx * t.heightPx > LIMITS.pixels ||
      t.features.points.length > LIMITS.features || t.pyramid.length < 1 || t.pyramid.length > (oriented ? 8 : LIMITS.levels) ||
      !t.features.descriptors.every(v => Number.isInteger(v) && v >= 0 && v <= 255) ||
      !t.features.points.every(([x,y]) => x >= 0 && y >= 0 && x < t.widthPx && y < t.heightPx)) invalid('Unsupported algorithm, dimensions or feature data');
}
export async function validateCompiledTarget(value: unknown): Promise<TargetBundle> {
  preflightCompiledTarget(value);
  const t = value, p = t.preprocessing, oriented = t.algorithmVersion === ORIENTED_ALGORITHM;
  if (p.pixelFormat !== 'gray8' || p.downsample !== (oriented ? 'bilinear-1.2-center' : 'box2-center') ||
      p.smoothing !== (oriented ? 'binomial3' : 'box3') || p.orientation !== (oriented ? 'intensity-centroid-r12' : 'upright-only') ||
      typeof p.levels !== 'number' || !Number.isInteger(p.levels) || p.levels < 1 || p.levels > (oriented ? 8 : LIMITS.levels) ||
      typeof p.maxFeatures !== 'number' || !Number.isInteger(p.maxFeatures) || p.maxFeatures < 16 || p.maxFeatures > LIMITS.features ||
      t.features.points.length > p.maxFeatures || p.selection !== (t.algorithmVersion === ANMS_ALGORITHM ? ANMS_SELECTION_ID : undefined)) invalid('Unsupported preprocessing');
  const base = t.pyramid[0];
  if (base.width !== t.widthPx || base.height !== t.heightPx || base.scale !== 1) invalid('Invalid pyramid base');
  const expected = (oriented ? orientedPyramid : pyramid)({ width: base.width, height: base.height, data: new Uint8Array(base.pixels) }, p.levels as number);
  if (expected.length !== t.pyramid.length || expected.some((l, i) => l.width !== t.pyramid[i].width || l.height !== t.pyramid[i].height ||
      l.scale !== t.pyramid[i].scale || !l.data.every((v, j) => v === t.pyramid[i].pixels[j]))) invalid('Inconsistent pyramid');
  if (await hash(new Uint8Array(base.pixels)) !== t.imageHash) invalid('Canonical gray8 hash mismatch');
  return t;
}
export async function serializeTarget(target: TargetBundle): Promise<string> {
  preflightCompiledTarget(target);
  const snapshot = structuredClone(target);
  await validateCompiledTarget(snapshot);
  const payload = JSON.stringify(snapshot);
  if (encoder.encode(payload).byteLength > MAX_SERIALIZED_BYTES) invalid('Target exceeds serialization budget');
  const text = JSON.stringify({ payload, sha256: await hash(encoder.encode(payload)) });
  if (encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES) invalid('Target exceeds serialization budget');
  return text;
}
export async function parseTarget(text: string): Promise<TargetBundle> {
  if (typeof text !== 'string' || text.length > MAX_SERIALIZED_BYTES || encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES) invalid('Target exceeds serialization budget');
  const envelope = JSON.parse(text) as { payload?: unknown; sha256?: unknown } | null;
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.sha256 !== 'string' || await hash(encoder.encode(envelope.payload)) !== envelope.sha256) invalid('Target integrity mismatch');
  return validateCompiledTarget(JSON.parse(envelope!.payload as string));
}
