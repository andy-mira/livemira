import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHomography, validateTargetBundle, IDENTITY_3 } from '../index.mjs';
const bundle = () => ({schemaVersion:1,compilerVersion:'test',algorithmVersion:'test',targetId:'test',imageHash:'a'.repeat(64),widthPx:4,heightPx:4,physicalWidthMeters:null,orientation:'top-left',pyramid:[],features:{points:[],descriptorType:'test',descriptorLength:32,descriptors:[]},preprocessing:{},diagnostics:[]});
test('homography normalization and singular/nonfinite rejection', () => {
  assert.deepEqual(normalizeHomography(IDENTITY_3.map(x=>2*x)), IDENTITY_3);
  for (const bad of [[0,0,0,0,0,0,0,0,0],[1,0,0,0,0,0,0,0,1],[1,0,0,0,1,0,0,0,NaN]]) assert.throws(()=>normalizeHomography(bad));
});
test('target structural validation rejects versions, missing metric values, lengths and bounds', () => {
  validateTargetBundle(bundle());
  for (const change of [{schemaVersion:2},{widthPx:Infinity},{physicalWidthMeters:0},{imageHash:'bad'},{pyramid:[{width:2,height:2,scale:1,pixels:[1]}]},{features:{points:[[0,0]],descriptorLength:32,descriptorType:'test',descriptors:[]}}]) assert.throws(()=>validateTargetBundle({...bundle(),...change}));
});
