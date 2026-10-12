/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, normalizeHomography, type FramePacket, type RecognitionObservation, type TargetBundle } from '@livemira/contracts';
import { LIMITS, type GrayImage, type LocalRoi } from '../experimental/features.mjs';
import { extractLegacyFamily, isLegacyFamily } from './legacy-family.mjs';
import { verifyGeometry, hullArea, validateHomography } from '../experimental/geometry.mjs';
import { validateCompiledTarget, preflightCompiledTarget, featuresFromTarget, diagnoseFeatures, SUPPORTED_ALGORITHM_VERSIONS } from '../../target-compiler/src/index.ts';
import { ORIENTED_ALGORITHM, extractOriented, packDescriptors, matchPacked, TargetIndex } from './oriented.mjs';
import { intermediateLegacyImage, LEGACY_INTERMEDIATE_SCALE } from './legacy-scale.mjs';

export interface RecognitionOptions { roi?: LocalRoi | null; signal?: AbortSignal }
export interface ExactMatchRequest { targetId: string; descriptors: Uint8Array }
export interface ExactMatchResult { targetId: string; pairs: {targetIndex:number;frameIndex:number;distance:number}[] }
export interface ExactMatchingOutput { backend: 'cpu'|'webgpu'|'wasm'; matches: ExactMatchResult[] }
export type ExactMatchingOperator = (targets: readonly ExactMatchRequest[], frameDescriptors: Uint8Array, signal?: AbortSignal) => Promise<ExactMatchingOutput>;
export interface CpuRecognizerOptions { exactMatching?: ExactMatchingOperator; /** Default true: retry a global miss once at a half-octave scale (legacy family only). Must be a boolean when given; false is for diagnostic comparison. */ legacyScaleSearch?: boolean; /** Default false: when true, `diagnostics.passes` carries one bounded fact record per recognition pass (no extra work, no extra feature extraction). */ capturePasses?: boolean; /** When set, only bundles compiled with exactly this algorithm identity load; otherwise the identity comes from the (uniform) bundles, as before. */ algorithmVersion?: string }
/** Facts of ONE pass, snapshotted before any accumulation. prepareMs is the input preparation (resampling) of that pass and is not part of its featureMs. */
export interface RecognitionPassFacts { scale: number; prepareMs: number; featureMs: number; retrievalMs: number; matchMs: number; geometryMs: number; totalMs: number; featureCount: number; candidateCount: number; observationCount: number; ambiguous: boolean; budgetExhausted: boolean; rejected: { targetId: string; reason: string }[] }
export interface RecognitionBatch { observations: RecognitionObservation[]; ambiguous: boolean; rejected: { targetId: string; reason: string }[];
  diagnostics: { algorithmVersion: string; matchingBackend: 'cpu'|'webgpu'|'wasm'; legacyScalePasses: number; featureMs: number; retrievalMs: number; matchMs: number; geometryMs: number; totalMs: number; featureCount: number; candidateCount: number; retrievalComparisons: number; bucketVisits: number; budgetExhausted: boolean; fineComparisons: number; /** Present only when the recognizer was created with capturePasses (1 entry, or 2 after a scale retry). */ passes?: RecognitionPassFacts[] } }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new EngineError('ABORTED', true, 'Recognition cancelled'); }

function passFacts(batch: RecognitionBatch, scale: number, prepareMs: number): RecognitionPassFacts {
  const d = batch.diagnostics;
  return { scale, prepareMs, featureMs: d.featureMs, retrievalMs: d.retrievalMs, matchMs: d.matchMs, geometryMs: d.geometryMs, totalMs: d.totalMs, featureCount: d.featureCount, candidateCount: d.candidateCount, observationCount: batch.observations.length, ambiguous: batch.ambiguous, budgetExhausted: d.budgetExhausted, rejected: batch.rejected.map(r => ({ targetId: r.targetId, reason: r.reason })) };
}

export class CpuRecognizer {
  #targets: TargetBundle[] = [];
  #disposed = false;
  #generation = 0;
  #cache: {features: ReturnType<typeof featuresFromTarget>;packed: Uint32Array;bytes: Uint8Array;diagnostics: ReturnType<typeof diagnoseFeatures>}[] = [];
  #index: TargetIndex | null = null;
  #exactMatching?: ExactMatchingOperator;
  #pending = false;
  #legacyScaleSearch: boolean;
  #algorithmVersion?: string;
  #capturePasses: boolean;
  constructor(options: CpuRecognizerOptions = {}) {
    if (options.legacyScaleSearch !== undefined && typeof options.legacyScaleSearch !== 'boolean') throw new EngineError('INVALID_CONFIG', false, 'legacyScaleSearch must be a boolean');
    if (options.capturePasses !== undefined && typeof options.capturePasses !== 'boolean') throw new EngineError('INVALID_CONFIG', false, 'capturePasses must be a boolean');
    this.#capturePasses = options.capturePasses === true;
    if (options.algorithmVersion !== undefined && !SUPPORTED_ALGORITHM_VERSIONS.includes(options.algorithmVersion)) throw new EngineError('INVALID_CONFIG', false, 'Unsupported recognition algorithm');
    this.#exactMatching = options.exactMatching; this.#legacyScaleSearch=options.legacyScaleSearch??true; this.#algorithmVersion=options.algorithmVersion;
  }
  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.#alive();
    if (this.#pending) throw new EngineError('INVALID_CONFIG', true, 'Cannot replace targets during recognition');
    if (!targets.length || targets.length > LIMITS.targets || new Set(targets.map(t => t.targetId)).size !== targets.length) throw new EngineError('INVALID_TARGET', false, 'Require 1 to 10 unique targets');
    const generation = ++this.#generation, next: TargetBundle[] = [];
    targets.forEach(preflightCompiledTarget);
    if (new Set(targets.map(t => t.algorithmVersion)).size !== 1) throw new EngineError('INVALID_TARGET', false, 'Mixed algorithms require explicit target recompilation');
    if (this.#algorithmVersion !== undefined && targets[0].algorithmVersion !== this.#algorithmVersion) throw new EngineError('INVALID_TARGET', false, 'Target algorithm differs from the configured algorithm; recompile the targets');
    // Snapshot all targets together before any asynchronous digest work.
    for (const copy of structuredClone(targets)) { await validateCompiledTarget(copy); next.push(copy); }
    this.#alive();
    if (generation !== this.#generation) throw new EngineError('ABORTED', true, 'Target load superseded');
    this.#targets = next;
    this.#cache = next.map(t => { const features = featuresFromTarget(t); return {features,packed:packDescriptors(features),bytes:new Uint8Array(t.features.descriptors),diagnostics:diagnoseFeatures(features,t.widthPx,t.heightPx)}; });
    this.#index = next[0].algorithmVersion === ORIENTED_ALGORITHM ? new TargetIndex(this.#cache) : null;
  }
  #alive(): void { if (this.#disposed) throw new EngineError('DISPOSED', false, 'Recognizer disposed'); }
  async recognizeGray(image: GrayImage, identity: Pick<FramePacket, 'sessionId' | 'frameId'>, options: RecognitionOptions = {}): Promise<RecognitionBatch> {
    this.#alive(); abort(options.signal);
    if (this.#pending) throw new EngineError('INVALID_CONFIG', true, 'Only one recognition job may be in flight');
    this.#pending=true;
    try {
      const start=performance.now(),primary=await this.#recognize(image,identity,options);
      // Snapshot the first pass before anything is accumulated into a later batch; with capturePasses off nothing is stored.
      const first=this.#capturePasses?passFacts(primary,1,0):null;
      if(first)primary.diagnostics.passes=[first];
      // Retry only a global miss; never bypass an ambiguous result or alter v2. The legacy family (greedy and ANMS selection) shares this search.
      if(!this.#legacyScaleSearch||options.roi||primary.observations.length||primary.ambiguous||!isLegacyFamily(this.#targets[0]?.algorithmVersion))return primary;
      abort(options.signal);this.#alive();
      const resampleStart=performance.now();
      const scaled=intermediateLegacyImage(image);if(!scaled)return primary;
      const resampleMs=performance.now()-resampleStart;
      const secondary=await this.#recognize(scaled,identity,options,LEGACY_INTERMEDIATE_SCALE);
      const second=first?passFacts(secondary,LEGACY_INTERMEDIATE_SCALE,resampleMs):null;
      for(const key of ['featureMs','retrievalMs','matchMs','geometryMs','fineComparisons'] as const)secondary.diagnostics[key]+=primary.diagnostics[key];
      secondary.diagnostics.featureMs+=resampleMs;
      secondary.diagnostics.totalMs=performance.now()-start;secondary.diagnostics.legacyScalePasses=2;
      if(first&&second)secondary.diagnostics.passes=[first,second];
      return secondary;
    } finally { this.#pending=false; }
  }
  async #recognize(image: GrayImage, identity: Pick<FramePacket, 'sessionId' | 'frameId'>, options: RecognitionOptions, featureImageScale=1): Promise<RecognitionBatch> {
    if (!this.#targets.length) throw new EngineError('INVALID_TARGET', false, 'No targets loaded');
    if (!identity.sessionId || !Number.isSafeInteger(identity.frameId) || identity.frameId < 0) throw new EngineError('FRAME_FAILED', false, 'Invalid frame identity');
    const start = performance.now(), algorithmVersion = this.#targets[0].algorithmVersion, oriented = algorithmVersion === ORIENTED_ALGORITHM;
    const { features } = oriented ? extractOriented(image, { maxFeatures: 512, levels: 6, roi: options.roi }) : extractLegacyFamily(image, algorithmVersion, { maxFeatures: 512, levels: 3, roi: options.roi });
    // Restore points before matching/geometric validation: threshold stays 3 ORIGINAL pixels.
    if(featureImageScale!==1)for(const f of features){f.x=(f.x+.5)/featureImageScale-.5;f.y=(f.y+.5)/featureImageScale-.5;}
    const featureMs = performance.now()-start, retrievalStart = performance.now();
    const retrieval = this.#index && this.#targets.length > 3 ? this.#index.query(features) : null;
    const indices = retrieval?.indices ?? this.#targets.map((_, i) => i), packed = retrieval?.packed ?? packDescriptors(features);
    const diagnostics: RecognitionBatch['diagnostics'] = {algorithmVersion,matchingBackend:'cpu',legacyScalePasses:1,featureMs,retrievalMs:performance.now()-retrievalStart,matchMs:0,geometryMs:0,totalMs:0,featureCount:features.length,candidateCount:indices.length,retrievalComparisons:retrieval?.comparisons??0,bucketVisits:retrieval?.bucketVisits??0,budgetExhausted:retrieval?.exhausted??false,fineComparisons:0};
    let accelerated: Map<string, ExactMatchResult['pairs']> | null = null;
    if (oriented && this.#exactMatching && indices.length) {
      const requested = indices.filter(i=>!this.#cache[i].diagnostics.length).map(i=>({targetId:this.#targets[i].targetId,descriptors:this.#cache[i].bytes}));
      if (requested.length) {
        const matchStart=performance.now(), generation=this.#generation;
        const output = await this.#exactMatching(requested,new Uint8Array(features.flatMap(f=>f.descriptor)),options.signal);
        abort(options.signal);this.#alive();
        if(generation!==this.#generation)throw new EngineError('ABORTED',true,'Recognition generation changed');
        if(!['cpu','webgpu','wasm'].includes(output.backend)||output.matches.length!==requested.length||new Set(output.matches.map(m=>m.targetId)).size!==requested.length||output.matches.some(m=>!requested.some(r=>r.targetId===m.targetId)))throw new EngineError('FRAME_FAILED',false,'Invalid exact matching batch');
        accelerated=new Map(output.matches.map(m=>[m.targetId,m.pairs]));diagnostics.matchingBackend=output.backend;diagnostics.matchMs=performance.now()-matchStart;
      }
    }
    const observations: RecognitionObservation[] = [], rejected: RecognitionBatch['rejected'] = [];
    for (const index of indices) {
      abort(options.signal);
      const target = this.#targets[index], cached = this.#cache[index], targetFeatures = cached.features;
      if (cached.diagnostics.length) { rejected.push({ targetId: target.targetId, reason: cached.diagnostics.map(d => d.code).join(',') }); continue; }
      const matchStart = performance.now();
      const external = accelerated?.get(target.targetId);
      if(external&&(!Array.isArray(external)||external.length>Math.min(targetFeatures.length,features.length)||new Set(external.map(p=>p.targetIndex)).size!==external.length||new Set(external.map(p=>p.frameIndex)).size!==external.length||external.some(p=>!Number.isInteger(p.targetIndex)||p.targetIndex<0||p.targetIndex>=targetFeatures.length||!Number.isInteger(p.frameIndex)||p.frameIndex<0||p.frameIndex>=features.length||!Number.isInteger(p.distance)||p.distance<0||p.distance>64)))throw new EngineError('FRAME_FAILED',false,'Invalid exact match indices');
      const pairs = external ? external.map(p=>({target:[targetFeatures[p.targetIndex].x,targetFeatures[p.targetIndex].y] as [number,number],image:[features[p.frameIndex].x,features[p.frameIndex].y] as [number,number],distance:p.distance})) : matchPacked(targetFeatures, features, cached.packed, packed);
      diagnostics.matchMs += performance.now()-matchStart; diagnostics.fineComparisons += targetFeatures.length*features.length;
      const geometryStart = performance.now(), result = verifyGeometry(pairs, target.widthPx, target.heightPx, {adaptive:oriented});
      diagnostics.geometryMs += performance.now()-geometryStart;
      // Contract corners are pixel edges, so also check the outer width/height boundary.
      if (!result.accepted || !validateHomography(result.H, target.widthPx + 1, target.heightPx + 1)) { rejected.push({ targetId: target.targetId, reason: result.accepted ? 'INVALID_BOUNDARY' : result.reason }); continue; }
      observations.push({ sessionId: identity.sessionId, frameId: identity.frameId, targetId: target.targetId, H_imageFromTarget: normalizeHomography(result.H!),
        targetPoints: pairs.map(p => p.target), imagePoints: pairs.map(p => p.image), inliers: result.inlierMask,
        reprojectionErrorPx: result.rmsErrorPx!, spatialCoverage: hullArea(pairs.filter((_,i) => result.inlierMask[i]).map(p => p.target)) / (target.widthPx * target.heightPx),
        degenerate: false, algorithmVersion, correspondenceOrigin: 'original-target', rejectionReasons: [] });
    }
    const count = (o: RecognitionObservation) => o.inliers.filter(Boolean).length;
    observations.sort((a,b) => count(b) - count(a) || a.reprojectionErrorPx - b.reprojectionErrorPx);
    const ambiguous = Boolean(retrieval?.ambiguous) || (observations.length > 1 && count(observations[1]) >= count(observations[0]) * 0.85);
    abort(options.signal);
    // Suppress ambiguous candidates at the adapter boundary so D cannot accidentally select an ID.
    if (ambiguous) for (const o of observations) rejected.push({ targetId: o.targetId, reason: 'AMBIGUOUS_TARGETS' });
    if (retrieval) for (let i=0;i<this.#targets.length;i++) if (!indices.includes(i)) rejected.push({targetId:this.#targets[i].targetId,reason:retrieval.ambiguous?'RETRIEVAL_AMBIGUITY':'NOT_SHORTLISTED'});
    diagnostics.totalMs=performance.now()-start;
    return { observations: ambiguous ? [] : observations, ambiguous, rejected, diagnostics };
  }
  async recognizeFrame(frame: FramePacket, options: RecognitionOptions = {}): Promise<RecognitionBatch> {
    this.#alive(); abort(options.signal);
    if (frame.pixelFormat !== 'gray8' || frame.imageHandle.kind !== 'gray8' || frame.imageHandle.released ||
        !(frame.imageHandle.data instanceof Uint8Array) || frame.rotation !== 0 || frame.mirrored) throw new EngineError('UNSUPPORTED', true, 'Expected borrowed packed, upright, unmirrored canonical gray8');
    return this.recognizeGray({ width: frame.width, height: frame.height, data: frame.imageHandle.data }, frame, options);
  }
  dispose(): void { this.#disposed = true; this.#generation++; this.#targets = []; this.#cache=[];this.#index=null; }
}
