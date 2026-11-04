"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // packages/imaging/src/pyramid.ts
  var PyramidWorkspace = class {
    constructor() {
      __publicField(this, "rows", new Int32Array(0));
      __publicField(this, "levels", []);
    }
    /** Builds up to `levels` levels (stopping before a side drops below `minSize`); level 0 is the input itself. */
    build(image, levels, minSize = 24) {
      const out = [{ ...image, scale: 1 }];
      for (let l = 1; l < levels; l++) {
        const prev = out[l - 1];
        const w = prev.width >> 1;
        const h = prev.height >> 1;
        if (w < minSize || h < minSize) break;
        if (this.rows.length < prev.width * h) this.rows = new Int32Array(prev.width * h);
        const buf = this.levels[l] = this.levels[l] && this.levels[l].length === w * h ? this.levels[l] : new Uint8Array(w * h);
        downsample(prev, w, h, this.rows, buf);
        out.push({ width: w, height: h, stride: w, data: buf, scale: prev.scale * 2 });
      }
      return { levels: out };
    }
  };
  function downsample(src, w, h, rows, dst) {
    const sw = src.width;
    const sh = src.height;
    const s = src.data;
    const stride = src.stride;
    for (let y = 0; y < h; y++) {
      const c = 2 * y;
      const r0 = Math.max(0, c - 1) * stride;
      const r1 = c * stride;
      const r2 = Math.min(sh - 1, c + 1) * stride;
      const r3 = Math.min(sh - 1, c + 2) * stride;
      const o = y * sw;
      for (let x = 0; x < sw; x++) rows[o + x] = s[r0 + x] + 3 * s[r1 + x] + 3 * s[r2 + x] + s[r3 + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * sw;
      for (let x = 0; x < w; x++) {
        const c = 2 * x;
        const a = rows[o + Math.max(0, c - 1)];
        const b = rows[o + c];
        const d = rows[o + Math.min(sw - 1, c + 1)];
        const e = rows[o + Math.min(sw - 1, c + 2)];
        dst[y * w + x] = a + 3 * b + 3 * d + e + 32 >> 6;
      }
    }
  }
  function buildPyramid(image, levels, minSize = 24) {
    return new PyramidWorkspace().build(image, levels, minSize);
  }

  // packages/imaging/src/sample.ts
  function scharr(image, out) {
    const { width: w, height: h, stride, data: d } = image;
    const gx = out && out.gx.length === w * h ? out.gx : new Float32Array(w * h);
    const gy = out && out.gy.length === w * h ? out.gy : new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const a = (y - 1) * stride;
      const b = y * stride;
      const c = (y + 1) * stride;
      for (let x = 1; x < w - 1; x++) {
        gx[y * w + x] = (3 * (d[a + x + 1] - d[a + x - 1]) + 10 * (d[b + x + 1] - d[b + x - 1]) + 3 * (d[c + x + 1] - d[c + x - 1])) / 32;
        gy[y * w + x] = (3 * (d[c + x - 1] - d[a + x - 1]) + 10 * (d[c + x] - d[a + x]) + 3 * (d[c + x + 1] - d[a + x + 1])) / 32;
      }
    }
    return { width: w, height: h, gx, gy };
  }
  function sample(image, x, y) {
    const u = x - 0.5;
    const v = y - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    if (i < 0 || j < 0 || i + 1 >= image.width || j + 1 >= image.height) return NaN;
    const fx = u - i;
    const fy = v - j;
    const d = image.data;
    const o = j * image.stride + i;
    const top = d[o] + fx * (d[o + 1] - d[o]);
    const bottom = d[o + image.stride] + fx * (d[o + image.stride + 1] - d[o + image.stride]);
    return top + fy * (bottom - top);
  }
  function sampleGradient(image, x, y, out) {
    const u = x - 0.5;
    const v = y - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fy = v - j;
    const d = image.data;
    const s = image.stride;
    const r0 = (j - 1) * s + i - 1;
    const r1 = r0 + s;
    const r2 = r1 + s;
    const r3 = r2 + s;
    const a0 = d[r0], a1 = d[r0 + 1], a2 = d[r0 + 2], a3 = d[r0 + 3];
    const b0 = d[r1], b1 = d[r1 + 1], b2 = d[r1 + 2], b3 = d[r1 + 3];
    const c0 = d[r2], c1 = d[r2 + 1], c2 = d[r2 + 2], c3 = d[r2 + 3];
    const e0 = d[r3], e1 = d[r3 + 1], e2 = d[r3 + 2], e3 = d[r3 + 3];
    const gx00 = 3 * (a2 - a0) + 10 * (b2 - b0) + 3 * (c2 - c0);
    const gx10 = 3 * (a3 - a1) + 10 * (b3 - b1) + 3 * (c3 - c1);
    const gx01 = 3 * (b2 - b0) + 10 * (c2 - c0) + 3 * (e2 - e0);
    const gx11 = 3 * (b3 - b1) + 10 * (c3 - c1) + 3 * (e3 - e1);
    const gy00 = 3 * (c0 - a0) + 10 * (c1 - a1) + 3 * (c2 - a2);
    const gy10 = 3 * (c1 - a1) + 10 * (c2 - a2) + 3 * (c3 - a3);
    const gy01 = 3 * (e0 - b0) + 10 * (e1 - b1) + 3 * (e2 - b2);
    const gy11 = 3 * (e1 - b1) + 10 * (e2 - b2) + 3 * (e3 - b3);
    const top = b1 + fx * (b2 - b1);
    const bottom = c1 + fx * (c2 - c1);
    out[0] = top + fy * (bottom - top);
    const gxt = gx00 + fx * (gx10 - gx00);
    const gxb = gx01 + fx * (gx11 - gx01);
    out[1] = (gxt + fy * (gxb - gxt)) / 32;
    const gyt = gy00 + fx * (gy10 - gy00);
    const gyb = gy01 + fx * (gy11 - gy01);
    out[2] = (gyt + fy * (gyb - gyt)) / 32;
  }
  function sampleField(field, width2, x, y) {
    const u = x - 0.5;
    const v = y - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fy = v - j;
    const o = j * width2 + i;
    const top = field[o] + fx * (field[o + 1] - field[o]);
    const bottom = field[o + width2] + fx * (field[o + width2 + 1] - field[o + width2]);
    return top + fy * (bottom - top);
  }
  function inside(width2, height2, x, y, margin = 1) {
    return x >= 0.5 + margin && y >= 0.5 + margin && x < width2 - 0.5 - margin && y < height2 - 0.5 - margin;
  }

  // packages/features/src/generated/kernels-wasm.ts
  var KERNELS_WASM = Object.freeze({
    sha256: "d51fe1439175bb1343361385d7910036f36a63ed17a83311619a3b04cfa3e837",
    byteLength: 4375,
    base64: "AGFzbQEAAAABKAVgCn9/f39/f39/f38Bf2AFf39/f38AYAZ/f39/f38AYAF/AX9gAAADBgUAAQIDBAUDAQARBhkDfwFBgIDAAAt/AEGQgMAAC38AQYSAwAALB2IIBm1lbW9yeQIABWZhc3Q5AAAIbmVhcmVzdDIAARBuZWFyZXN0Ml9ncm91cGVkAAIHcmVzZXJ2ZQADC19faGVhcF9iYXNlAwEKcmVzZXRfaGVhcAAECl9fZGF0YV9lbmQDAgr5HQW/EAwIfwF7BX8EewF/DXsBfwJ7AX8HewF/FXsjgICAgABBwAJrIgokgICAgABBACELAkAgAyAFTw0AIAIgBE8NAEF9IAFrIQwgAUEDbCENQQMgAWshDiABQX1sIQ9BACABQQF0IhBrIREgBkH/ASAGQf8BSRv9DyESQQAhCwNAIAMgCGwhEyAAIAMgAWxqIRQgAiEVA0ACQEH//wNBfyAEIBVrIgZ0QX9zQf//A3EgBkEPSxsiFiAUIBVqIgYgDWoiF/0AAAAiGCAG/QAAACIZIBL9cyIa/SYiGyAGIA9qIhz9AAAAIh0gGv0mIh79UCAGQX1q/QAAACIfIBr9JiIgIAb9AAADIiEgGv0mIiL9UP1OIBggGSAS/XAiGf0oIiMgHSAZ/SgiJP1QICEgGf0oIiUgHyAZ/SgiJv1Q/U79UP1kcUUNACAWICIgBiAOav0AAAAiJyAa/SYiKP1OIikgBiAQaiIqQQJq/QAAACIrIBr9JiIsIAYgAWoiLUEDav0AAAAiLiAa/SYiL/1OIjD9TiIxIB4gHEF/av0AAAAiMiAa/SYiM/1OIjQgBiARaiI1QQJq/QAAACI2IBr9JiI3IBxBAWr9AAAAIjggGv0mIjn9TiI6/U4iO/1OIBdBAWr9AAAAIjwgGv0mIj39TiAsICggN/1OIj4gLyAi/U4iP/1OIkAgMyA1QX5q/QAAACJBIBr9JiJC/U4iQyA5IB79TiJE/U4iRf1O/U4gOiAp/U4iRiBCIAYgDGr9AAAAIikgGv0mIjr9TiJHIDT9TiJI/U4gL/1OICIgPiBE/U4iPiBDIDogIP1OIi/9TiJD/U79TiA7ICAgLUF9av0AAAAiIiAa/SYiNP1OIkQgR/1OIkf9TiAo/U4gNyBFIDQgKkF+av0AAAAiKCAa/SYiO/1OIkkgL/1OIkr9Tv1OIEggOyAXQX9q/QAAACIvIBr9JiI3/U4iRSBE/U4iRP1OIDn9TiAeIEMgSSA3IBv9TiI5/U4iSP1O/U4gMyBH/U4gRSAbID39TiIe/U4iM/1OIEIgSiA9ICz9TiIsIDn9TiI5/U79TiA6IET9TiAwIB79TiIe/U4gICBIICwgP/1OIiz9Tv1OIDQgMf1OIDP9TiA7IDkgQP1O/U4gNyBG/U4gHv1OIBsgLCA+/U79Tv1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1kICUgJyAZ/SgiG/1OIkIgKyAZ/SgiHiAuIBn9KCIg/U4iOv1OIjQgJCAyIBn9KCIs/U4iOyA2IBn9KCIzIDggGf0oIjf9TiIw/U4iMf1OIDwgGf0oIjn9TiAeIBsgM/1OIj4gICAl/U4iP/1OIkAgLCBBIBn9KCI9/U4iQyA3ICT9TiJE/U4iRf1O/U4gMCBC/U4iMCA9ICkgGf0oIkL9TiJGIDv9TiI7/U4gIP1OICUgPiBE/U4iPiBDIEIgJv1OIkT9TiJD/U79TiAxICYgIiAZ/SgiIP1OIkcgRv1OIkb9TiAb/U4gMyBFICAgKCAZ/SgiG/1OIjEgRP1OIkT9Tv1OIDsgGyAvIBn9KCIl/U4iMyBH/U4iRf1OIDf9TiAkIEMgMSAlICP9TiI3/U4iO/1O/U4gLCBG/U4gMyAjIDn9TiIk/U4iLP1OID0gRCA5IB79TiIeIDf9TiIz/U79TiBCIEX9TiA6ICT9TiIk/U4gJiA7IB4gP/1OIh79Tv1OICAgNP1OICz9TiAbIDMgQP1O/U4gJSAw/U4gJP1OICMgHiA+/U79Tv1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1kIhxycSIGRQ0AIAogMiAZ/XP9CwTwASAKIEEgGf1z/QsE4AEgCiApIBn9c/0LBNABIAogHyAZ/XP9CwTAASAKICIgGf1z/QsEsAEgCiAoIBn9c/0LBKABIAogLyAZ/XP9CwSQASAKIBggGf1z/QsEgAEgCiA8IBn9c/0LBHAgCiArIBn9c/0LBGAgCiAuIBn9c/0LBFAgCiAhIBn9c/0LBEAgCiAnIBn9c/0LBDAgCiA2IBn9c/0LBCAgCiA4IBn9c/0LBBAgCiAdIBn9c/0LBABBACEX/QwAAAAAAAAAAAAAAAAAAAAAIhkhGwNAIBsgCiAXav0ABAAiHv2KAf2OASEbIBkgHv2JAf2OASEZIBdBEGoiF0GAAkcNAAsgCiAaIDL9c/0LBPABIAogGiBB/XP9CwTgASAKIBogKf1z/QsE0AEgCiAaIB/9c/0LBMABIAogGiAi/XP9CwSwASAKIBogKP1z/QsEoAEgCiAaIC/9c/0LBJABIAogGiAY/XP9CwSAASAKIBogPP1z/QsEcCAKIBogK/1z/QsEYCAKIBogLv1z/QsEUCAKIBogIf1z/QsEQCAKIBogJ/1z/QsEMCAKIBogNv1z/QsEICAKIBogOP1z/QsEECAKIBogHf1z/QsEAEEAIRf9DAAAAAAAAAAAAAAAAAAAAAAiHiEaA0AgGiAKIBdq/QAEACIg/YoB/Y4BIRogHiAg/YkB/Y4BIR4gF0EQaiIXQYACRw0ACyAKIBv9CwSQAiAKIBn9CwSAAiAKIBr9CwSwAiAKIB79CwSgAiAcIBZxISogFSATaiEtIAkgC0ECdGohFwNAIAcgLSAGaCIcaiIWQQF0aiAKQYACaiAKQaACaiAqIBx2QQFxGyAcQQF0ai8BAEEBajsBACAXIBY2AgAgF0EEaiEXIAtBAWohCyAGQX9qIAZxIgYNAAsLIBVBEGoiFSAESQ0ACyADQQFqIgMgBUcNAAsLIApBwAJqJICAgIAAIAsL/wUGAn8CewR/AXsCfwF+AkAgAUUNAAJAIANFDQBBACEFA0AgACAFQQV0aiIG/QAAECEHIAb9AAAAIQhBfyEJQYECIQYgAiEKQQAhC0GBAiEMA0AgBiAKQRBq/QAAACAH/VH9YiAK/QAAACAI/VH9Yv1u/X39fyIN/RsAIA39GwFqIA39GwJqIA39GwNqIg4gDCAOIAxJGyAOIAZJIg8bIQwgCyAJIA8bIQkgCkEgaiEKIA4gBiAPGyIOIQYgAyALQQFqIgtHDQALIAQgBUEMbGoiBiAJNgIAIAZBCGogDDYCACAGQQRqIA42AgAgBUEBaiIFIAFHDQAMAgsLQQAhDwJAIAFBGEkNAEEAIQ8gBEEEaiIGIAFBf2qtQgx+IhCnIgpqIAZJDQAgBEEIaiIGIApqIAZJDQAgEEIgiKdBAEcNAP0MAAAAAAEAAAACAAAAAwAAACEHIAFBfHEiDyELA0AgBCAH/QwMAAAADAAAAAwAAAAMAAAA/bUBIg39GwBqIgZBfzYCACAEIA39GwFqIgpBfzYCACAEIA39GwJqIg5BfzYCACAEIA39GwNqIgxBfzYCACAGQQRqQYECNgIAIApBBGpBgQI2AgAgDkEEakGBAjYCACAMQQRqQYECNgIAIAZBCGpBgQI2AgAgCkEIakGBAjYCACAOQQhqQYECNgIAIAxBCGpBgQI2AgAgB/0MBAAAAAQAAAAEAAAABAAAAP2uASEHIAtBfGoiCw0ACyABIA9GDQELIA8hDgJAIAFBA3EiCkUNACAPIApqIQ4gBCAPQQxsaiEGA0AgBkL/////nyA3AgAgBkEIakGBAjYCACAGQQxqIQYgCkF/aiIKDQALCyAPIAFrQXxLDQAgASAOayEKIAQgDkEMbGohBgNAIAb9DP////8BAQAAAQEAAP/////9CwIAIAZBIGr9DAEBAAD/////AQEAAAEBAAD9CwIAIAZBEGr9DAEBAAABAQAA/////wEBAAD9CwIAIAZBMGohBiAKQXxqIgoNAAsLC7kGBgJ/AnsGfwF7An8BfgJAIAFFDQACQCAERQ0AQQAhBgNAIAAgBkEFdGoiB/0AABAhCCAH/QAAACEJQX8hCkGBAiELIAIhByADIQxBACENQYECIQ5BfyEPA0AgB0EQav0AAAAgCP1R/WIgB/0AAAAgCf1R/WL9bv19/X8iEP0bACAQ/RsBaiAQ/RsCaiAQ/RsDaiERAkACQCAMKAIAIhIgCkYNAAJAIBEgC08NACANIQ8gCyEOIBIhCiARIQsMAgsgESAOIBEgDkkbIQ4MAQsgESALIBEgC0kiEhshCyANIA8gEhshDwsgB0EgaiEHIAxBBGohDCAEIA1BAWoiDUcNAAsgBSAGQQxsaiIHIA82AgAgB0EIaiAONgIAIAdBBGogCzYCACAGQQFqIgYgAUcNAAwCCwtBACEPAkAgAUEYSQ0AQQAhDyAFQQRqIgcgAUF/aq1CDH4iE6ciEWogB0kNACAFQQhqIgcgEWogB0kNACATQiCIp0EARw0A/QwAAAAAAQAAAAIAAAADAAAAIQggAUF8cSIPIQsDQCAFIAj9DAwAAAAMAAAADAAAAAwAAAD9tQEiEP0bAGoiB0F/NgIAIAUgEP0bAWoiEUF/NgIAIAUgEP0bAmoiDEF/NgIAIAUgEP0bA2oiDUF/NgIAIAdBBGpBgQI2AgAgEUEEakGBAjYCACAMQQRqQYECNgIAIA1BBGpBgQI2AgAgB0EIakGBAjYCACARQQhqQYECNgIAIAxBCGpBgQI2AgAgDUEIakGBAjYCACAI/QwEAAAABAAAAAQAAAAEAAAA/a4BIQggC0F8aiILDQALIAEgD0YNAQsgDyEMAkAgAUEDcSIRRQ0AIA8gEWohDCAFIA9BDGxqIQcDQCAHQv////+fIDcCACAHQQhqQYECNgIAIAdBDGohByARQX9qIhENAAsLIA8gAWtBfEsNACABIAxrIREgBSAMQQxsaiEHA0AgB/0M/////wEBAAABAQAA//////0LAgAgB0Egav0MAQEAAP////8BAQAAAQEAAP0LAgAgB0EQav0MAQEAAAEBAAD/////AQEAAP0LAgAgB0EwaiEHIBFBfGoiEQ0ACwsLZQEDfwJAQQAoAoCAwIAAIgENAEEAQZ+AwIAAQXBxIgE2AoCAwIAACwJAIAAgAWpBD2pBcHEiAEH//wNqQRB2IgI/ACIDTQ0AIAIgA2tAAEF/Rw0AQQAPC0EAIAA2AoCAwIAAIAELFABBAEGfgMCAAEFwcTYCgIDAgAALAGwEbmFtZQAWFWxpdmVtaXJhX2tlcm5lbHMud2FzbQE5BQAFZmFzdDkBCG5lYXJlc3QyAhBuZWFyZXN0Ml9ncm91cGVkAwdyZXNlcnZlBApyZXNldF9oZWFwBxIBAA9fX3N0YWNrX3BvaW50ZXIATQlwcm9kdWNlcnMCCGxhbmd1YWdlAQRSdXN0AAxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuOTUuMCAoNTk4MDc2MTZlIDIwMjYtMDQtMTQpAJ0BD3RhcmdldF9mZWF0dXJlcwkrC2J1bGstbWVtb3J5Kw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3ZlcmxvbmcrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dCsHc2ltZDEyOA=="
  });

  // packages/features/src/kernels.ts
  function decode(base64) {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  var compiled;
  function instantiateKernels() {
    if (typeof WebAssembly === "undefined") return null;
    try {
      if (compiled === void 0) {
        const bytes = decode(KERNELS_WASM.base64);
        compiled = WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
      }
      return compiled ? new WebAssembly.Instance(compiled, {}).exports : null;
    } catch {
      compiled = null;
      return null;
    }
  }

  // packages/features/src/fast.ts
  var CIRCLE = [
    [0, -3],
    [1, -3],
    [2, -2],
    [3, -1],
    [3, 0],
    [3, 1],
    [2, 2],
    [1, 3],
    [0, 3],
    [-1, 3],
    [-2, 2],
    [-3, 1],
    [-3, 0],
    [-3, -1],
    [-2, -2],
    [-1, -3]
  ];
  function fastScore(d, o, offsets, t) {
    const c = d[o];
    const hi = c + t;
    const lo = c - t;
    const p0 = d[o + offsets[0]];
    const p8 = d[o + offsets[8]];
    if (p0 <= hi && p0 >= lo && p8 <= hi && p8 >= lo) return 0;
    const p4 = d[o + offsets[4]];
    const p12 = d[o + offsets[12]];
    if (p4 <= hi && p4 >= lo && p12 <= hi && p12 >= lo) return 0;
    let bright = 0;
    let dark = 0;
    let sb = 0;
    let sd = 0;
    for (let i = 0; i < 16; i++) {
      const p = d[o + offsets[i]];
      if (p > hi) {
        bright |= 1 << i;
        sb += p - hi;
      } else if (p < lo) {
        dark |= 1 << i;
        sd += lo - p;
      }
    }
    if (arc9(bright)) return sb + 1;
    if (arc9(dark)) return sd + 1;
    return 0;
  }
  function arc9(mask) {
    if (!mask) return false;
    const m = (mask | mask << 16) >>> 0;
    let acc = m;
    for (let s = 1; s < 9; s++) acc &= m >>> s;
    return acc !== 0;
  }
  var JsFastScorer = class {
    constructor() {
      __publicField(this, "backend", "js");
      __publicField(this, "map", new Uint16Array(0));
      __publicField(this, "image", null);
      __publicField(this, "offsets", new Int32Array(16));
    }
    begin(image) {
      if (this.map.length < image.width * image.height) this.map = new Uint16Array(image.width * image.height);
      this.image = image;
      this.offsets = Int32Array.from(CIRCLE.map(([dx, dy]) => dy * image.stride + dx));
      return this.map;
    }
    score(x0, y0, x1, y1, t, found) {
      const { width: w, stride, data: d } = this.image;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const s = fastScore(d, y * stride + x, this.offsets, t);
          if (s > 0) {
            this.map[y * w + x] = s;
            found.push(y * w + x);
          }
        }
    }
  };
  var WasmFastScorer = class {
    constructor(kernel) {
      __publicField(this, "backend", "wasm-simd");
      __publicField(this, "k");
      __publicField(this, "capacity", 0);
      __publicField(this, "img", 0);
      __publicField(this, "scores", 0);
      __publicField(this, "found", 0);
      __publicField(this, "map", new Uint16Array(0));
      __publicField(this, "image", null);
      this.k = kernel;
    }
    begin(image) {
      const bytes = image.stride * image.height;
      if (bytes > this.capacity) {
        const k = this.k;
        k.reset_heap();
        this.img = k.reserve(bytes + 16);
        this.scores = k.reserve(2 * bytes);
        this.found = k.reserve(4 * bytes);
        if (!this.img || !this.scores || !this.found) throw new Error("fast9: out of memory");
        this.capacity = bytes;
        new Uint16Array(k.memory.buffer, this.scores, bytes).fill(0);
      }
      new Uint8Array(this.k.memory.buffer, this.img, bytes).set(image.data.subarray(0, bytes));
      this.map = new Uint16Array(this.k.memory.buffer, this.scores, image.width * image.height);
      this.image = image;
      return this.map;
    }
    score(x0, y0, x1, y1, t, found) {
      const image = this.image;
      const n = this.k.fast9(this.img, image.stride, x0, y0, x1, y1, t, this.scores, image.width, this.found);
      const indices = new Uint32Array(this.k.memory.buffer, this.found, n);
      for (let i = 0; i < n; i++) found.push(indices[i]);
    }
  };
  function selfTest(kernel) {
    const width2 = 61;
    const height2 = 47;
    const data = new Uint8Array(width2 * height2);
    let s = 2654435769;
    for (let y = 0; y < height2; y++)
      for (let x = 0; x < width2; x++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const noise = (s >>> 0) % 64;
        data[y * width2 + x] = x < 20 ? 128 : x < 40 ? ((x >> 2) + (y >> 2)) % 2 ? 230 - noise : 20 + noise : noise * 4;
      }
    const image = { width: width2, height: height2, stride: width2, data };
    const reference = new JsFastScorer();
    for (const t of [4, 16, 40]) {
      const a = [];
      const b = [];
      const ma = reference.begin(image);
      const mb = kernel.begin(image);
      reference.score(3, 3, width2 - 18, height2 - 3, t, a);
      kernel.score(3, 3, width2 - 18, height2 - 3, t, b);
      if (a.length !== b.length || a.some((v, i) => v !== b[i] || ma[v] !== mb[v])) return false;
      for (const i of a) ma[i] = 0;
      for (const i of b) mb[i] = 0;
      if (t === 16 && a.length < 10) return false;
    }
    return true;
  }
  var shared = null;
  function fastScorer(allowWasm = true) {
    if (!shared) {
      const kernel = instantiateKernels();
      let wasm = null;
      try {
        wasm = kernel ? new WasmFastScorer(kernel) : null;
        if (wasm && !selfTest(wasm)) wasm = null;
      } catch {
        wasm = null;
      }
      shared = { wasm, js: new JsFastScorer() };
    }
    return allowWasm && shared.wasm || shared.js;
  }

  // packages/features/src/orb.ts
  var PATCH = 15;
  var BORDER = PATCH + 3;
  var ANGLE_BINS = 32;
  var GAUSSIAN_PATTERN = (() => {
    let s = 625341585;
    const uniform = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return (s + 0.5) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const out = new Int8Array(1024);
    for (let i = 0; i < 256; ) {
      const p = [0, 1, 2, 3].map(() => Math.round(gauss() * 8.5));
      if (Math.hypot(p[0], p[1]) > 15 || Math.hypot(p[2], p[3]) > 15 || Math.hypot(p[0] - p[2], p[1] - p[3]) < 2)
        continue;
      out.set(p, 4 * i);
      i++;
    }
    return out;
  })();
  var PATTERN_VERSION = 2;
  function steer(pattern) {
    return Array.from({ length: ANGLE_BINS }, (_, b) => {
      const a = 2 * Math.PI * b / ANGLE_BINS;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const out = new Int8Array(1024);
      for (let i = 0; i < 512; i++) {
        const x = pattern[2 * i];
        const y = pattern[2 * i + 1];
        out[2 * i] = Math.round(c * x - sn * y);
        out[2 * i + 1] = Math.round(sn * x + c * y);
      }
      return out;
    });
  }
  var STEERED = /* @__PURE__ */ new WeakMap();
  function steered(pattern) {
    let s = STEERED.get(pattern);
    if (!s) {
      let ok = pattern.length === 1024;
      for (let i = 0; i < 512 && ok; i++) ok = Math.hypot(pattern[2 * i], pattern[2 * i + 1]) <= 15;
      if (!ok) throw new Error("BRIEF pattern: 256 tests with box centres within 15 px");
      s = steer(pattern);
      STEERED.set(pattern, s);
    }
    return s;
  }
  var UMAX = (() => {
    const u = new Int32Array(PATCH + 1);
    for (let v = 0; v <= PATCH; v++) u[v] = Math.floor(Math.sqrt(PATCH * PATCH - v * v) + 0.5);
    return u;
  })();
  var OrbWorkspace = class {
    constructor() {
      __publicField(this, "octaves", new PyramidWorkspace());
      __publicField(this, "halfOctaves", new PyramidWorkspace());
      __publicField(this, "horizontal", new Uint16Array(0));
      __publicField(this, "blur", new Uint8Array(0));
      __publicField(this, "half", new Uint8Array(0));
      __publicField(this, "integral", new Int32Array(0));
    }
  };
  var WORKSPACE = new OrbWorkspace();
  function halfOctave(src, ws) {
    const sw = src.width;
    const sh = src.height;
    const w = Math.floor(sw / Math.SQRT2);
    const h = Math.floor(sh / Math.SQRT2);
    const d = src.data;
    if (ws.horizontal.length < sw * sh) {
      ws.horizontal = new Uint16Array(sw * sh);
      ws.blur = new Uint8Array(sw * sh);
    }
    if (ws.half.length !== w * h) ws.half = new Uint8Array(w * h);
    const horizontal = ws.horizontal;
    for (let y = 0; y < sh; y++) {
      const o = y * src.stride;
      const r = y * sw;
      horizontal[r] = 3 * d[o] + d[o + 1];
      for (let x = 1; x < sw - 1; x++) horizontal[r + x] = d[o + x - 1] + 2 * d[o + x] + d[o + x + 1];
      horizontal[r + sw - 1] = d[o + sw - 2] + 3 * d[o + sw - 1];
    }
    const blur = ws.blur;
    for (let y = 0; y < sh; y++) {
      const a = Math.max(0, y - 1) * sw;
      const b = y * sw;
      const c = Math.min(sh - 1, y + 1) * sw;
      for (let x = 0; x < sw; x++)
        blur[b + x] = horizontal[a + x] + 2 * horizontal[b + x] + horizontal[c + x] + 8 >> 4;
    }
    const xi = new Int32Array(w);
    const xf = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * Math.SQRT2 - 0.5;
      xi[x] = Math.min(sw - 2, Math.max(0, Math.floor(sx)));
      xf[x] = sx - xi[x];
    }
    const out = ws.half;
    for (let y = 0; y < h; y++) {
      const sy = (y + 0.5) * Math.SQRT2 - 0.5;
      const j = Math.min(sh - 2, Math.max(0, Math.floor(sy)));
      const fy = sy - j;
      const r0 = j * sw;
      const r1 = r0 + sw;
      for (let x = 0; x < w; x++) {
        const i = xi[x];
        const fx = xf[x];
        const top = blur[r0 + i] + fx * (blur[r0 + i + 1] - blur[r0 + i]);
        const bottom = blur[r1 + i] + fx * (blur[r1 + i + 1] - blur[r1 + i]);
        out[y * w + x] = top + fy * (bottom - top) + 0.5 | 0;
      }
    }
    return { width: w, height: h, stride: w, data: out };
  }
  function halfOctavePyramid(image, levels, ws = new OrbWorkspace()) {
    const octaves = Math.ceil(levels / 2);
    const a = ws.octaves.build(image, octaves, 24).levels;
    const b = ws.halfOctaves.build(halfOctave(image, ws), octaves, 24).levels;
    const out = [];
    for (let o = 0; o < octaves; o++) {
      if (a[o]) out.push({ image: a[o], scale: 2 ** o });
      if (b[o]) out.push({ image: b[o], scale: Math.SQRT2 * 2 ** o });
    }
    return out.slice(0, levels);
  }
  function harris(d, stride, x, y) {
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const o = (y + dy) * stride + x + dx;
        const gx = d[o + 1] - d[o - 1];
        const gy = d[o + stride] - d[o - stride];
        xx += gx * gx;
        yy += gy * gy;
        xy += gx * gy;
      }
    return xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
  }
  function integral(image, ws) {
    const w = image.width + 1;
    if (ws.integral.length < w * (image.height + 1)) ws.integral = new Int32Array(w * (image.height + 1));
    const out = ws.integral;
    out.fill(0, 0, w);
    for (let y = 0; y < image.height; y++) {
      out[(y + 1) * w] = 0;
      let row = 0;
      for (let x = 0; x < image.width; x++) {
        row += image.data[y * image.stride + x];
        out[(y + 1) * w + x + 1] = out[y * w + x + 1] + row;
      }
    }
    return out;
  }
  function levelCorners(image, quota, options, roi, fast) {
    const { width: w, height: h, stride, data: d } = image;
    const cell = options.cell;
    const picked = [];
    const x0 = Math.max(BORDER, Math.floor(roi.x0));
    const y0 = Math.max(BORDER, Math.floor(roi.y0));
    const x1 = Math.min(w - BORDER, Math.ceil(roi.x1));
    const y1 = Math.min(h - BORDER, Math.ceil(roi.y1));
    if (x1 <= x0 || y1 <= y0) return picked;
    const scoreMap = fast.begin(image);
    const found = [];
    for (let cy = y0; cy < y1; cy += cell)
      for (let cx = x0; cx < x1; cx += cell) {
        const ey = Math.min(y1, cy + cell);
        const ex = Math.min(x1, cx + cell);
        found.length = 0;
        let min = 255;
        let max = 0;
        for (let y = cy; y < ey; y += 2)
          for (let x = cx; x < ex; x += 2) {
            const v = d[y * stride + x];
            if (v < min) min = v;
            if (v > max) max = v;
          }
        if (max - min < 2 * options.minFastThreshold) continue;
        for (let t = options.fastThreshold; ; t = options.minFastThreshold) {
          fast.score(cx, cy, ex, ey, t, found);
          if (found.length >= 2 || t === options.minFastThreshold) break;
          for (const i of found) scoreMap[i] = 0;
          found.length = 0;
        }
        const peaks = [];
        for (const i of found) {
          const s0 = scoreMap[i];
          let peak = true;
          for (let dy = -1; dy <= 1 && peak; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const o = scoreMap[i + dy * w + dx];
              if (o > s0 || o === s0 && (dy < 0 || dy === 0 && dx < 0)) {
                peak = false;
                break;
              }
            }
          if (peak) peaks.push({ i, s: s0 });
        }
        for (const i of found) scoreMap[i] = 0;
        peaks.sort((a, b) => b.s - a.s || a.i - b.i);
        const ranked = [];
        for (const p of peaks.slice(0, 8)) {
          const x = p.i % w;
          const y = (p.i - x) / w;
          const score = harris(d, stride, x, y);
          if (score > 0) ranked.push({ x, y, score });
        }
        ranked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
        picked.push(...ranked.slice(0, 2));
      }
    picked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    return picked.slice(0, quota);
  }
  function orientation(image, x, y) {
    const d = image.data;
    const s = image.stride;
    let m01 = 0;
    let m10 = 0;
    const c = y * s + x;
    for (let u = -PATCH; u <= PATCH; u++) m10 += u * d[c + u];
    for (let v = 1; v <= PATCH; v++) {
      let sum = 0;
      const umax = UMAX[v];
      for (let u = -umax; u <= umax; u++) {
        const top = d[c - v * s + u];
        const bottom = d[c + v * s + u];
        sum += bottom - top;
        m10 += u * (top + bottom);
      }
      m01 += v * sum;
    }
    return Math.atan2(m01, m10);
  }
  function angleBin(angle) {
    return (Math.round(angle * ANGLE_BINS / (2 * Math.PI)) % ANGLE_BINS + ANGLE_BINS) % ANGLE_BINS;
  }
  function describe(ii, w, x, y, angle, pattern, out, at) {
    const p = pattern[angleBin(angle)];
    const base = (y - 2) * w + (x - 2);
    const w5 = 5 * w;
    for (let byte = 0; byte < 32; byte++) {
      let v = 0;
      for (let bit = 0; bit < 8; bit++) {
        const i = 4 * (8 * byte + bit);
        const a = base + p[i + 1] * w + p[i];
        const b = base + p[i + 3] * w + p[i + 2];
        const sa = ii[a + w5 + 5] - ii[a + 5] - ii[a + w5] + ii[a];
        const sb = ii[b + w5 + 5] - ii[b + 5] - ii[b + w5] + ii[b];
        if (sa < sb) v |= 1 << bit;
      }
      out[at + byte] = v;
    }
  }
  function extractOrb(image, options = {}) {
    const budget = options.budget ?? 700;
    const levels = halfOctavePyramid(image, options.levels ?? 6, WORKSPACE);
    const params = {
      fastThreshold: options.fastThreshold ?? 16,
      minFastThreshold: options.minFastThreshold ?? 4,
      cell: options.cell ?? 24
    };
    const fast = fastScorer(options.wasm !== false);
    const pattern = steered(options.pattern ?? GAUSSIAN_PATTERN);
    const area = levels.reduce((s, l) => s + l.image.width * l.image.height, 0);
    const roi = options.roi ?? { x: 0, y: 0, width: image.width, height: image.height };
    const xs = [];
    const ys = [];
    const lv = [];
    const angles = [];
    const scores = [];
    const descriptors = [];
    levels.forEach((level, index) => {
      const quota = Math.max(16, Math.round(budget * level.image.width * level.image.height / area));
      const s = level.scale;
      const corners = levelCorners(
        level.image,
        quota,
        params,
        { x0: roi.x / s, y0: roi.y / s, x1: (roi.x + roi.width) / s, y1: (roi.y + roi.height) / s },
        fast
      );
      if (!corners.length) return;
      const ii = integral(level.image, WORKSPACE);
      const desc = new Uint8Array(32 * corners.length);
      corners.forEach((c, k) => {
        const a = orientation(level.image, c.x, c.y);
        describe(ii, level.image.width + 1, c.x, c.y, a, pattern, desc, 32 * k);
        xs.push((c.x + 0.5) * s);
        ys.push((c.y + 0.5) * s);
        lv.push(index);
        angles.push(a);
        scores.push(c.score);
      });
      descriptors.push(desc);
    });
    const all = new Uint8Array(32 * xs.length);
    let o = 0;
    for (const d of descriptors) {
      all.set(d, o);
      o += d.length;
    }
    return {
      count: xs.length,
      x: Float32Array.from(xs),
      y: Float32Array.from(ys),
      level: Uint8Array.from(lv),
      angle: Float32Array.from(angles),
      score: Float32Array.from(scores),
      descriptors: all,
      descriptorBytes: 32
    };
  }

  // packages/features/src/compile.ts
  function tiltView(src, t, phiDeg) {
    const phi = phiDeg * Math.PI / 180;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const a = c * c / t + s * s;
    const b = c * s / t - c * s;
    const d = s * s / t + c * c;
    const corners = [
      [0, 0],
      [src.width, 0],
      [src.width, src.height],
      [0, src.height]
    ].map(([x, y]) => [a * x + b * y, b * x + d * y]);
    const minX = Math.min(...corners.map((p) => p[0]));
    const minY = Math.min(...corners.map((p) => p[1]));
    const w = Math.ceil(Math.max(...corners.map((p) => p[0])) - minX);
    const h = Math.ceil(Math.max(...corners.map((p) => p[1])) - minY);
    const A2 = [a, b, -minX, b, d, -minY];
    const sigma = 0.8 * Math.sqrt(Math.max(0, t * t - 1));
    const blurred = sigma > 0.3 ? gaussian(src, sigma) : src;
    const det = a * d - b * b;
    const ia = d / det;
    const ib = -b / det;
    const id = a / det;
    const data = new Uint8Array(w * h).fill(128);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const vx = x + 0.5 - A2[2];
        const vy = y + 0.5 - A2[5];
        const u = ia * vx + ib * vy - 0.5;
        const v = ib * vx + id * vy - 0.5;
        const i = Math.floor(u);
        const j = Math.floor(v);
        if (i < 0 || j < 0 || i + 1 >= src.width || j + 1 >= src.height) continue;
        const fx = u - i;
        const fy = v - j;
        const o = j * blurred.stride + i;
        const p = blurred.data;
        const top = p[o] + fx * (p[o + 1] - p[o]);
        const bottom = p[o + blurred.stride] + fx * (p[o + blurred.stride + 1] - p[o + blurred.stride]);
        data[y * w + x] = Math.round(top + fy * (bottom - top));
      }
    return { image: { width: w, height: h, stride: w, data }, A: A2 };
  }
  function gaussian(src, sigma) {
    const r = Math.ceil(3 * sigma);
    const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
    const sum = k.reduce((a, b) => a + b, 0);
    const kn = k.map((v) => v / sum);
    const tmp = new Float32Array(src.width * src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        let v = 0;
        for (let i = -r; i <= r; i++)
          v += kn[i + r] * src.data[y * src.stride + Math.min(src.width - 1, Math.max(0, x + i))];
        tmp[y * src.width + x] = v;
      }
    const out = new Uint8Array(src.width * src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        let v = 0;
        for (let i = -r; i <= r; i++)
          v += kn[i + r] * tmp[Math.min(src.height - 1, Math.max(0, y + i)) * src.width + x];
        out[y * src.width + x] = Math.round(v);
      }
    return { width: src.width, height: src.height, stride: src.width, data: out };
  }
  function hamming(a, ai, b, bi) {
    let d = 0;
    for (let k = 0; k < 32; k++) {
      let v = a[ai + k] ^ b[bi + k];
      while (v) {
        v &= v - 1;
        d++;
      }
    }
    return d;
  }
  function compileTarget(target, options = {}) {
    const tilts = options.tilts ?? [1.4, 2, 2.8];
    const longitudes = options.longitudes ?? [0, 45, 90, 135];
    const views = [{ image: target.image, A: [1, 0, 0, 0, 1, 0] }];
    for (const t of tilts) for (const phi of longitudes) views.push(tiltView(target.image, t, phi));
    for (const sigma of options.blurs ?? [2.5])
      views.push({ image: gaussian(target.image, sigma), A: [1, 0, 0, 0, 1, 0] });
    const groups = [];
    const grid = /* @__PURE__ */ new Map();
    const cell = 4;
    const key = (x, y) => Math.floor(y / cell) * 65536 + Math.floor(x / cell);
    views.forEach((view, vi) => {
      const k = extractOrb(view.image, { budget: 900, ...options.orb });
      const [a, b, tx, c, d, ty] = view.A;
      const det = a * d - b * c;
      for (let i = 0; i < k.count; i++) {
        const vx = k.x[i] - tx;
        const vy = k.y[i] - ty;
        const x = (d * vx - b * vy) / det;
        const y = (-c * vx + a * vy) / det;
        if (x < 0 || y < 0 || x >= target.info.width || y >= target.info.height) continue;
        const radius = 2 + 1.5 * (2 ** (k.level[i] / 2) - 1);
        let found = -1;
        for (let gy = -1; gy <= 1 && found < 0; gy++)
          for (let gx = -1; gx <= 1 && found < 0; gx++)
            for (const gi of grid.get(key(x + gx * cell, y + gy * cell)) ?? []) {
              const g = groups[gi];
              if (Math.hypot(g.x - x, g.y - y) <= radius) {
                found = gi;
                break;
              }
            }
        const desc = k.descriptors.slice(32 * i, 32 * i + 32);
        if (found < 0) {
          groups.push({ x, y, n: 1, views: /* @__PURE__ */ new Set([vi]), score: k.score[i], desc: [desc] });
          const kk = key(x, y);
          grid.set(kk, [...grid.get(kk) ?? [], groups.length - 1]);
        } else {
          const g = groups[found];
          g.views.add(vi);
          g.n++;
          g.score = Math.max(g.score, k.score[i]);
          g.desc.push(desc);
        }
      }
    });
    const maxPoints = options.maxPoints ?? 700;
    const perPoint = options.descriptorsPerPoint ?? 3;
    const kept = groups.map((g, i) => ({ g, i })).sort((p, q) => q.g.views.size - p.g.views.size || q.g.score - p.g.score || p.i - q.i).slice(0, maxPoints).map((p) => p.g);
    const points = new Float32Array(2 * kept.length);
    const repeatability = new Uint8Array(kept.length);
    const descs = [];
    const owner = [];
    kept.forEach((g, pi) => {
      points[2 * pi] = g.x;
      points[2 * pi + 1] = g.y;
      repeatability[pi] = g.views.size;
      const chosen = [];
      for (const d of g.desc) {
        if (chosen.length >= perPoint) break;
        if (chosen.every((c) => hamming(c, 0, d, 0) > 24)) chosen.push(d);
      }
      for (const d of chosen) {
        descs.push(d);
        owner.push(pi);
      }
    });
    const descriptors = new Uint8Array(32 * descs.length);
    descs.forEach((d, i) => descriptors.set(d, 32 * i));
    return { info: target.info, points, repeatability, descriptors, descriptorPoint: Uint32Array.from(owner) };
  }

  // packages/contracts/src/geometry.ts
  function project(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    if (Math.abs(w) < 1e-12) return [NaN, NaN];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }
  function cornersOf(h, widthPx, heightPx) {
    return [project(h, 0, 0), project(h, widthPx, 0), project(h, widthPx, heightPx), project(h, 0, heightPx)];
  }

  // packages/geometry/src/linalg.ts
  function solveInPlace(a, b, n) {
    for (let c = 0; c < n; c++) {
      let pivot = c;
      let best = Math.abs(a[c * n + c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(a[r * n + c]);
        if (v > best) {
          best = v;
          pivot = r;
        }
      }
      if (best < 1e-12) return false;
      if (pivot !== c) {
        for (let k = 0; k < n; k++) {
          const t2 = a[c * n + k];
          a[c * n + k] = a[pivot * n + k];
          a[pivot * n + k] = t2;
        }
        const t = b[c];
        b[c] = b[pivot];
        b[pivot] = t;
      }
      const d = a[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = a[r * n + c] / d;
        if (f === 0) continue;
        for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k];
        b[r] -= f * b[c];
      }
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= a[r * n + k] * b[k];
      b[r] = s / a[r * n + r];
    }
    return b.every(Number.isFinite);
  }
  function invertSymmetric(a, n) {
    const m = new Float64Array(a);
    const inv = new Float64Array(n * n);
    for (let i = 0; i < n; i++) inv[i * n + i] = 1;
    for (let c = 0; c < n; c++) {
      let pivot = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[pivot * n + c])) pivot = r;
      if (Math.abs(m[pivot * n + c]) < 1e-15) return null;
      if (pivot !== c)
        for (let k = 0; k < n; k++) {
          let t = m[c * n + k];
          m[c * n + k] = m[pivot * n + k];
          m[pivot * n + k] = t;
          t = inv[c * n + k];
          inv[c * n + k] = inv[pivot * n + k];
          inv[pivot * n + k] = t;
        }
      const d = m[c * n + c];
      for (let k = 0; k < n; k++) {
        m[c * n + k] /= d;
        inv[c * n + k] /= d;
      }
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = m[r * n + c];
        if (f === 0) continue;
        for (let k = 0; k < n; k++) {
          m[r * n + k] -= f * m[c * n + k];
          inv[r * n + k] -= f * inv[c * n + k];
        }
      }
    }
    return inv;
  }
  function smallestEigenvector(sym, n) {
    const a = new Float64Array(sym);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
      if (off < 1e-24) break;
      for (let p = 0; p < n; p++)
        for (let q = p + 1; q < n; q++) {
          const apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k * n + p];
            const akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p * n + k];
            const aqk = a[q * n + k];
            a[p * n + k] = c * apk - s * aqk;
            a[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k * n + p];
            const vkq = v[k * n + q];
            v[k * n + p] = c * vkp - s * vkq;
            v[k * n + q] = s * vkp + c * vkq;
          }
        }
    }
    let min = 0;
    for (let i = 1; i < n; i++) if (a[i * n + i] < a[min * n + min]) min = i;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = v[k * n + min];
    return out;
  }

  // packages/geometry/src/homography.ts
  function multiply3(a, b) {
    const out = new Float64Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return out;
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
    const cof = [
      e * i - f * h,
      c * h - b * i,
      b * f - c * e,
      f * g - d * i,
      a * i - c * g,
      c * d - a * f,
      d * h - e * g,
      b * g - a * h,
      a * e - b * d
    ];
    const det = a * cof[0] + b * cof[3] + c * cof[6];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
    return Float64Array.from(cof, (v) => v / det);
  }
  function normalizeH(h) {
    const k = h[8];
    if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return null;
    for (let i = 0; i < 9; i++) h[i] /= k;
    return h.every(Number.isFinite) ? h : null;
  }
  function normalization(xy, indices, count) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      cx += xy[2 * i];
      cy += xy[2 * i + 1];
    }
    cx /= count;
    cy /= count;
    let r = 0;
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      r += Math.hypot(xy[2 * i] - cx, xy[2 * i + 1] - cy);
    }
    r /= count;
    if (r < 1e-9) return null;
    return [Math.SQRT2 / r, cx, cy];
  }
  function denormalize(hn, ta, ib) {
    const [sa, ax, ay] = ta;
    const [sb, bx, by] = ib;
    const Ta = [sa, 0, -sa * ax, 0, sa, -sa * ay, 0, 0, 1];
    const TbInv = [1 / sb, 0, bx, 0, 1 / sb, by, 0, 0, 1];
    return normalizeH(multiply3(multiply3(TbInv, hn), Ta));
  }
  function fitHomography(target, image, indices, count, weights) {
    if (count < 4) return null;
    const ta = normalization(target, indices, count);
    const ib = normalization(image, indices, count);
    if (!ta || !ib) return null;
    const ata = new Float64Array(81);
    const row = new Float64Array(9);
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      const w = weights ? weights[i] : 1;
      if (w <= 0) continue;
      const x = ta[0] * (target[2 * i] - ta[1]);
      const y = ta[0] * (target[2 * i + 1] - ta[2]);
      const u = ib[0] * (image[2 * i] - ib[1]);
      const v = ib[0] * (image[2 * i + 1] - ib[2]);
      for (let r = 0; r < 2; r++) {
        if (r === 0) row.set([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
        else row.set([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
        for (let p = 0; p < 9; p++) {
          const rp = row[p] * w;
          if (rp === 0) continue;
          for (let q = p; q < 9; q++) ata[p * 9 + q] += rp * row[q];
        }
      }
    }
    for (let p = 0; p < 9; p++) for (let q = 0; q < p; q++) ata[p * 9 + q] = ata[q * 9 + p];
    return denormalize(smallestEigenvector(ata, 9), ta, ib);
  }
  var scratchA = new Float64Array(64);
  var scratchB = new Float64Array(8);
  function solve4(target, image, idx) {
    const ta = normalization(target, idx, 4);
    const ib = normalization(image, idx, 4);
    if (!ta || !ib) return null;
    scratchA.fill(0);
    for (let k = 0; k < 4; k++) {
      const i = idx[k];
      const x = ta[0] * (target[2 * i] - ta[1]);
      const y = ta[0] * (target[2 * i + 1] - ta[2]);
      const u = ib[0] * (image[2 * i] - ib[1]);
      const v = ib[0] * (image[2 * i + 1] - ib[2]);
      scratchA.set([x, y, 1, 0, 0, 0, -u * x, -u * y], 16 * k);
      scratchA.set([0, 0, 0, x, y, 1, -v * x, -v * y], 16 * k + 8);
      scratchB[2 * k] = u;
      scratchB[2 * k + 1] = v;
    }
    if (!solveInPlace(scratchA, scratchB, 8)) return null;
    return denormalize([...scratchB, 1], ta, ib);
  }
  function projectInto(h, x, y, out) {
    const w = h[6] * x + h[7] * y + h[8];
    if (!(w > 1e-12)) return false;
    out[0] = (h[0] * x + h[1] * y + h[2]) / w;
    out[1] = (h[3] * x + h[4] * y + h[5]) / w;
    return true;
  }
  var cornerScratch = new Float64Array(8);
  var p2 = new Float64Array(2);
  function isPlausible(h, width2, height2, minAreaPx = 64, maxEdgeRatio = 30) {
    const xs = [0, width2, width2, 0];
    const ys = [0, 0, height2, height2];
    for (let k = 0; k < 4; k++) {
      if (!projectInto(h, xs[k], ys[k], p2)) return false;
      cornerScratch[2 * k] = p2[0];
      cornerScratch[2 * k + 1] = p2[1];
    }
    let area = 0;
    let minEdge = Infinity;
    let maxEdge = 0;
    for (let k = 0; k < 4; k++) {
      const ax = cornerScratch[2 * k];
      const ay = cornerScratch[2 * k + 1];
      const bx = cornerScratch[(2 * k + 2) % 8];
      const by = cornerScratch[(2 * k + 3) % 8];
      const cx = cornerScratch[(2 * k + 4) % 8];
      const cy = cornerScratch[(2 * k + 5) % 8];
      if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return false;
      area += ax * by - bx * ay;
      const edge = Math.hypot(bx - ax, by - ay);
      minEdge = Math.min(minEdge, edge);
      maxEdge = Math.max(maxEdge, edge);
    }
    return area / 2 >= minAreaPx && maxEdge <= maxEdgeRatio * Math.max(minEdge, 1e-9);
  }
  function hullArea(xy, mask, count) {
    const pts = [];
    for (let i = 0; i < count; i++) if (!mask || mask[i]) pts.push([xy[2 * i], xy[2 * i + 1]]);
    if (pts.length < 3) return 0;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area) / 2;
  }

  // packages/geometry/src/refine.ts
  var huber = (r, k) => r <= k ? 1 : k / r;
  function refineHomography(h, target, image, mask, count, options = {}) {
    const iterations = options.iterations ?? 8;
    const k = options.huberPx ?? 1.5;
    let p = Float64Array.from(h.subarray(0, 8));
    let lambda = 1e-3;
    const jtj = new Float64Array(64);
    const jtr = new Float64Array(8);
    const jx = new Float64Array(8);
    const jy = new Float64Array(8);
    const cost = (params) => {
      let c = 0;
      for (let i = 0; i < count; i++) {
        if (!mask[i]) continue;
        const x = target[2 * i];
        const y = target[2 * i + 1];
        const w = params[6] * x + params[7] * y + 1;
        if (!(w > 1e-12)) return Infinity;
        const ex = (params[0] * x + params[1] * y + params[2]) / w - image[2 * i];
        const ey = (params[3] * x + params[4] * y + params[5]) / w - image[2 * i + 1];
        const r = Math.hypot(ex, ey);
        c += r <= k ? r * r : 2 * k * r - k * k;
      }
      return c;
    };
    let current = cost(p);
    for (let it = 0; it < iterations; it++) {
      jtj.fill(0);
      jtr.fill(0);
      for (let i = 0; i < count; i++) {
        if (!mask[i]) continue;
        const x = target[2 * i];
        const y = target[2 * i + 1];
        const w = p[6] * x + p[7] * y + 1;
        const u = (p[0] * x + p[1] * y + p[2]) / w;
        const v = (p[3] * x + p[4] * y + p[5]) / w;
        const ex = u - image[2 * i];
        const ey = v - image[2 * i + 1];
        const wt = huber(Math.hypot(ex, ey), k);
        jx.set([x / w, y / w, 1 / w, 0, 0, 0, -u * x / w, -u * y / w]);
        jy.set([0, 0, 0, x / w, y / w, 1 / w, -v * x / w, -v * y / w]);
        for (let a = 0; a < 8; a++) {
          jtr[a] += wt * (jx[a] * ex + jy[a] * ey);
          for (let b = a; b < 8; b++) jtj[a * 8 + b] += wt * (jx[a] * jx[b] + jy[a] * jy[b]);
        }
      }
      for (let a = 0; a < 8; a++) for (let b = 0; b < a; b++) jtj[a * 8 + b] = jtj[b * 8 + a];
      let improved = false;
      for (let attempt = 0; attempt < 4 && !improved; attempt++) {
        const a = new Float64Array(jtj);
        for (let d = 0; d < 8; d++) a[d * 9] *= 1 + lambda;
        const step = Float64Array.from(jtr, (v) => -v);
        if (!solveInPlace(a, step, 8)) {
          lambda *= 10;
          continue;
        }
        const next = Float64Array.from(p, (v, i) => v + step[i]);
        const c = cost(next);
        if (c < current) {
          p = next;
          current = c;
          lambda = Math.max(1e-7, lambda / 10);
          improved = true;
        } else lambda *= 10;
      }
      if (!improved) break;
    }
    let n = 0;
    let sum = 0;
    jtj.fill(0);
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      const x = target[2 * i];
      const y = target[2 * i + 1];
      const w = p[6] * x + p[7] * y + 1;
      const u = (p[0] * x + p[1] * y + p[2]) / w;
      const v = (p[3] * x + p[4] * y + p[5]) / w;
      sum += (u - image[2 * i]) ** 2 + (v - image[2 * i + 1]) ** 2;
      n++;
      jx.set([x / w, y / w, 1 / w, 0, 0, 0, -u * x / w, -u * y / w]);
      jy.set([0, 0, 0, x / w, y / w, 1 / w, -v * x / w, -v * y / w]);
      for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) jtj[a * 8 + b] += jx[a] * jx[b] + jy[a] * jy[b];
    }
    const sigma2 = n > 4 ? sum / (2 * n - 8) : sum;
    const inv = invertSymmetric(jtj, 8);
    return {
      H: Float64Array.from([...p, 1]),
      rmsPx: n ? Math.sqrt(sum / n) : Infinity,
      paramCovariance: inv ? inv.map((v) => v * sigma2) : null
    };
  }

  // packages/geometry/src/robust.ts
  function xorshift(seed) {
    let s = seed >>> 0 || 625341585;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
  }
  function evaluate(h, target, image, count, thr2, mask) {
    let score = 0;
    let inliers = 0;
    for (let i = 0; i < count; i++) {
      const x = target[2 * i];
      const y = target[2 * i + 1];
      const w = h[6] * x + h[7] * y + h[8];
      let r2 = thr2;
      if (w > 1e-12) {
        const dx = (h[0] * x + h[1] * y + h[2]) / w - image[2 * i];
        const dy = (h[3] * x + h[4] * y + h[5]) / w - image[2 * i + 1];
        r2 = Math.min(thr2, dx * dx + dy * dy);
      }
      const isIn = r2 < thr2;
      mask[i] = isIn ? 1 : 0;
      if (isIn) inliers++;
      score += r2;
    }
    return { score, inliers };
  }
  function indicesOf(mask, count) {
    let n = 0;
    for (let i = 0; i < count; i++) if (mask[i]) n++;
    const out = new Int32Array(n);
    for (let i = 0, k = 0; i < count; i++) if (mask[i]) out[k++] = i;
    return out;
  }
  function collinear(xy, a, b, c) {
    const area = (xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * b + 1] - xy[2 * a + 1]) * (xy[2 * c] - xy[2 * a]);
    return Math.abs(area) < 1e-3 * (1 + Math.abs(xy[2 * a]) + Math.abs(xy[2 * b]));
  }
  function estimateHomography(target, image, count, width2, height2, options = {}) {
    const thr = options.thresholdPx ?? 3;
    const thr2 = thr * thr;
    const confidence = options.confidence ?? 0.995;
    const maxIterations = options.maxIterations ?? 500;
    const minInliers = options.minInliers ?? 12;
    const minRatio = options.minInlierRatio ?? 0.2;
    const minCoverage = options.minCoverage ?? 0.08;
    if (count < Math.max(4, minInliers)) return { accepted: false, reason: "INSUFFICIENT_MATCHES", iterations: 0 };
    const random = xorshift(options.seed ?? 12345);
    const mask = new Uint8Array(count);
    const bestMask = new Uint8Array(count);
    let best = null;
    let bestScore = Infinity;
    let bestInliers = 0;
    let limit = maxIterations;
    let n = 4;
    let tn = maxIterations;
    for (let i = 0; i < 4; i++) tn *= (n - i) / (count - i);
    let tnPrime = 1;
    const sample2 = new Int32Array(4);
    let t = 0;
    const consider = (h) => {
      if (!h || !isPlausible(h, width2, height2)) return;
      const { score, inliers } = evaluate(h, target, image, count, thr2, mask);
      if (score >= bestScore) return;
      best = h;
      bestScore = score;
      bestInliers = inliers;
      bestMask.set(mask);
      for (let lo = 0; lo < 3 && bestInliers >= 8; lo++) {
        const refit = fitHomography(target, image, indicesOf(bestMask, count), bestInliers);
        if (!refit || !isPlausible(refit, width2, height2)) break;
        const e = evaluate(refit, target, image, count, thr2, mask);
        if (e.score >= bestScore) break;
        best = refit;
        bestScore = e.score;
        bestInliers = e.inliers;
        bestMask.set(mask);
      }
      const w = bestInliers / count;
      const k = Math.log(1 - confidence) / Math.log(Math.max(1e-12, 1 - w ** 4));
      limit = Math.min(maxIterations, Math.max(16, Math.ceil(k)));
    };
    while (t < limit) {
      t++;
      if (t >= tnPrime && n < count) {
        const next = tn * (n + 1) / (n + 1 - 4);
        n++;
        tnPrime += Math.ceil(next - tn);
        tn = next;
      }
      const pool = tnPrime > t ? n - 1 : n;
      let k = 0;
      if (tnPrime > t) sample2[k++] = n - 1;
      let guard = 0;
      while (k < 4 && guard++ < 64) {
        const c2 = random() % pool;
        let dup = false;
        for (let j = 0; j < k; j++) if (sample2[j] === c2) dup = true;
        if (!dup) sample2[k++] = c2;
      }
      if (k < 4) continue;
      const [a, b, c, d] = [sample2[0], sample2[1], sample2[2], sample2[3]];
      if (collinear(target, a, b, c) || collinear(target, a, b, d) || collinear(target, a, c, d) || collinear(target, b, c, d))
        continue;
      consider(solve4(target, image, sample2));
    }
    if (!best || bestInliers < minInliers) return { accepted: false, reason: "NO_MODEL", iterations: t };
    let H = best;
    let refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
    for (let pass = 0; pass < 2; pass++) {
      if (!isPlausible(refined.H, width2, height2)) return { accepted: false, reason: "IMPLAUSIBLE_MODEL", iterations: t };
      H = refined.H;
      const e = evaluate(H, target, image, count, thr2, bestMask);
      bestInliers = e.inliers;
      if (pass === 0) refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
    }
    const ratio = bestInliers / count;
    if (bestInliers < minInliers || ratio < minRatio)
      return { accepted: false, reason: "LOW_INLIER_SUPPORT", iterations: t };
    const coverage = hullArea(target, bestMask, count) / (width2 * height2);
    if (coverage < minCoverage) return { accepted: false, reason: "LOW_SPATIAL_COVERAGE", iterations: t };
    return {
      accepted: true,
      H,
      mask: bestMask,
      inliers: bestInliers,
      ratio,
      rmsPx: refined.rmsPx,
      coverage,
      paramCovariance: refined.paramCovariance,
      iterations: t
    };
  }

  // packages/features/src/format.ts
  var MAGIC = 844385612;
  function resample(src, width2, height2) {
    if (src.width === width2 && src.height === height2) return src;
    const out = new Uint8Array(width2 * height2);
    const sx = src.width / width2;
    const sy = src.height / height2;
    for (let y = 0; y < height2; y++) {
      const v = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
      const j = Math.floor(v);
      const fy = v - j;
      for (let x = 0; x < width2; x++) {
        const u = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
        const i = Math.floor(u);
        const fx = u - i;
        const o = j * src.stride + i;
        const d = src.data;
        const top = d[o] + fx * (d[o + 1] - d[o]);
        const bottom = d[o + src.stride] + fx * (d[o + src.stride + 1] - d[o + src.stride]);
        out[y * width2 + x] = Math.round(top + fy * (bottom - top));
      }
    }
    return { width: width2, height: height2, stride: width2, data: out };
  }
  function shrink(src, maxEdge) {
    const k = Math.max(src.width, src.height) / maxEdge;
    if (k <= 1) return src;
    const w = Math.round(src.width / k);
    const h = Math.round(src.height / k);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * k);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
        const y0 = Math.floor(y * k);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src.data[yy * src.stride + xx];
        out[y * w + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
      }
    return { width: w, height: h, stride: w, data: out };
  }
  async function encodeTarget(compiled2, template, options = {}) {
    const t = shrink(template, options.templateMaxEdge ?? 480);
    const id = new TextEncoder().encode(compiled2.info.id);
    const n = compiled2.points.length / 2;
    const d = compiled2.descriptorPoint.length;
    const size = 8 + 2 + id.length + 8 + 8 + 8 * n + n + 4 * d + 32 * d + 4 + t.width * t.height;
    const bytes = new Uint8Array(size + 32);
    const view = new DataView(bytes.buffer);
    let o = 0;
    view.setUint32(o, MAGIC, true);
    view.setUint16(o + 4, 2, true);
    view.setUint16(o + 6, PATTERN_VERSION, true);
    o += 8;
    view.setUint16(o, id.length, true);
    bytes.set(id, o + 2);
    o += 2 + id.length;
    view.setUint16(o, compiled2.info.width, true);
    view.setUint16(o + 2, compiled2.info.height, true);
    view.setFloat32(o + 4, compiled2.info.physicalWidthMeters ?? NaN, true);
    o += 8;
    view.setUint32(o, n, true);
    view.setUint32(o + 4, d, true);
    o += 8;
    for (let i = 0; i < 2 * n; i++, o += 4) view.setFloat32(o, compiled2.points[i], true);
    bytes.set(compiled2.repeatability, o);
    o += n;
    for (let i = 0; i < d; i++, o += 4) view.setUint32(o, compiled2.descriptorPoint[i], true);
    bytes.set(compiled2.descriptors, o);
    o += 32 * d;
    view.setUint16(o, t.width, true);
    view.setUint16(o + 2, t.height, true);
    o += 4;
    for (let y = 0; y < t.height; y++) bytes.set(t.data.subarray(y * t.stride, y * t.stride + t.width), o + y * t.width);
    o += t.width * t.height;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, o)));
    bytes.set(digest, o);
    return bytes;
  }
  async function decodeTarget(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = (why) => {
      throw new Error(`Invalid target asset: ${why}`);
    };
    if (bytes.length < 64 || view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 2) fail("header");
    const pattern = view.getUint16(6, true) & 255;
    if (pattern !== PATTERN_VERSION)
      fail(`descriptor pattern v${pattern}, this engine uses v${PATTERN_VERSION}; recompile the target`);
    const body = bytes.subarray(0, bytes.length - 32);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
    if (!digest.every((v, i) => v === bytes[bytes.length - 32 + i])) fail("checksum");
    let o = 8;
    const idLength = view.getUint16(o, true);
    const id = new TextDecoder().decode(bytes.subarray(o + 2, o + 2 + idLength));
    o += 2 + idLength;
    const width2 = view.getUint16(o, true);
    const height2 = view.getUint16(o + 2, true);
    const physical = view.getFloat32(o + 4, true);
    o += 8;
    const n = view.getUint32(o, true);
    const d = view.getUint32(o + 4, true);
    o += 8;
    const points = new Float32Array(2 * n);
    for (let i = 0; i < 2 * n; i++, o += 4) points[i] = view.getFloat32(o, true);
    const repeatability = bytes.slice(o, o + n);
    o += n;
    const descriptorPoint = new Uint32Array(d);
    for (let i = 0; i < d; i++, o += 4) descriptorPoint[i] = view.getUint32(o, true);
    const descriptors = bytes.slice(o, o + 32 * d);
    o += 32 * d;
    const tw = view.getUint16(o, true);
    const th = view.getUint16(o + 2, true);
    o += 4;
    const stored = { width: tw, height: th, stride: tw, data: bytes.slice(o, o + tw * th) };
    return {
      compiled: {
        info: { id, width: width2, height: height2, physicalWidthMeters: Number.isNaN(physical) ? null : physical },
        points,
        repeatability,
        descriptors,
        descriptorPoint
      },
      template: resample(stored, width2, height2)
    };
  }

  // packages/features/src/hamming.ts
  function nearest2Reference(queries, refs) {
    const m = queries.length / 32;
    const n = refs.length / 32;
    const out = new Uint32Array(3 * m);
    const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
    const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
    for (let q = 0; q < m; q++) {
      let best = 257;
      let second = 257;
      let index = 4294967295;
      const a = 8 * q;
      for (let r = 0; r < n; r++) {
        const b = 8 * r;
        let d = 0;
        for (let k = 0; k < 8; k++) {
          let v = (q32[a + k] ^ r32[b + k]) >>> 0;
          v -= v >>> 1 & 1431655765;
          v = (v & 858993459) + (v >>> 2 & 858993459);
          d += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
        }
        if (d < best) {
          second = best;
          best = d;
          index = r;
        } else if (d < second) second = d;
      }
      out[3 * q] = index;
      out[3 * q + 1] = best;
      out[3 * q + 2] = second;
    }
    return out;
  }
  function nearest2GroupedReference(queries, refs, groups) {
    const m = queries.length / 32;
    const n = refs.length / 32;
    const out = new Uint32Array(3 * m);
    const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
    const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
    for (let q = 0; q < m; q++) {
      let best = 257;
      let bestGroup = 4294967295;
      let second = 257;
      let index = 4294967295;
      const a = 8 * q;
      for (let r = 0; r < n; r++) {
        const b = 8 * r;
        let d = 0;
        for (let k = 0; k < 8; k++) {
          let v = (q32[a + k] ^ r32[b + k]) >>> 0;
          v -= v >>> 1 & 1431655765;
          v = (v & 858993459) + (v >>> 2 & 858993459);
          d += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
        }
        const g = groups[r];
        if (g === bestGroup) {
          if (d < best) {
            best = d;
            index = r;
          }
        } else if (d < best) {
          second = best;
          best = d;
          bestGroup = g;
          index = r;
        } else if (d < second) second = d;
      }
      out[3 * q] = index;
      out[3 * q + 1] = best;
      out[3 * q + 2] = second;
    }
    return out;
  }
  var HammingMatcher = class _HammingMatcher {
    constructor(kernel) {
      __publicField(this, "backend");
      __publicField(this, "kernel");
      this.kernel = kernel;
      this.backend = kernel ? "wasm-simd" : "js";
    }
    /** Synchronous instantiation (the module is ~1 KB); `allowWasm: false` forces the reference. */
    static create(options = {}) {
      const kernel = options.allowWasm === false ? null : instantiateKernels();
      if (!kernel) return new _HammingMatcher(null);
      try {
        const matcher = new _HammingMatcher(kernel);
        return matcher.selfTest() ? matcher : new _HammingMatcher(null);
      } catch {
        return new _HammingMatcher(null);
      }
    }
    selfTest() {
      let s = 19088743;
      const random = (n) => Uint8Array.from({ length: n }, () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s & 255;
      });
      const refs = random(32 * 37);
      const queries = new Uint8Array(32 * 11);
      queries.set(random(32 * 10));
      queries.set(refs.subarray(32 * 5, 32 * 6), 32 * 10);
      const want = nearest2Reference(queries, refs);
      const got = this.nearest2(queries, refs);
      const groups = Uint32Array.from({ length: 37 }, (_, i) => i >> 1);
      const wantG = nearest2GroupedReference(queries, refs, groups);
      const gotG = this.nearest2Grouped(queries, refs, groups);
      return got.length === want.length && got.every((v, i) => v === want[i]) && gotG.length === wantG.length && gotG.every((v, i) => v === wantG[i]);
    }
    nearest2(queries, refs) {
      const k = this.kernel;
      if (!k) return nearest2Reference(queries, refs);
      const m = queries.length / 32;
      const n = refs.length / 32;
      k.reset_heap();
      const q = k.reserve(queries.length);
      const r = k.reserve(refs.length);
      const o = k.reserve(12 * m);
      if (!q || !r || !o) return nearest2Reference(queries, refs);
      new Uint8Array(k.memory.buffer).set(queries, q);
      new Uint8Array(k.memory.buffer).set(refs, r);
      k.nearest2(q, m, r, n, o);
      return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
    }
    nearest2Grouped(queries, refs, groups) {
      const k = this.kernel;
      if (!k) return nearest2GroupedReference(queries, refs, groups);
      const m = queries.length / 32;
      k.reset_heap();
      const q = k.reserve(queries.length);
      const r = k.reserve(refs.length);
      const g = k.reserve(groups.byteLength);
      const o = k.reserve(12 * m);
      if (!q || !r || !g || !o) return nearest2GroupedReference(queries, refs, groups);
      const mem = k.memory.buffer;
      new Uint8Array(mem).set(queries, q);
      new Uint8Array(mem).set(refs, r);
      new Uint8Array(mem).set(new Uint8Array(groups.buffer, groups.byteOffset, groups.byteLength), g);
      k.nearest2_grouped(q, m, r, g, refs.length / 32, o);
      return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
    }
  };

  // packages/features/src/detector.ts
  var wholeFrameBudget = (image) => Math.max(700, Math.round(700 * image.width * image.height / (640 * 360)));
  var MAX_ENLARGED_PX = 36e4;
  function enlargedFeatures(image, roi, scale, options) {
    const s = Math.min(scale, 3, Math.sqrt(MAX_ENLARGED_PX / (roi.width * roi.height)));
    if (s < 1.2) return null;
    const width2 = Math.round(roi.width * s);
    const height2 = Math.round(roi.height * s);
    const data = new Uint8Array(width2 * height2);
    const xMax = image.width - 1.001;
    const yMax = image.height - 1.001;
    for (let y = 0; y < height2; y++) {
      const sy = Math.min(yMax, Math.max(0.5, roi.y + (y + 0.5) / s));
      for (let x = 0; x < width2; x++)
        data[y * width2 + x] = Math.round(sample(image, Math.min(xMax, Math.max(0.5, roi.x + (x + 0.5) / s)), sy));
    }
    const k = extractOrb({ width: width2, height: height2, stride: width2, data }, { budget: 500, ...options });
    return {
      ...k,
      x: k.x.map((v) => roi.x + (v + 0.5) / s - 0.5),
      y: k.y.map((v) => roi.y + (v + 0.5) / s - 0.5)
    };
  }
  var OrbDetector = class {
    constructor(options = {}) {
      __publicField(this, "info", {
        id: "C1.orb-views",
        layer: "L2",
        route: "light",
        determinism: "bit-exact",
        requires: []
      });
      __publicField(this, "options");
      __publicField(this, "matcher");
      __publicField(this, "targets", []);
      this.options = options;
      this.matcher = HammingMatcher.create(options.allowWasm === false ? { allowWasm: false } : {});
    }
    get backend() {
      return this.matcher.backend;
    }
    probe(_capabilities) {
      return { isAvailable: true };
    }
    async load(targets) {
      const report = [];
      this.targets = [];
      for (const t of targets) {
        const started = performance.now();
        const compiled2 = compileTarget(t, this.options.compile);
        const serialized = await encodeTarget(compiled2, t.image, {
          templateMaxEdge: this.options.templateMaxEdge ?? 480
        });
        const asset = await decodeTarget(serialized);
        this.targets.push(asset.compiled);
        report.push({
          id: t.info.id,
          compileUs: (performance.now() - started) * 1e3,
          serialized,
          template: asset.template
        });
      }
      return { targets: report };
    }
    async loadEncoded(assets) {
      const report = [];
      this.targets = [];
      for (const bytes of assets) {
        const started = performance.now();
        const asset = await decodeTarget(bytes);
        this.targets.push(asset.compiled);
        report.push({
          id: asset.compiled.info.id,
          compileUs: (performance.now() - started) * 1e3,
          serialized: bytes,
          template: asset.template,
          info: asset.compiled.info
        });
      }
      return { targets: report };
    }
    async detect(frame, options = {}) {
      if (frame.image.kind !== "cpu-gray") throw new Error("OrbDetector needs cpu-gray frames");
      const roi = options.roi ?? null;
      const k = (roi && (options.upscale ?? 1) > 1 ? enlargedFeatures(frame.image.image, roi, options.upscale, this.options.orb ?? {}) : null) ?? extractOrb(frame.image.image, {
        budget: roi ? 500 : wholeFrameBudget(frame.image.image),
        ...this.options.orb,
        roi
      });
      if (k.count < 8) return [];
      const ratio = this.options.ratio ?? 0.85;
      const maxDistance = this.options.maxDistance ?? 80;
      const found = [];
      for (const t of this.targets) {
        const nn = this.matcher.nearest2Grouped(k.descriptors, t.descriptors, t.descriptorPoint);
        const byPoint = /* @__PURE__ */ new Map();
        for (let q = 0; q < k.count; q++) {
          const best = nn[3 * q + 1];
          const second = nn[3 * q + 2];
          if (best > maxDistance || ratio < 1 && best >= ratio * second) continue;
          const point = t.descriptorPoint[nn[3 * q]];
          const r = best / Math.max(1, second);
          const prev = byPoint.get(point);
          if (!prev || r < prev.r) byPoint.set(point, { q, r });
        }
        const matches = [...byPoint].sort((a, b) => a[1].r - b[1].r || a[0] - b[0]);
        if (matches.length < 12) continue;
        const tp = new Float64Array(2 * matches.length);
        const ip = new Float64Array(2 * matches.length);
        matches.forEach(([point, { q }], i) => {
          tp[2 * i] = t.points[2 * point];
          tp[2 * i + 1] = t.points[2 * point + 1];
          ip[2 * i] = k.x[q];
          ip[2 * i + 1] = k.y[q];
        });
        const result = estimateHomography(tp, ip, matches.length, t.info.width, t.info.height, {
          thresholdPx: this.options.thresholdPx ?? 4,
          maxIterations: 1e3,
          minInliers: 12,
          minInlierRatio: 0.1,
          minCoverage: 0.05
        });
        if (!result.accepted) continue;
        found.push({
          inliers: result.inliers,
          pose: {
            targetId: t.info.id,
            frameId: frame.frameId,
            timeUs: frame.time.captureUs,
            H_imageFromTarget: result.H,
            corners: cornersOf(result.H, t.info.width, t.info.height),
            covariance: null,
            quality: {
              support: result.inliers,
              ratio: result.ratio,
              residual: result.rmsPx,
              residualKind: "px",
              coverage: result.coverage
            },
            origin: "detector"
          }
        });
      }
      found.sort((a, b) => b.inliers - a.inliers || a.pose.targetId.localeCompare(b.pose.targetId));
      if (found.length > 1 && found[1].inliers >= 0.85 * found[0].inliers) return [];
      return found.map((f) => f.pose);
    }
  };

  // packages/filters/src/corners.ts
  function homographyFromCorners(info, corners) {
    const target = Float64Array.from([0, 0, info.width, 0, info.width, info.height, 0, info.height]);
    return solve4(target, Float64Array.from(corners), [0, 1, 2, 3]);
  }
  function flatCorners(c) {
    return Float64Array.from([c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
  }
  function cornersFromFlat(v) {
    return [
      [v[0], v[1]],
      [v[2], v[3]],
      [v[4], v[5]],
      [v[6], v[7]]
    ];
  }
  function withCorners(base, info, corners, timeUs, origin) {
    const H = homographyFromCorners(info, corners);
    if (!H) return null;
    return { ...base, H_imageFromTarget: H, corners: cornersFromFlat(corners), timeUs, origin };
  }

  // packages/filters/src/kalman.ts
  var KalmanPoseFilter = class {
    constructor(targets, options = {}) {
      __publicField(this, "info", {
        id: "E2.kalman-cv",
        layer: "L4",
        route: "light",
        determinism: "bit-exact",
        requires: []
      });
      __publicField(this, "targets", /* @__PURE__ */ new Map());
      __publicField(this, "states", /* @__PURE__ */ new Map());
      __publicField(this, "q");
      __publicField(this, "trackerSigma");
      __publicField(this, "detectorSigma");
      __publicField(this, "gate");
      __publicField(this, "maxPredictionUs");
      __publicField(this, "resetGapUs");
      for (const t of targets) this.targets.set(t.id, t);
      this.q = options.accelerationNoise ?? 1e6;
      this.trackerSigma = options.trackerSigmaPx ?? 0.15;
      this.detectorSigma = options.detectorSigmaPx ?? 1.5;
      this.gate = options.gate ?? 25;
      this.maxPredictionUs = options.maxPredictionUs ?? 1e5;
      this.resetGapUs = options.resetGapUs ?? 3e5;
    }
    probe(_capabilities) {
      return { isAvailable: true };
    }
    start(m, info, r) {
      const z = flatCorners(m.corners);
      this.states.set(m.targetId, {
        info,
        timeUs: m.timeUs,
        x: z,
        v: new Float64Array(8),
        pp: new Float64Array(8).fill(r),
        pv: new Float64Array(8),
        vv: new Float64Array(8).fill(1e6),
        last: m
      });
      return { ...m, origin: "filter" };
    }
    update(m) {
      const info = this.targets.get(m.targetId);
      if (!info) return m;
      const sigma = m.origin === "tracker" ? this.trackerSigma : this.detectorSigma;
      const r = sigma * sigma;
      const s = this.states.get(m.targetId);
      if (!s || m.timeUs <= s.timeUs || m.timeUs - s.timeUs > this.resetGapUs) return this.start(m, info, r);
      const dt = (m.timeUs - s.timeUs) / 1e6;
      const z = flatCorners(m.corners);
      const q = this.q;
      const px = new Float64Array(8);
      const ppp = new Float64Array(8);
      const ppv = new Float64Array(8);
      const pvv = new Float64Array(8);
      let worst = 0;
      for (let i = 0; i < 8; i++) {
        px[i] = s.x[i] + dt * s.v[i];
        ppp[i] = s.pp[i] + 2 * dt * s.pv[i] + dt * dt * s.vv[i] + q * dt ** 3 / 3;
        ppv[i] = s.pv[i] + dt * s.vv[i] + q * dt * dt / 2;
        pvv[i] = s.vv[i] + q * dt;
        worst = Math.max(worst, (z[i] - px[i]) ** 2 / (ppp[i] + r));
      }
      if (worst > this.gate) return this.start(m, info, r);
      for (let i = 0; i < 8; i++) {
        const sInv = 1 / (ppp[i] + r);
        const kx = ppp[i] * sInv;
        const kv = ppv[i] * sInv;
        const y = z[i] - px[i];
        s.x[i] = px[i] + kx * y;
        s.v[i] = s.v[i] + kv * y;
        s.pp[i] = (1 - kx) * ppp[i];
        s.pv[i] = (1 - kx) * ppv[i];
        s.vv[i] = pvv[i] - kv * ppv[i];
      }
      s.timeUs = m.timeUs;
      const filtered = withCorners(m, info, s.x, m.timeUs, "filter") ?? m;
      s.last = filtered;
      return filtered;
    }
    predict(targetId, timeUs) {
      const s = this.states.get(targetId);
      return s ? extrapolate(s, timeUs, this.maxPredictionUs) : null;
    }
    snapshot(targetId) {
      const s = this.states.get(targetId);
      if (!s) return null;
      const frozen = { ...s, x: new Float64Array(s.x), v: new Float64Array(s.v) };
      return (timeUs) => extrapolate(frozen, timeUs, this.maxPredictionUs);
    }
    reset(targetId) {
      if (targetId) this.states.delete(targetId);
      else this.states.clear();
    }
  };
  function extrapolate(s, timeUs, maxUs) {
    const dtS = Math.max(0, Math.min(maxUs, timeUs - s.timeUs)) / 1e6;
    const x = Float64Array.from(s.x, (v, i) => v + s.v[i] * dtS);
    return withCorners(s.last, s.info, x, timeUs, "predicted");
  }

  // packages/filters/src/one-euro.ts
  var alpha = (cutoffHz, dtS) => {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / dtS);
  };
  var OneEuroPoseFilter = class {
    constructor(targets, options = {}) {
      __publicField(this, "info", {
        id: "E1.one-euro",
        layer: "L4",
        route: "light",
        determinism: "bit-exact",
        requires: []
      });
      __publicField(this, "targets", /* @__PURE__ */ new Map());
      __publicField(this, "states", /* @__PURE__ */ new Map());
      __publicField(this, "minCutoff");
      __publicField(this, "beta");
      __publicField(this, "dCutoff");
      __publicField(this, "maxPredictionUs");
      __publicField(this, "resetGapUs");
      for (const t of targets) this.targets.set(t.id, t);
      this.minCutoff = options.minCutoffHz ?? 0.7;
      this.beta = options.beta ?? 0.15;
      this.dCutoff = options.derivativeCutoffHz ?? 4;
      this.maxPredictionUs = options.maxPredictionUs ?? 1e5;
      this.resetGapUs = options.resetGapUs ?? 3e5;
    }
    probe(_capabilities) {
      return { isAvailable: true };
    }
    update(m) {
      const info = this.targets.get(m.targetId);
      if (!info) return m;
      const z = flatCorners(m.corners);
      const s = this.states.get(m.targetId);
      if (!s || m.timeUs <= s.timeUs || m.timeUs - s.timeUs > this.resetGapUs) {
        this.states.set(m.targetId, { info, timeUs: m.timeUs, x: z, dx: new Float64Array(8), last: m });
        return { ...m, origin: "filter" };
      }
      const dt = (m.timeUs - s.timeUs) / 1e6;
      const aD = alpha(this.dCutoff, dt);
      for (let i = 0; i < 8; i++) {
        const raw = (z[i] - s.x[i]) / dt;
        s.dx[i] = aD * raw + (1 - aD) * s.dx[i];
      }
      let speed = 0;
      for (let c = 0; c < 4; c++) speed += Math.hypot(s.dx[2 * c], s.dx[2 * c + 1]);
      const a = alpha(this.minCutoff + this.beta * (speed / 4), dt);
      for (let i = 0; i < 8; i++) s.x[i] = a * z[i] + (1 - a) * s.x[i];
      s.timeUs = m.timeUs;
      const filtered = withCorners(m, info, s.x, m.timeUs, "filter") ?? m;
      s.last = filtered;
      return filtered;
    }
    predict(targetId, timeUs) {
      const s = this.states.get(targetId);
      return s ? extrapolate2(s, timeUs, this.maxPredictionUs) : null;
    }
    /** An immutable predictor of the current state (later updates do not change it). */
    snapshot(targetId) {
      const s = this.states.get(targetId);
      if (!s) return null;
      const frozen = { ...s, x: new Float64Array(s.x), dx: new Float64Array(s.dx) };
      return (timeUs) => extrapolate2(frozen, timeUs, this.maxPredictionUs);
    }
    reset(targetId) {
      if (targetId) this.states.delete(targetId);
      else this.states.clear();
    }
  };
  function extrapolate2(s, timeUs, maxUs) {
    const dtS = Math.max(0, Math.min(maxUs, timeUs - s.timeUs)) / 1e6;
    const x = Float64Array.from(s.x, (v, i) => v + s.dx[i] * dtS);
    return withCorners(s.last, s.info, x, timeUs, "predicted");
  }

  // packages/tracking/src/dual-loop.ts
  function upscaleFor(pose2, smallPx = 240) {
    const c = pose2.corners;
    let long = 0;
    for (let i = 0; i < 4; i++)
      long = Math.max(long, Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]));
    const k = long > 0 ? smallPx / long : 1;
    return k >= 1.2 ? Math.min(3, k) : 1;
  }
  var isPose = (r) => typeof r === "object" && r !== null && "H_imageFromTarget" in r;
  function meanCornerDistance(a, b) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += Math.hypot(a.corners[i][0] - b.corners[i][0], a.corners[i][1] - b.corners[i][1]);
    return s / 4;
  }
  function diagonal(p) {
    const c = p.corners;
    return (Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) + Math.hypot(c[3][0] - c[1][0], c[3][1] - c[1][1])) / 2;
  }
  var DualLoopPipeline = class {
    constructor(parts, options = {}) {
      __publicField(this, "info");
      __publicField(this, "parts");
      __publicField(this, "options");
      __publicField(this, "workspaces", [new PyramidWorkspace(), new PyramidWorkspace()]);
      __publicField(this, "flip", 0);
      __publicField(this, "targets", /* @__PURE__ */ new Map());
      __publicField(this, "filter", null);
      __publicField(this, "state", "SEARCHING");
      /** The last measured pose and the two before it, for the constant-velocity prior. */
      __publicField(this, "measured", []);
      __publicField(this, "previousFrame", null);
      __publicField(this, "processed", 0);
      /** A concurrent relocalisation result waiting to be applied: detected and tracked poses of the same frame. */
      __publicField(this, "late", null);
      /** The last measured pose before the latest loss, for searching around it. */
      __publicField(this, "lost", null);
      this.parts = parts;
      this.options = {
        pyramidLevels: options.pyramidLevels ?? 4,
        relocalizeEvery: options.relocalizeEvery ?? 10,
        roiMargin: options.roiMargin ?? 0.35,
        coastUs: options.coastUs ?? 15e4,
        reinitDisagreement: options.reinitDisagreement ?? 0.04,
        degradedRatio: options.degradedRatio ?? 0.75,
        asyncRelocalization: options.asyncRelocalization ?? false,
        asyncDelayFrames: options.asyncDelayFrames ?? 2,
        lostSearchUs: options.lostSearchUs ?? 2e6,
        smallTargetPx: options.smallTargetPx ?? 240
      };
      this.info = {
        id: parts.id,
        layer: "L3",
        route: "light",
        determinism: "bit-exact",
        requires: [...parts.detector.info.requires, ...parts.tracker.info.requires]
      };
    }
    probe(capabilities) {
      const d = this.parts.detector.probe(capabilities);
      return d.isAvailable ? this.parts.tracker.probe(capabilities) : d;
    }
    async load(targets) {
      this.targets = new Map(targets.map((t) => [t.info.id, t.info]));
      const report = await this.parts.detector.load(targets);
      const started = performance.now();
      const shipped = targets.map((t) => {
        const template = report.targets.find((r) => r.id === t.info.id)?.template;
        return template ? { info: t.info, image: template } : t;
      });
      this.parts.tracker.prepare(shipped);
      const trackerUs = (performance.now() - started) * 1e3 / Math.max(1, targets.length);
      this.filter = this.parts.filter ? this.parts.filter(targets.map((t) => t.info)) : null;
      return { targets: report.targets.map((t) => ({ ...t, compileUs: t.compileUs + trackerUs })) };
    }
    /** Loads precompiled assets through the detector; the tracker uses the templates they carry. */
    async loadEncoded(assets) {
      if (!this.parts.detector.loadEncoded) throw new Error("Detector cannot load encoded assets");
      const report = await this.parts.detector.loadEncoded(assets);
      const targets = report.targets.map((t) => {
        if (!t.info || !t.template) throw new Error("Encoded asset without info or template");
        return { info: t.info, image: t.template };
      });
      this.targets = new Map(targets.map((t) => [t.info.id, t.info]));
      const started = performance.now();
      this.parts.tracker.prepare(targets);
      const trackerUs = (performance.now() - started) * 1e3 / Math.max(1, targets.length);
      this.filter = this.parts.filter ? this.parts.filter(targets.map((t) => t.info)) : null;
      return { targets: report.targets.map((t) => ({ ...t, compileUs: t.compileUs + trackerUs })) };
    }
    /** The answer of a concurrent relocalisation; applied at the next processed frame. */
    deliverRelocalization(detected, tracked) {
      if (detected && detected.targetId === tracked.targetId) this.late = { applyAt: this.processed, detected, tracked };
    }
    reset(_sessionId) {
      this.late = null;
      this.lost = null;
      this.state = "SEARCHING";
      this.measured = [];
      this.previousFrame = null;
      this.processed = 0;
      this.filter?.reset();
    }
    /** Constant-velocity prediction of the last measured pose to `timeUs`, in corner space. */
    prior(timeUs) {
      const last = this.measured.at(-1);
      if (!last) return null;
      const info = this.targets.get(last.targetId);
      const before = this.measured.at(-2);
      if (!before || last.timeUs - before.timeUs > 15e4 || last.timeUs <= before.timeUs) return last;
      const k = Math.min(timeUs - last.timeUs, 1e5) / (last.timeUs - before.timeUs);
      const corners = [];
      for (let i = 0; i < 4; i++)
        for (let a = 0; a < 2; a++)
          corners.push(last.corners[i][a] + k * (last.corners[i][a] - before.corners[i][a]));
      const H = homographyFromCorners(info, corners);
      return H ? { ...last, H_imageFromTarget: H, corners: cornersOf(H, info.width, info.height), timeUs, origin: "predicted" } : last;
    }
    roi(p, width2, height2, grow = 0) {
      const xs = p.corners.map((c) => c[0]);
      const ys = p.corners.map((c) => c[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const m = this.options.roiMargin + grow;
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - m * w));
      const y0 = Math.max(0, Math.floor(Math.min(...ys) - m * h));
      const x1 = Math.min(width2, Math.ceil(Math.max(...xs) + m * w));
      const y1 = Math.min(height2, Math.ceil(Math.max(...ys) + m * h));
      return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    }
    async process(frame) {
      if (frame.image.kind !== "cpu-gray") throw new Error("DualLoopPipeline needs cpu-gray frames");
      const timings = {};
      const t0 = performance.now();
      const ws = this.workspaces[this.flip ^= 1];
      const pyramid = ws.build(frame.image.image, this.options.pyramidLevels);
      const t1 = performance.now();
      timings.pyramid = (t1 - t0) * 1e3;
      const timeUs = frame.time.captureUs;
      const lastMeasured = this.measured.at(-1) ?? null;
      const previous = lastMeasured && this.previousFrame && lastMeasured.frameId === this.previousFrame.frameId ? { pyramid: this.previousFrame.pyramid, pose: lastMeasured } : null;
      let pose2 = null;
      const prior = this.prior(timeUs);
      const tracking = prior !== null && lastMeasured !== null && timeUs - lastMeasured.timeUs <= this.options.coastUs;
      if (tracking) {
        const r = this.parts.tracker.track({ frame, pyramid, prior: { ...prior, frameId: frame.frameId }, previous });
        if (isPose(r)) pose2 = r;
      }
      const t2 = performance.now();
      timings.track = (t2 - t1) * 1e3;
      if (this.late && this.processed >= this.late.applyAt) {
        const { detected, tracked } = this.late;
        this.late = null;
        const inverse = invert3(tracked.H_imageFromTarget);
        if (pose2 && inverse && detected.targetId === pose2.targetId) {
          const D = multiply3(detected.H_imageFromTarget, inverse);
          const moved = multiply3(D, pose2.H_imageFromTarget);
          const info = this.targets.get(pose2.targetId);
          const candidate = {
            ...pose2,
            H_imageFromTarget: moved,
            corners: cornersOf(moved, info.width, info.height),
            origin: "detector"
          };
          if (meanCornerDistance(candidate, pose2) > this.options.reinitDisagreement * diagonal(pose2)) {
            const refined = this.parts.tracker.track({ frame, pyramid, prior: candidate, previous: null });
            if (isPose(refined)) pose2 = refined;
          }
        }
      }
      const every = this.options.relocalizeEvery;
      const periodic = pose2 !== null && every > 0 && this.processed % every === every - 1;
      if (periodic && this.options.asyncRelocalization && this.parts.relocalizer) {
        this.parts.relocalizer({
          frame,
          roi: this.roi(pose2, pyramid.levels[0].width, pyramid.levels[0].height),
          tracked: pose2
        });
      } else if (periodic && this.options.asyncRelocalization) {
        const started = performance.now();
        const roi = this.roi(pose2, pyramid.levels[0].width, pyramid.levels[0].height);
        const upscale = upscaleFor(pose2, this.options.smallTargetPx);
        const detected = (await this.parts.detector.detect(frame, { roi, upscale })).find(
          (d) => d.targetId === pose2.targetId
        );
        if (detected) this.late = { applyAt: this.processed + this.options.asyncDelayFrames, detected, tracked: pose2 };
        timings.background = (performance.now() - started) * 1e3;
      }
      const due = !pose2 || periodic && !this.options.asyncRelocalization;
      if (due) {
        const recent = !tracking && this.lost && timeUs - this.lost.timeUs <= this.options.lostSearchUs ? this.lost : null;
        const around = tracking ? pose2 ?? prior : recent && this.processed % 3 !== 0 ? recent.pose : null;
        const grow = recent && !tracking ? (timeUs - recent.timeUs) / 1e6 : 0;
        const roi = around ? this.roi(around, pyramid.levels[0].width, pyramid.levels[0].height, grow) : null;
        const upscale = around ? upscaleFor(around, this.options.smallTargetPx) : 1;
        const detections = await this.parts.detector.detect(frame, { roi, upscale });
        const wanted = tracking ? prior.targetId : null;
        const best = detections.filter((d) => !wanted || d.targetId === wanted).sort((a, b) => b.quality.support - a.quality.support || a.targetId.localeCompare(b.targetId))[0];
        if (best && (!pose2 || meanCornerDistance(best, pose2) > this.options.reinitDisagreement * diagonal(pose2))) {
          const refined = this.parts.tracker.track({ frame, pyramid, prior: best, previous: null });
          if (isPose(refined)) pose2 = refined;
          else if (!pose2) pose2 = best;
        }
        timings.detect = (performance.now() - t2) * 1e3;
      }
      this.processed++;
      this.previousFrame = { frameId: frame.frameId, pyramid };
      let display = [];
      const poses = [];
      if (pose2) {
        this.lost = null;
        if (lastMeasured && lastMeasured.targetId !== pose2.targetId) {
          this.measured = [];
          this.filter?.reset();
        }
        this.measured = [...this.measured.slice(-2), pose2];
        this.state = pose2.quality.ratio < this.options.degradedRatio ? "DEGRADED" : "TRACKING";
        poses.push(pose2);
        display = [this.filter ? this.filter.update(pose2) : pose2];
      } else if (tracking && prior) {
        this.state = "COASTING";
        const coasted = this.filter?.predict(prior.targetId, timeUs) ?? prior;
        display = [{ ...coasted, frameId: frame.frameId, origin: "predicted" }];
      } else {
        this.state = this.measured.length ? "LOST" : "SEARCHING";
        const last = this.measured.at(-1);
        if (last) this.lost = { pose: last, timeUs: last.timeUs };
        this.measured = [];
        this.filter?.reset();
      }
      const snapshots = this.filter ? display.map((d) => this.filter.snapshot(d.targetId)).filter((s) => s !== null) : [];
      timings.total = (performance.now() - t0) * 1e3 - (timings.background ?? 0);
      return {
        frameId: frame.frameId,
        timeUs,
        state: this.state,
        poses,
        display,
        ...snapshots.length ? { predict: (t) => snapshots.map((s) => s(t)).filter((p) => p !== null) } : {},
        timings
      };
    }
    /** Single-frame recognition as the live path does it: each detection refined by the tracker when it can be. */
    async detect(frame) {
      if (frame.image.kind !== "cpu-gray") throw new Error("DualLoopPipeline needs cpu-gray frames");
      const detections = await this.parts.detector.detect(frame);
      if (!detections.length) return detections;
      const pyramid = new PyramidWorkspace().build(frame.image.image, this.options.pyramidLevels);
      return detections.map((d) => {
        const refined = this.parts.tracker.track({ frame, pyramid, prior: d, previous: null });
        return isPose(refined) ? refined : d;
      });
    }
    dispose() {
      this.measured = [];
      this.previousFrame = null;
    }
  };

  // packages/tracking/src/esm.ts
  function expm(a) {
    const out = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    let term = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (let k = 1; k <= 4; k++) {
      term = multiply3(term, a).map((v) => v / k);
      for (let i = 0; i < 9; i++) out[i] += term[i];
    }
    return out;
  }
  function generator(x) {
    return Float64Array.from([x[4], x[2], x[0], x[3], -x[4] - x[5], x[1], x[6], x[7], x[5]]);
  }
  var scaleMat = (s) => [s, 0, 0, 0, s, 0, 0, 0, 1];
  function imageScale(H, width2, height2) {
    const x = width2 / 2;
    const y = height2 / 2;
    const w = H[6] * x + H[7] * y + H[8];
    const u = (H[0] * x + H[1] * y + H[2]) / w;
    const v = (H[3] * x + H[4] * y + H[5]) / w;
    const a = (H[0] - u * H[6]) / w;
    const b = (H[1] - u * H[7]) / w;
    const c = (H[3] - v * H[6]) / w;
    const d = (H[4] - v * H[7]) / w;
    return Math.sqrt(Math.abs(a * d - b * c));
  }
  var A = new Float64Array(100);
  var B = new Float64Array(10);
  var J = new Float64Array(10);
  var S = new Float64Array(3);
  function esmAlign(model, pyramid, gradients, Hinit, options = {}) {
    const schedule = options.iterations ?? [8, 6, 5];
    const minDiag = options.minDiagonalPx ?? 56;
    const { width: tw, height: th } = model.info;
    const scale0 = imageScale(Hinit, tw, th);
    const diag0 = scale0 * Math.hypot(tw, th);
    let start = Math.min(schedule.length - 1, pyramid.levels.length - 1);
    while (start > 0 && diag0 / 2 ** start < minDiag) start--;
    let H = new Float64Array(Hinit);
    let gain = 1;
    let bias = 0;
    let iterations = 0;
    let last = null;
    for (let l = start; l >= 0; l--) {
      const image = pyramid.levels[l];
      const grad = options.gradients === "field" ? gradients(l) : null;
      const sl = scale0 / 2 ** l;
      const lt = Math.max(0, Math.min(model.esm.length - 1, Math.round(Math.log2(1 / Math.max(sl, 1e-6)))));
      const t = model.esm[lt];
      if (t.count < 30) continue;
      const Ninv = [t.s, 0, t.cx, 0, t.s, t.cy, 0, 0, 1];
      const N = [1 / t.s, 0, -t.cx / t.s, 0, 1 / t.s, -t.cy / t.s, 0, 0, 1];
      let M = multiply3(multiply3(multiply3(scaleMat(2 ** -l), H), scaleMat(2 ** lt)), Ninv);
      let sigma = 12;
      const iters = schedule[schedule.length - 1 - l] ?? schedule.at(-1);
      for (let it = 0; it < iters; it++) {
        iterations++;
        A.fill(0);
        B.fill(0);
        let valid = 0;
        let absSum = 0;
        let sumI = 0;
        let sumT = 0;
        let sumII = 0;
        let sumTT = 0;
        let sumIT = 0;
        let sse = 0;
        const k = 1.5 * sigma;
        for (let p = 0; p < t.count; p++) {
          const u = t.pn[2 * p];
          const v = t.pn[2 * p + 1];
          const w = M[6] * u + M[7] * v + M[8];
          if (!(w > 1e-9)) continue;
          const x2 = (M[0] * u + M[1] * v + M[2]) / w;
          const y = (M[3] * u + M[4] * v + M[5]) / w;
          if (!inside(image.width, image.height, x2, y, 1.5)) continue;
          let I, Ix, Iy;
          if (grad) {
            I = sample(image, x2, y);
            Ix = sampleField(grad.gx, grad.width, x2, y);
            Iy = sampleField(grad.gy, grad.width, x2, y);
          } else {
            sampleGradient(image, x2, y, S);
            I = S[0];
            Ix = S[1];
            Iy = S[2];
          }
          const a = (M[0] - x2 * M[6]) / w;
          const b = (M[1] - x2 * M[7]) / w;
          const c = (M[3] - y * M[6]) / w;
          const d = (M[4] - y * M[7]) / w;
          const T = t.value[p];
          const gu = 0.5 * (Ix * a + Iy * c + gain * t.gu[p]);
          const gv = 0.5 * (Ix * b + Iy * d + gain * t.gv[p]);
          const o = 16 * p;
          for (let i = 0; i < 8; i++) J[i] = gu * t.jwjg[o + i] + gv * t.jwjg[o + 8 + i];
          J[8] = -T;
          J[9] = -1;
          const e = I - (gain * T + bias);
          const r = Math.abs(e);
          const wt = r <= k ? 1 : k / r;
          for (let i = 0; i < 10; i++) {
            const wi = wt * J[i];
            B[i] += wi * e;
            for (let j = i; j < 10; j++) A[i * 10 + j] += wi * J[j];
          }
          valid++;
          absSum += r;
          sse += wt * e * e;
          sumI += I;
          sumT += T;
          sumII += I * I;
          sumTT += T * T;
          sumIT += I * T;
        }
        if (valid < 24) return null;
        for (let i = 0; i < 10; i++) for (let j = 0; j < i; j++) A[i * 10 + j] = A[j * 10 + i];
        for (let i = 0; i < 10; i++) A[i * 11] *= 1 + 1e-6;
        const x = Float64Array.from(B, (v) => -v);
        if (!solveInPlace(A, x, 10)) return null;
        M = multiply3(M, expm(generator(x)));
        gain = Math.min(4, Math.max(0.15, gain + x[8]));
        bias += x[9];
        sigma = Math.max(4, 1.25 * absSum / valid);
        const varI = sumII - sumI * sumI / valid;
        const varT = sumTT - sumT * sumT / valid;
        const cov = sumIT - sumI * sumT / valid;
        last = {
          ncc: varI > 0 && varT > 0 ? cov / Math.sqrt(varI * varT) : 0,
          validRatio: valid / t.count,
          rms: Math.sqrt(sse / valid),
          valid
        };
        let step = 0;
        for (let i = 0; i < 8; i++) step = Math.max(step, Math.abs(x[i]));
        if (step < 2e-5) break;
      }
      H = multiply3(multiply3(multiply3(scaleMat(2 ** l), M), N), scaleMat(2 ** -lt));
      const k8 = H[8];
      if (!(Math.abs(k8) > 1e-12)) return null;
      H = H.map((v) => v / k8);
    }
    if (!last || !H.every(Number.isFinite)) return null;
    return { H, ...last, gain, bias, iterations };
  }

  // packages/tracking/src/ncc.ts
  var patch = new Float32Array(41 * 41);
  var window = new Float32Array(81 * 81);
  function matchPatches(model, image, H, templateLevel, options = {}) {
    const h = Math.min(20, options.halfSize ?? 6);
    const radius = Math.min(20, options.radius ?? 8);
    const minScore = options.minScore ?? 0.7;
    const side = 2 * h + 1;
    const win = 2 * (h + radius) + 1;
    const Hinv = invert3(H);
    const template = model.pyramid.levels[templateLevel];
    const f = 2 ** templateLevel;
    const anchors = model.anchors;
    const n = anchors.length / 2;
    const target = [];
    const matched = [];
    const scores = [];
    if (!Hinv) return { target: new Float64Array(0), image: new Float64Array(0), score: new Float64Array(0), count: 0 };
    for (let k = 0; k < n; k++) {
      const ax = anchors[2 * k];
      const ay = anchors[2 * k + 1];
      const w0 = H[6] * ax + H[7] * ay + H[8];
      if (!(w0 > 0)) continue;
      const qx = (H[0] * ax + H[1] * ay + H[2]) / w0;
      const qy = (H[3] * ax + H[4] * ay + H[5]) / w0;
      const cx = Math.round(qx - 0.5) + 0.5;
      const cy = Math.round(qy - 0.5) + 0.5;
      if (cx - h - radius < 1 || cy - h - radius < 1 || cx + h + radius > image.width - 1 || cy + h + radius > image.height - 1)
        continue;
      let mean = 0;
      let valid = true;
      for (let j = 0, m = 0; j < side; j++)
        for (let i = 0; i < side; i++, m++) {
          const x = cx - h + i;
          const y = cy - h + j;
          const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
          const u = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w / f;
          const v = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w / f;
          const value = sample(template, u, v);
          if (Number.isNaN(value)) {
            valid = false;
            break;
          }
          patch[m] = value;
          mean += value;
        }
      if (!valid) continue;
      mean /= side * side;
      let norm = 0;
      for (let m = 0; m < side * side; m++) {
        patch[m] -= mean;
        norm += patch[m] ** 2;
      }
      if (norm < side * side * 25) continue;
      const x0 = cx - 0.5 - h - radius;
      const y0 = cy - 0.5 - h - radius;
      for (let j = 0; j < win; j++)
        for (let i = 0; i < win; i++) window[j * win + i] = image.data[(y0 + j) * image.stride + x0 + i];
      let best = -2;
      let bx = 0;
      let by = 0;
      const scoreAt = new Float32Array((2 * radius + 1) ** 2);
      for (let sy = 0; sy <= 2 * radius; sy++)
        for (let sx = 0; sx <= 2 * radius; sx++) {
          let sum = 0;
          let sum2 = 0;
          let cross = 0;
          for (let j = 0, m = 0; j < side; j++) {
            const row = (sy + j) * win + sx;
            for (let i = 0; i < side; i++, m++) {
              const v = window[row + i];
              sum += v;
              sum2 += v * v;
              cross += v * patch[m];
            }
          }
          const varI = sum2 - sum * sum / (side * side);
          const s = varI > 1e-6 ? cross / Math.sqrt(varI * norm) : -1;
          scoreAt[sy * (2 * radius + 1) + sx] = s;
          if (s > best) {
            best = s;
            bx = sx;
            by = sy;
          }
        }
      if (best < minScore || bx === 0 || by === 0 || bx === 2 * radius || by === 2 * radius) continue;
      const at = (x, y) => scoreAt[y * (2 * radius + 1) + x];
      const dx = (at(bx - 1, by) - at(bx + 1, by)) / (2 * (at(bx - 1, by) - 2 * best + at(bx + 1, by)) || 1);
      const dy = (at(bx, by - 1) - at(bx, by + 1)) / (2 * (at(bx, by - 1) - 2 * best + at(bx, by + 1)) || 1);
      target.push(ax, ay);
      matched.push(
        cx + bx - radius + Math.max(-0.5, Math.min(0.5, dx)),
        cy + by - radius + Math.max(-0.5, Math.min(0.5, dy))
      );
      scores.push(best);
    }
    return {
      target: Float64Array.from(target),
      image: Float64Array.from(matched),
      score: Float64Array.from(scores),
      count: scores.length
    };
  }

  // packages/tracking/src/klt.ts
  var W = 31 * 31;
  var winI = new Float32Array(W);
  var winX = new Float32Array(W);
  var winY = new Float32Array(W);
  function trackPoints(prev, prevGradients, next, points, guesses, options = {}) {
    const r = Math.min(15, options.radius ?? 5);
    const iterations = options.iterations ?? 10;
    const eps = options.epsilon ?? 0.01;
    const minEigen = (options.minEigen ?? 2) * (2 * r + 1) ** 2;
    const top = Math.min(options.maxLevel ?? 3, prev.levels.length - 1, next.levels.length - 1);
    const n = points.length / 2;
    const positions = new Float64Array(2 * n);
    const status = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      let gx = guesses[2 * k] / 2 ** top;
      let gy = guesses[2 * k + 1] / 2 ** top;
      let ok = true;
      for (let l = top; l >= 0 && ok; l--) {
        const I = prev.levels[l];
        const Jm = next.levels[l];
        const grad = prevGradients(l);
        const px = points[2 * k] / 2 ** l;
        const py = points[2 * k + 1] / 2 ** l;
        if (!inside(I.width, I.height, px - r, py - r, 1.5) || !inside(I.width, I.height, px + r, py + r, 1.5)) {
          if (l === 0) ok = false;
          gx *= 2;
          gy *= 2;
          continue;
        }
        let gxx = 0;
        let gyy = 0;
        let gxy = 0;
        let m = 0;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++, m++) {
            const x = px + dx;
            const y = py + dy;
            const ix = sampleField(grad.gx, grad.width, x, y);
            const iy = sampleField(grad.gy, grad.width, x, y);
            winI[m] = sample(I, x, y);
            winX[m] = ix;
            winY[m] = iy;
            gxx += ix * ix;
            gyy += iy * iy;
            gxy += ix * iy;
          }
        const tr = (gxx + gyy) / 2;
        const minEig = tr - Math.sqrt(Math.max(0, tr * tr - (gxx * gyy - gxy * gxy)));
        const det = gxx * gyy - gxy * gxy;
        if (minEig < minEigen || det <= 0) {
          if (l === 0) ok = false;
          gx *= 2;
          gy *= 2;
          continue;
        }
        let vx = 0;
        let vy = 0;
        for (let it = 0; it < iterations; it++) {
          let bx = 0;
          let by = 0;
          m = 0;
          const ox = px + gx + vx;
          const oy = py + gy + vy;
          if (!inside(Jm.width, Jm.height, ox - r, oy - r, 1) || !inside(Jm.width, Jm.height, ox + r, oy + r, 1)) {
            ok = l > 0;
            break;
          }
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++, m++) {
              const diff = winI[m] - sample(Jm, ox + dx, oy + dy);
              bx += diff * winX[m];
              by += diff * winY[m];
            }
          const ex = (gyy * bx - gxy * by) / det;
          const ey = (gxx * by - gxy * bx) / det;
          vx += ex;
          vy += ey;
          if (ex * ex + ey * ey < eps * eps) break;
        }
        if (l > 0) {
          gx = 2 * (gx + vx);
          gy = 2 * (gy + vy);
        } else {
          gx += vx;
          gy += vy;
        }
      }
      positions[2 * k] = points[2 * k] + gx;
      positions[2 * k + 1] = points[2 * k + 1] + gy;
      status[k] = ok && Number.isFinite(gx) && Number.isFinite(gy) ? 1 : 0;
    }
    return { positions, status };
  }
  function trackPointsChecked(prev, prevGradients, next, nextGradients, points, guesses, maxErrorPx, options = {}) {
    const forward = trackPoints(prev, prevGradients, next, points, guesses, options);
    const backGuess = Float64Array.from(forward.positions, (p, i) => points[i] - p);
    const back = trackPoints(next, nextGradients, prev, forward.positions, backGuess, options);
    const n = points.length / 2;
    const error = new Float64Array(n);
    const status = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      error[k] = Math.hypot(back.positions[2 * k] - points[2 * k], back.positions[2 * k + 1] - points[2 * k + 1]);
      status[k] = forward.status[k] && back.status[k] && error[k] <= maxErrorPx ? 1 : 0;
    }
    return { positions: forward.positions, status, error };
  }

  // packages/tracking/src/target-model.ts
  function esmLevel(image, level, maxPixels, cell) {
    const { width: w, height: h } = image;
    const g = scharr(image);
    const margin = 4;
    const candidates = [];
    for (let cy = margin; cy < h - margin; cy += cell)
      for (let cx = margin; cx < w - margin; cx += cell) {
        let best = [];
        for (let y = cy; y < Math.min(h - margin, cy + cell); y++)
          for (let x = cx; x < Math.min(w - margin, cx + cell); x++) {
            const i = y * w + x;
            const m = Math.hypot(g.gx[i], g.gy[i]);
            if (m < 6) continue;
            best.push({ i, m });
          }
        best.sort((a, b) => b.m - a.m || a.i - b.i);
        best = best.slice(0, 3);
        candidates.push(...best);
      }
    candidates.sort((a, b) => b.m - a.m || a.i - b.i);
    const chosen = candidates.slice(0, maxPixels).sort((a, b) => a.i - b.i);
    const n = chosen.length;
    const cxn = w / 2;
    const cyn = h / 2;
    const s = Math.max(w, h) / 2;
    const pn = new Float32Array(2 * n);
    const value = new Float32Array(n);
    const gu = new Float32Array(n);
    const gv = new Float32Array(n);
    const jwjg = new Float32Array(16 * n);
    chosen.forEach(({ i }, k) => {
      const x = i % w;
      const y = (i - x) / w;
      const u = (x + 0.5 - cxn) / s;
      const v = (y + 0.5 - cyn) / s;
      pn[2 * k] = u;
      pn[2 * k + 1] = v;
      value[k] = image.data[y * image.stride + x];
      gu[k] = g.gx[i] * s;
      gv[k] = g.gy[i] * s;
      jwjg.set([1, 0, v, 0, u, -u, -u * u, -u * v, 0, 1, 0, u, -v, -2 * v, -u * v, -v * v], 16 * k);
    });
    return { level, width: w, height: h, cx: cxn, cy: cyn, s, count: n, pn, value, gu, gv, jwjg };
  }
  function anchorPoints(image, count) {
    const { width: w, height: h } = image;
    const g = scharr(image);
    const response = new Float32Array(w * h);
    for (let y = 4; y < h - 4; y++)
      for (let x = 4; x < w - 4; x++) {
        let xx = 0;
        let yy = 0;
        let xy = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const i = (y + dy) * w + x + dx;
            xx += g.gx[i] ** 2;
            yy += g.gy[i] ** 2;
            xy += g.gx[i] * g.gy[i];
          }
        const tr = (xx + yy) / 2;
        response[y * w + x] = tr - Math.sqrt(Math.max(0, tr * tr - (xx * yy - xy * xy)));
      }
    const cell = Math.max(12, Math.round(Math.sqrt(w * h / (count * 1.5))));
    const points = [];
    for (let cy = 8; cy < h - 8; cy += cell)
      for (let cx = 8; cx < w - 8; cx += cell) {
        let best = { x: 0, y: 0, r: 0 };
        for (let y = cy; y < Math.min(h - 8, cy + cell); y++)
          for (let x = cx; x < Math.min(w - 8, cx + cell); x++) {
            const r = response[y * w + x];
            if (r > best.r) best = { x, y, r };
          }
        if (best.r > 50) points.push(best);
      }
    points.sort((a, b) => b.r - a.r || a.y - b.y || a.x - b.x);
    const kept = points.slice(0, count);
    return Float64Array.from(kept.flatMap((p) => [p.x + 0.5, p.y + 0.5]));
  }
  function buildTargetModel(target, options = {}) {
    const pyramid = buildPyramid(target.image, options.levels ?? 5, 16);
    const esm = pyramid.levels.map((level, l) => esmLevel(level, l, options.esmPixels ?? 3e3, options.esmCell ?? 8));
    return { info: target.info, pyramid, esm, anchors: anchorPoints(target.image, options.anchors ?? 160) };
  }

  // packages/tracking/src/template-tracker.ts
  var GradientCache = class {
    constructor() {
      __publicField(this, "slots", [
        { pyramid: null, current: [], buffers: [] },
        { pyramid: null, current: [], buffers: [] }
      ]);
      __publicField(this, "next", 0);
    }
    of(pyramid) {
      let slot = this.slots.find((s2) => s2.pyramid === pyramid);
      if (!slot) {
        slot = this.slots[this.next];
        this.next ^= 1;
        slot.pyramid = pyramid;
        slot.current = [];
      }
      const s = slot;
      return (level) => {
        const hit = s.current[level];
        if (hit) return hit;
        const image = pyramid.levels[level];
        const buffer = s.buffers[level];
        const g = scharr(image, buffer && buffer.gx.length === image.width * image.height ? buffer : void 0);
        s.current[level] = g;
        s.buffers[level] = g;
        return g;
      };
    }
  };
  function pose(model, H, input, quality) {
    return {
      targetId: model.info.id,
      frameId: input.frame.frameId,
      timeUs: input.frame.time.captureUs,
      H_imageFromTarget: H,
      corners: cornersOf(H, model.info.width, model.info.height),
      covariance: null,
      quality,
      origin: "tracker"
    };
  }
  function project2(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  var TemplateTracker = class {
    constructor(options = {}) {
      __publicField(this, "info");
      __publicField(this, "models", /* @__PURE__ */ new Map());
      __publicField(this, "gradients", new GradientCache());
      __publicField(this, "options");
      __publicField(this, "mode");
      this.options = options;
      this.mode = options.mode ?? "klt+esm";
      this.info = {
        id: { klt: "D1.klt", esm: "D2.esm", "klt+esm": "D1+D2.klt-esm", ncc: "D3.ncc" }[this.mode],
        layer: "L3",
        route: "light",
        determinism: "bit-exact",
        requires: []
      };
    }
    probe(_capabilities) {
      return { isAvailable: true };
    }
    prepare(targets) {
      this.models.clear();
      for (const t of targets) this.models.set(t.info.id, buildTargetModel(t, this.options.model));
    }
    model(targetId) {
      return this.models.get(targetId);
    }
    trackNcc(model, input, H) {
      const { width: width2, height: height2 } = model.info;
      const scale = imageScale(H, width2, height2);
      const level = Math.max(
        0,
        Math.min(model.pyramid.levels.length - 1, Math.round(Math.log2(1 / Math.max(scale, 1e-6))))
      );
      const m = matchPatches(model, input.pyramid.levels[0], H, level, this.options.ncc);
      if (m.count < 10) return { targetId: model.info.id, reason: "NCC_TOO_FEW" };
      const order = Array.from({ length: m.count }, (_, i) => i).sort((a, b) => m.score[b] - m.score[a] || a - b);
      const t = Float64Array.from(order.flatMap((i) => [m.target[2 * i], m.target[2 * i + 1]]));
      const im = Float64Array.from(order.flatMap((i) => [m.image[2 * i], m.image[2 * i + 1]]));
      const result = estimateHomography(t, im, m.count, width2, height2, {
        thresholdPx: 1.5,
        maxIterations: 100,
        minInliers: 10,
        minInlierRatio: 0.4,
        minCoverage: 0.05
      });
      if (!result.accepted) return { targetId: model.info.id, reason: `NCC_${result.reason}` };
      return pose(model, result.H, input, {
        support: result.inliers,
        ratio: result.ratio,
        residual: result.rmsPx,
        residualKind: "px",
        coverage: result.coverage
      });
    }
    track(input) {
      const model = this.models.get(input.prior.targetId);
      if (!model) return { targetId: input.prior.targetId, reason: "UNKNOWN_TARGET" };
      const { width: width2, height: height2 } = model.info;
      let H = input.prior.H_imageFromTarget;
      if (this.mode === "ncc") return this.trackNcc(model, input, H);
      let kltQuality = null;
      if (this.mode !== "esm" && input.previous && input.previous.pose.targetId === model.info.id) {
        const prevH = input.previous.pose.H_imageFromTarget;
        const a = model.anchors;
        const n = a.length / 2;
        const points = new Float64Array(2 * n);
        const guesses = new Float64Array(2 * n);
        const frame0 = input.previous.pyramid.levels[0];
        let m = 0;
        const keep = [];
        for (let k = 0; k < n; k++) {
          const [px, py] = project2(prevH, a[2 * k], a[2 * k + 1]);
          if (!(px > 8 && py > 8 && px < frame0.width - 8 && py < frame0.height - 8)) continue;
          const [qx, qy] = project2(H, a[2 * k], a[2 * k + 1]);
          points[2 * m] = px;
          points[2 * m + 1] = py;
          guesses[2 * m] = qx - px;
          guesses[2 * m + 1] = qy - py;
          keep.push(k);
          m++;
        }
        if (m >= 12) {
          const tracked = trackPointsChecked(
            input.previous.pyramid,
            this.gradients.of(input.previous.pyramid),
            input.pyramid,
            this.gradients.of(input.pyramid),
            points.subarray(0, 2 * m),
            guesses.subarray(0, 2 * m),
            1,
            this.options.klt
          );
          const target = [];
          const image = [];
          const errors = [];
          for (let i = 0; i < m; i++) {
            if (!tracked.status[i]) continue;
            const k = keep[i];
            target.push(a[2 * k], a[2 * k + 1]);
            image.push(tracked.positions[2 * i], tracked.positions[2 * i + 1]);
            errors.push(tracked.error[i]);
          }
          const order = errors.map((_, i) => i).sort((p, q) => errors[p] - errors[q] || p - q);
          const t = Float64Array.from(order.flatMap((i) => [target[2 * i], target[2 * i + 1]]));
          const im = Float64Array.from(order.flatMap((i) => [image[2 * i], image[2 * i + 1]]));
          const result2 = order.length >= 12 ? estimateHomography(t, im, order.length, width2, height2, {
            thresholdPx: 2,
            maxIterations: 100,
            minInliers: 10,
            minInlierRatio: 0.5,
            minCoverage: 0.05
          }) : null;
          if (result2?.accepted) {
            H = result2.H;
            kltQuality = {
              support: result2.inliers,
              ratio: result2.ratio,
              residual: result2.rmsPx,
              residualKind: "px",
              coverage: result2.coverage
            };
          }
        }
        if (this.mode === "klt") {
          if (!kltQuality) return { targetId: model.info.id, reason: "KLT_LOST" };
          return pose(model, H, input, kltQuality);
        }
      }
      const result = esmAlign(model, input.pyramid, this.gradients.of(input.pyramid), H, this.options.esm);
      if (!result) return { targetId: model.info.id, reason: "ESM_FAILED" };
      if (result.ncc < (this.options.minNcc ?? 0.6) || result.validRatio < (this.options.minValidRatio ?? 0.2))
        return { targetId: model.info.id, reason: "ESM_LOW_QUALITY" };
      if (!isPlausible(result.H, width2, height2)) return { targetId: model.info.id, reason: "ESM_IMPLAUSIBLE" };
      return pose(model, result.H, input, {
        support: result.valid,
        ratio: result.ncc,
        residual: result.rms,
        residualKind: "gray",
        coverage: result.validRatio
      });
    }
  };

  // packages/web/src/relocalize-worker.ts
  function startRelocalizer(scope3 = globalThis) {
    scope3.addEventListener("message", onMessage);
  }
  var detector = null;
  var loading = Promise.resolve();
  function onMessage(event) {
    const message = event.data;
    if (message.type === "targets") {
      const assets = message.assets.map((a) => new Uint8Array(a));
      loading = loading.then(async () => {
        await detector?.loadEncoded(assets);
      });
      return;
    }
    if (message.type !== "init") return;
    const created = new OrbDetector(
      message.wasm === false ? { allowWasm: false, orb: { wasm: false }, compile: { orb: { wasm: false } } } : {}
    );
    detector = created;
    loading = (async () => {
      if (message.assets?.length) await created.loadEncoded(message.assets.map((a) => new Uint8Array(a)));
      else
        await created.load(
          message.targets.map((t) => ({
            info: t.info,
            image: { width: t.info.width, height: t.info.height, stride: t.info.width, data: new Uint8Array(t.gray) }
          }))
        );
    })();
    const port = message.port;
    port.addEventListener("message", (e) => {
      const r = e.data;
      void (async () => {
        await loading;
        const started = performance.now();
        const found = await created.detect(
          {
            sessionId: "relocalize",
            frameId: r.frameId,
            time: { captureUs: r.captureUs, receiveUs: started * 1e3, source: "videoframe-timestamp" },
            image: {
              kind: "cpu-gray",
              image: { width: r.width, height: r.height, stride: r.width, data: new Uint8Array(r.gray) }
            }
          },
          { roi: r.roi, upscale: upscaleFor(r.tracked) }
        );
        const response = {
          type: "relocalized",
          id: r.id,
          detected: found.find((d) => d.targetId === r.tracked.targetId) ?? null,
          tracked: r.tracked,
          detectUs: (performance.now() - started) * 1e3
        };
        port.postMessage(response);
      })();
    });
    port.start();
  }

  // packages/web/src/diagnostics.ts
  var DIAGNOSTICS = false;

  // packages/web/src/orientation.ts
  var UPRIGHT = { rotation: 0, flip: false };
  function frameOrientation(frame) {
    const meta = frame;
    if (typeof meta.rotation !== "number") return null;
    const r = (Math.round(meta.rotation / 90) % 4 + 4) % 4;
    return { rotation: r * 90, flip: meta.flip === true };
  }
  function displaySize(width2, height2, o) {
    return o.rotation % 180 ? [height2, width2] : [width2, height2];
  }
  function rawFromDisplay(width2, height2, o) {
    let m;
    switch (o.rotation) {
      case 90:
        m = [0, 1, 0, -1, 0, height2];
        break;
      case 180:
        m = [-1, 0, width2, 0, -1, height2];
        break;
      case 270:
        m = [0, -1, width2, 1, 0, 0];
        break;
      default:
        m = [1, 0, 0, 0, 1, 0];
    }
    if (o.flip) m = [-m[0], -m[1], width2 - m[2], m[3], m[4], m[5]];
    return m;
  }
  function orientationName(o) {
    return `${o.flip ? "flip+" : ""}r${o.rotation}`;
  }

  // packages/web/src/luma.ts
  var YUV = /* @__PURE__ */ new Set(["I420", "I420A", "I422", "I444", "NV12"]);
  var RGB = {
    RGBA: [0, 1, 2],
    RGBX: [0, 1, 2],
    BGRA: [2, 1, 0],
    BGRX: [2, 1, 0]
  };
  var scratch = new Uint8Array(0);
  var grayScratch = new Uint8Array(0);
  var canvas = null;
  var boxed = new Uint8Array(0);
  function orientedBox(src, sw, sh, stride, n, width2, height2, out, o) {
    const rw = sw / n;
    const rh = sh / n;
    let tmp = src;
    let ts = stride;
    if (n > 1) {
      if (boxed.length < rw * rh) boxed = new Uint8Array(rw * rh);
      const shift = n === 2 ? 2 : 4;
      const half = n * n >> 1;
      for (let y = 0; y < rh; y++)
        for (let x = 0; x < rw; x++) {
          let sum = 0;
          for (let j = 0; j < n; j++) {
            const row = (y * n + j) * stride + x * n;
            for (let i = 0; i < n; i++) sum += src[row + i];
          }
          boxed[y * rw + x] = sum + half >> shift;
        }
      tmp = boxed;
      ts = rw;
    }
    if (o.rotation === 0 && !o.flip) {
      for (let y = 0; y < height2; y++) out.set(tmp.subarray(y * ts, y * ts + width2), y * width2);
      return;
    }
    const [a, b, c, d, e, f] = rawFromDisplay(rw, rh, o);
    const i0 = Math.round(0.5 * a + 0.5 * b + c - 0.5);
    const j0 = Math.round(0.5 * d + 0.5 * e + f - 0.5);
    for (let y = 0; y < height2; y++) {
      let i = i0 + b * y;
      let j = j0 + e * y;
      const row = y * width2;
      for (let x = 0; x < width2; x++) {
        out[row + x] = tmp[j * ts + i];
        i += a;
        j += d;
      }
    }
  }
  function resampleOriented(src, sw, sh, stride, width2, height2, out, o = UPRIGHT) {
    const [dw, dh] = displaySize(sw, sh, o);
    const n = dw / width2;
    if ((n === 1 || n === 2 || n === 4) && dh === n * height2 && sw % n === 0 && sh % n === 0) {
      orientedBox(src, sw, sh, stride, n, width2, height2, out, o);
      return;
    }
    if (o.rotation !== 0 || o.flip) {
      const [dw2, dh2] = displaySize(sw, sh, o);
      const [a, b, c, d, e, f] = rawFromDisplay(sw, sh, o);
      const kx2 = dw2 / width2;
      const ky2 = dh2 / height2;
      for (let y = 0; y < height2; y++) {
        const dy = (y + 0.5) * ky2;
        for (let x = 0; x < width2; x++) {
          const dx = (x + 0.5) * kx2;
          const u = Math.min(sw - 1.001, Math.max(0, a * dx + b * dy + c - 0.5));
          const v = Math.min(sh - 1.001, Math.max(0, d * dx + e * dy + f - 0.5));
          const i = Math.floor(u);
          const j = Math.floor(v);
          const fx = u - i;
          const fy = v - j;
          const p = j * stride + i;
          const top = src[p] + fx * (src[p + 1] - src[p]);
          const bottom = src[p + stride] + fx * (src[p + stride + 1] - src[p + stride]);
          out[y * width2 + x] = top + fy * (bottom - top) + 0.5 | 0;
        }
      }
      return;
    }
    const kx = sw / width2;
    const ky = sh / height2;
    for (let y = 0; y < height2; y++) {
      const v = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * ky - 0.5));
      const j = Math.floor(v);
      const fy = v - j;
      for (let x = 0; x < width2; x++) {
        const u = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * kx - 0.5));
        const i = Math.floor(u);
        const fx = u - i;
        const o2 = j * stride + i;
        const top = src[o2] + fx * (src[o2 + 1] - src[o2]);
        const bottom = src[o2 + stride] + fx * (src[o2 + stride + 1] - src[o2 + stride]);
        out[y * width2 + x] = top + fy * (bottom - top) + 0.5 | 0;
      }
    }
  }
  async function lumaFromVideoFrame(frame, width2, height2, out, o = UPRIGHT) {
    const data = out && out.length === width2 * height2 ? out : new Uint8Array(width2 * height2);
    const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
    const format = frame.format;
    if (format && (YUV.has(format) || RGB[format])) {
      const size = frame.allocationSize({ rect });
      if (scratch.length < size) scratch = new Uint8Array(size);
      const layout = await frame.copyTo(scratch, { rect });
      const plane = layout[0];
      if (YUV.has(format)) {
        resampleOriented(scratch.subarray(plane.offset), rect.width, rect.height, plane.stride, width2, height2, data, o);
        return { image: { width: width2, height: height2, stride: width2, data }, path: "yuv-plane" };
      }
      const [r, g, b] = RGB[format];
      if (grayScratch.length < rect.width * rect.height) grayScratch = new Uint8Array(rect.width * rect.height);
      const gray = grayScratch;
      for (let y = 0; y < rect.height; y++) {
        const o2 = plane.offset + y * plane.stride;
        for (let x = 0; x < rect.width; x++) {
          const p = o2 + 4 * x;
          gray[y * rect.width + x] = 77 * scratch[p + r] + 150 * scratch[p + g] + 29 * scratch[p + b] + 128 >> 8;
        }
      }
      resampleOriented(gray, rect.width, rect.height, rect.width, width2, height2, data, o);
      return { image: { width: width2, height: height2, stride: width2, data }, path: "rgb-convert" };
    }
    canvas ??= new OffscreenCanvas(width2, height2);
    if (canvas.width !== width2 || canvas.height !== height2) {
      canvas.width = width2;
      canvas.height = height2;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("No OffscreenCanvas 2D context for frame conversion");
    context.drawImage(frame, 0, 0, width2, height2);
    const rgba = context.getImageData(0, 0, width2, height2).data;
    for (let i = 0; i < width2 * height2; i++)
      data[i] = 77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2] + 128 >> 8;
    return { image: { width: width2, height: height2, stride: width2, data }, path: "canvas" };
  }
  function ncc(a, b) {
    const n = a.length;
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
      sa += a[i];
      sb += b[i];
    }
    const ma = sa / n;
    const mb = sb / n;
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma;
      const y = b[i] - mb;
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  var toGray = (rgba, out) => {
    for (let i = 0; i < out.length; i++)
      out[i] = 77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2] + 128 >> 8;
    return out;
  };
  var canvas2d = null;
  function drawn2d(frame, tw, th) {
    canvas2d ??= new OffscreenCanvas(tw, th);
    canvas2d.width = tw;
    canvas2d.height = th;
    const context = canvas2d.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2d context");
    context.imageSmoothingQuality = "high";
    context.drawImage(frame, 0, 0, tw, th);
    return toGray(context.getImageData(0, 0, tw, th).data, new Uint8Array(tw * th));
  }
  var webgl = null;
  function drawnWebgl(frame, tw, th) {
    if (!webgl) {
      const canvas3 = new OffscreenCanvas(tw, th);
      const gl2 = canvas3.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
      if (!gl2) throw new Error("no webgl2 context");
      const shader = (type, source) => {
        const s = gl2.createShader(type);
        gl2.shaderSource(s, source);
        gl2.compileShader(s);
        if (!gl2.getShaderParameter(s, gl2.COMPILE_STATUS)) throw new Error(gl2.getShaderInfoLog(s) ?? "shader");
        return s;
      };
      const program = gl2.createProgram();
      gl2.attachShader(
        program,
        shader(
          gl2.VERTEX_SHADER,
          `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  uv = vec2(0.5 * p.x + 0.5, 0.5 - 0.5 * p.y);
}`
        )
      );
      gl2.attachShader(
        program,
        shader(
          gl2.FRAGMENT_SHADER,
          `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D picture;
out vec4 color;
void main() { color = texture(picture, uv); }`
        )
      );
      gl2.linkProgram(program);
      if (!gl2.getProgramParameter(program, gl2.LINK_STATUS)) throw new Error(gl2.getProgramInfoLog(program) ?? "link");
      gl2.useProgram(program);
      const texture2 = gl2.createTexture();
      gl2.bindTexture(gl2.TEXTURE_2D, texture2);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR_MIPMAP_LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
      webgl = { canvas: canvas3, gl: gl2, texture: texture2 };
    }
    const { canvas: canvas2, gl, texture } = webgl;
    if (canvas2.width !== tw || canvas2.height !== th) {
      canvas2.width = tw;
      canvas2.height = th;
    }
    gl.viewport(0, 0, tw, th);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const rgba = new Uint8Array(4 * tw * th);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const flipped = new Uint8Array(rgba.length);
    for (let y = 0; y < th; y++) flipped.set(rgba.subarray((th - 1 - y) * 4 * tw, (th - y) * 4 * tw), y * 4 * tw);
    return toGray(flipped, new Uint8Array(tw * th));
  }
  function rawThumbnail(plane, rw, rh, stride, tw, th, o) {
    const big = new Uint8Array(16 * tw * th);
    resampleOriented(plane, rw, rh, stride, 4 * tw, 4 * th, big, o);
    const out = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        let sum = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) sum += big[(4 * y + j) * 4 * tw + 4 * x + i];
        out[y * tw + x] = sum + 8 >> 4;
      }
    return out;
  }
  async function detectRotation(frame, width2, height2, thumbnails = false) {
    const format = frame.format;
    const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
    const base = { format, raw: [rect.width, rect.height] };
    if (!format || !(YUV.has(format) || RGB[format]) || typeof OffscreenCanvas === "undefined")
      return { ...base, orientation: null, reference: null, scores: {} };
    const tw = Math.max(16, Math.round(width2 / 8));
    const th = Math.max(16, Math.round(height2 / 8));
    const size = frame.allocationSize({ rect });
    if (scratch.length < size) scratch = new Uint8Array(size);
    const layout = (await frame.copyTo(scratch, { rect }))[0];
    let raw = scratch.subarray(layout.offset);
    let plane = { stride: layout.stride };
    if (!YUV.has(format)) {
      const [r, g, b] = RGB[format];
      raw = new Uint8Array(rect.width * rect.height);
      for (let y = 0; y < rect.height; y++) {
        const o = layout.offset + y * layout.stride;
        for (let x = 0; x < rect.width; x++) {
          const p = o + 4 * x;
          raw[y * rect.width + x] = 77 * scratch[p + r] + 150 * scratch[p + g] + 29 * scratch[p + b] + 128 >> 8;
        }
      }
      plane = { stride: rect.width };
    }
    const shownPortrait = height2 > width2;
    const candidates = [0, 90, 180, 270].map((rotation) => ({ rotation, flip: false })).filter((o) => {
      const [dw, dh] = displaySize(rect.width, rect.height, o);
      return dh > dw === shownPortrait;
    }).map((o) => ({ o, thumb: rawThumbnail(raw, rect.width, rect.height, plane.stride, tw, th, o) }));
    const scores = {};
    const shots = {};
    let decided = null;
    for (const [reference, render] of [
      ["webgl", drawnWebgl],
      ["2d", drawn2d]
    ]) {
      let picture;
      try {
        picture = render(frame, tw, th);
      } catch (e) {
        scores[reference] = `error: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`;
        continue;
      }
      if (DIAGNOSTICS && thumbnails) shots[reference] = Array.from(picture);
      const scored = candidates.map((c) => ({ o: c.o, score: ncc(c.thumb, picture) })).sort((p, q) => q.score - p.score);
      scores[reference] = Object.fromEntries(scored.map((c) => [`r${c.o.rotation}`, Math.round(c.score * 1e3) / 1e3]));
      const best = scored[0];
      const second = scored[1]?.score ?? -1;
      if (best && best.score > 0.7 && 1 - second > 3 * (1 - best.score) + 0.02 && (!decided || best.score > decided.score))
        decided = { o: best.o, reference, score: best.score };
    }
    const report = {
      ...base,
      orientation: decided?.o ?? null,
      reference: decided?.reference ?? null,
      scores
    };
    return false ? withThumbnails(report, shots, raw, rect, plane.stride, [tw, th]) : report;
  }

  // packages/web/src/protocol.ts
  var DEFAULT_PIPELINE = { tracker: "esm", filter: "E2", relocalizeEvery: 60, wasm: true };

  // packages/web/src/vision-worker.ts
  var scope = globalThis;
  var pipeline = null;
  var nextRequestId = 0;
  var epochStartId = 0;
  var session = 0;
  var width = 640;
  var height = 360;
  var frameWidth = () => width;
  var frameHeight = () => height;
  var returnFrames = false;
  var probe = false;
  var sequence = 0;
  var busy = false;
  var stopped = false;
  var waiting = null;
  function post(message, transfer = []) {
    scope.postMessage(message, transfer);
  }
  function velocities(p, predict) {
    const ahead = predict?.(p.timeUs + 1e4).find((q) => q.targetId === p.targetId);
    if (!ahead) return new Array(8).fill(0);
    const v = [];
    for (let c = 0; c < 4; c++) for (let k = 0; k < 2; k++) v.push((ahead.corners[c][k] - p.corners[c][k]) / 0.01);
    return v;
  }
  var sources = null;
  var config = DEFAULT_PIPELINE;
  var relocalizerPort = null;
  async function assemble(config2) {
    const detector2 = new OrbDetector(
      config2.wasm ? {} : { allowWasm: false, orb: { wasm: false }, compile: { orb: { wasm: false } } }
    );
    const port = relocalizerPort;
    const created = new DualLoopPipeline(
      {
        id: "vision",
        detector: detector2,
        tracker: new TemplateTracker({
          mode: config2.tracker,
          ...config2.esmIterations ? { esm: { iterations: config2.esmIterations } } : {}
        }),
        filter: (targets) => config2.filter === "E1" ? new OneEuroPoseFilter(targets) : new KalmanPoseFilter(targets),
        // Concurrent relocalisation: the frame's pixels go to the second Worker, the answer comes back later.
        ...port ? {
          relocalizer: ({ frame, roi, tracked }) => {
            if (frame.image.kind !== "cpu-gray") return;
            const gray = frame.image.image.data.slice().buffer;
            const request = {
              type: "relocalize",
              id: nextRequestId++,
              gray,
              width: frame.image.image.width,
              height: frame.image.image.height,
              frameId: frame.frameId,
              captureUs: frame.time.captureUs,
              roi,
              tracked
            };
            port.postMessage(request, [gray]);
          }
        } : {}
      },
      { relocalizeEvery: config2.relocalizeEvery, asyncRelocalization: !!port }
    );
    let infos;
    if (sources?.assets?.length) {
      const report = await created.loadEncoded(sources.assets.map((a) => new Uint8Array(a)));
      infos = report.targets.map((t) => t.info);
    } else {
      const targets = (sources?.targets ?? []).map((t) => ({
        info: t.info,
        image: { width: t.info.width, height: t.info.height, stride: t.info.width, data: new Uint8Array(t.gray) }
      }));
      await created.load(targets);
      infos = targets.map((t) => t.info);
    }
    created.reset(`web-${++session}`);
    return { pipeline: created, matcher: detector2.backend, infos };
  }
  var orientation2 = UPRIGHT;
  var orientationKind = "assumed";
  var orientationDetail = "";
  var detectedAt = -Infinity;
  var pendingDiagnostics = null;
  var diagnosticsSent = false;
  var REDETECT = 30;
  async function orient(frame) {
    const meta = frameOrientation(frame);
    if (meta) {
      orientationKind = "metadata";
      return orientation2 = meta;
    }
    if (sequence - detectedAt >= REDETECT) {
      detectedAt = sequence;
      let report = null;
      try {
        report = await detectRotation(frame, width, height, DIAGNOSTICS && !diagnosticsSent);
      } catch (e) {
        orientationKind = "error";
        orientationDetail = String(e instanceof Error ? e.message : e).slice(0, 120);
      }
      if (report) {
        if (DIAGNOSTICS && !diagnosticsSent) pendingDiagnostics = report;
        const scores = JSON.stringify(report.scores);
        if (report.orientation) {
          orientation2 = report.orientation;
          orientationKind = `detected[${report.reference}]`;
        } else {
          const turned = report.raw[0] > report.raw[1] !== width > height;
          orientation2 = turned ? { rotation: 90, flip: false } : UPRIGHT;
          orientationKind = turned ? "fallback" : "assumed";
        }
        orientationDetail = `${report.format} ${report.raw.join("x")} ${scores}`;
      }
    }
    return orientation2;
  }
  async function process(frame, grayBuffer, captureUs) {
    if (!pipeline) {
      frame?.close();
      return;
    }
    const width2 = frameWidth();
    const height2 = frameHeight();
    const started = performance.now();
    let path = "gray";
    let pixels;
    if (frame) {
      const luma = await lumaFromVideoFrame(frame, width2, height2, void 0, await orient(frame));
      pixels = luma.image.data;
      path = luma.path;
    } else pixels = new Uint8Array(grayBuffer);
    const lumaDone = performance.now();
    const handle = {
      sessionId: "web",
      frameId: sequence,
      time: { captureUs, receiveUs: started * 1e3, source: frame ? "videoframe-timestamp" : "callback" },
      image: { kind: "cpu-gray", image: { width: width2, height: height2, stride: width2, data: pixels } }
    };
    const output = await pipeline.process(handle);
    const done = performance.now();
    const poses = output.display.map((p) => ({
      targetId: p.targetId,
      corners: p.corners,
      velocity: velocities(p, output.predict),
      timeUs: p.timeUs
    }));
    let strip;
    if (DIAGNOSTICS && probe) {
      strip = new Uint8Array(128 * 8);
      for (let y = 0; y < 8; y++)
        strip.set(pixels.subarray((height2 - 8 + y) * width2, (height2 - 8 + y) * width2 + 128), 128 * y);
    }
    const arrival = frame && Math.abs(started * 1e3 - captureUs) < 5e6 ? started * 1e3 - captureUs : null;
    const message = {
      type: "result",
      sequence: sequence++,
      captureUs,
      state: output.state,
      size: [width2, height2],
      poses,
      stats: {
        lumaUs: (lumaDone - started) * 1e3,
        processUs: (done - lumaDone) * 1e3,
        arrivalUs: arrival,
        lumaPath: path,
        orientation: frame ? `${orientationName(orientation2)}/${orientationKind}` : "gray",
        ...frame && orientationDetail ? { orientationDetail } : {}
      },
      ...DIAGNOSTICS && pendingDiagnostics && !diagnosticsSent ? { diagnostics: pendingDiagnostics } : {},
      ...returnFrames && frame ? { frame } : {},
      ...DIAGNOSTICS && strip ? { strip } : {},
      ...DIAGNOSTICS && probe ? {
        trace: {
          measured: output.poses.map((p) => ({ targetId: p.targetId, origin: p.origin, ...p.quality })),
          timings: output.timings
        }
      } : {}
    };
    if (DIAGNOSTICS && pendingDiagnostics) {
      diagnosticsSent = true;
      pendingDiagnostics = null;
    }
    const transfer = [];
    if (returnFrames && frame) transfer.push(frame);
    post(message, transfer);
    if (!returnFrames) frame?.close();
  }
  var lastCaptureUs = -Infinity;
  function captureTime(frame) {
    const stamped = frame.timestamp;
    const t = Number.isFinite(stamped) && stamped > lastCaptureUs ? stamped : performance.now() * 1e3;
    lastCaptureUs = t;
    return t;
  }
  async function pump(readable) {
    const reader = readable.getReader();
    let pending = null;
    let reading = false;
    const readNext = async () => {
      reading = true;
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        pending?.close();
        pending = value;
        if (!busy) void drain();
      }
      reading = false;
    };
    const drain = async () => {
      busy = true;
      while (pending && !stopped) {
        const frame = pending;
        pending = null;
        try {
          await process(frame, null, captureTime(frame));
        } catch (error) {
          post({ type: "error", message: String(error) });
        }
      }
      busy = false;
    };
    if (!reading) await readNext();
  }
  async function drainWaiting() {
    busy = true;
    while (waiting && !stopped) {
      const w = waiting;
      waiting = null;
      try {
        await process(w.frame, w.gray, w.captureUs);
      } catch (error) {
        w.frame?.close();
        post({ type: "error", message: String(error) });
      }
    }
    busy = false;
  }
  function startVisionWorker(target = globalThis) {
    scope = target;
    scope.addEventListener("message", onMessage2);
  }
  function onMessage2(event) {
    const message = event.data;
    switch (message.type) {
      case "init": {
        void (async () => {
          width = message.width;
          height = message.height;
          returnFrames = message.returnFrames;
          probe = DIAGNOSTICS && message.probe;
          relocalizerPort = message.relocalizer ?? null;
          relocalizerPort?.addEventListener("message", (event2) => {
            if (event2.data.id >= epochStartId) pipeline?.deliverRelocalization(event2.data.detected, event2.data.tracked);
          });
          relocalizerPort?.start();
          sources = { targets: message.targets, assets: message.assets ?? null };
          const started = performance.now();
          config = { ...DEFAULT_PIPELINE, ...message.pipeline };
          const built = await assemble(config);
          pipeline = built.pipeline;
          post({ type: "ready", matcher: built.matcher, compileMs: performance.now() - started, targets: built.infos });
        })().catch((error) => post({ type: "error", message: String(error) }));
        return;
      }
      case "reconfigure": {
        void (async () => {
          config = { ...DEFAULT_PIPELINE, ...message.pipeline };
          const built = await assemble(config);
          epochStartId = nextRequestId;
          pipeline?.dispose();
          pipeline = built.pipeline;
        })().catch((error) => post({ type: "error", message: `reconfigure: ${String(error)}` }));
        return;
      }
      case "targets": {
        sources = { targets: [], assets: message.assets };
        void (async () => {
          const built = await assemble(config);
          epochStartId = nextRequestId;
          pipeline?.dispose();
          pipeline = built.pipeline;
          post({ type: "targets", targets: built.infos });
        })().catch((error) => post({ type: "error", message: `targets: ${String(error)}` }));
        return;
      }
      case "stream":
        void pump(message.readable);
        return;
      case "track": {
        if (typeof MediaStreamTrackProcessor !== "function") {
          post({ type: "error", message: "MediaStreamTrackProcessor unavailable in Worker" });
          return;
        }
        void pump(new MediaStreamTrackProcessor({ track: message.track, maxBufferSize: 1 }).readable);
        return;
      }
      case "frame":
      case "gray": {
        waiting?.frame?.close();
        waiting = message.type === "frame" ? { frame: message.frame, gray: null, captureUs: message.captureUs } : { frame: null, gray: message.gray, captureUs: message.captureUs };
        if (!busy) void drainWaiting();
        return;
      }
      case "resize": {
        width = message.width;
        height = message.height;
        epochStartId = nextRequestId;
        pipeline?.reset(`web-${++session}`);
        detectedAt = -Infinity;
        orientation2 = UPRIGHT;
        orientationKind = "assumed";
        break;
      }
      case "stop":
        stopped = true;
        waiting?.frame?.close();
        waiting = null;
        return;
    }
  }

  // packages/web/src/picture.ts
  var MIN_POINTS = 48;
  var MIN_EDGE_PX = 64;
  var PictureError = class extends Error {
    constructor(code, message, options) {
      super(message, options);
      __publicField(this, "code");
      this.name = "PictureError";
      this.code = code;
    }
  };
  function scaledSize(width2, height2, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width2, height2));
    return [Math.max(1, Math.round(width2 * scale)), Math.max(1, Math.round(height2 * scale))];
  }
  function grayFromRgba(rgba, width2, height2) {
    const gray = new Uint8Array(width2 * height2);
    for (let i = 0; i < gray.length; i++)
      gray[i] = 77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2] + 128 >> 8;
    return gray;
  }
  function canDrawPictures() {
    try {
      return typeof OffscreenCanvas === "function" && !!new OffscreenCanvas(1, 1).getContext("2d");
    } catch {
      return false;
    }
  }
  async function decodePicture(blob, maxEdge) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      try {
        bitmap = await createImageBitmap(blob);
      } catch (cause) {
        throw new PictureError("DECODE_FAILED", `The picture cannot be decoded: ${String(cause)}`, { cause });
      }
    }
    try {
      const [width2, height2] = scaledSize(bitmap.width, bitmap.height, maxEdge);
      let source = bitmap;
      let sw = bitmap.width;
      let sh = bitmap.height;
      while (sw > 2 * width2 && sh > 2 * height2) {
        const half = new OffscreenCanvas(Math.ceil(sw / 2), Math.ceil(sh / 2));
        const c = half.getContext("2d");
        c.imageSmoothingQuality = "high";
        c.drawImage(source, 0, 0, half.width, half.height);
        source = half;
        sw = half.width;
        sh = half.height;
      }
      const canvas2 = new OffscreenCanvas(width2, height2);
      const context = canvas2.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, width2, height2);
      const rgba = context.getImageData(0, 0, width2, height2).data;
      return { width: width2, height: height2, stride: width2, data: grayFromRgba(rgba, width2, height2) };
    } finally {
      bitmap.close();
    }
  }
  async function compilePicture(targetId, image) {
    if (Math.min(image.width, image.height) < MIN_EDGE_PX)
      throw new PictureError("UNSUITABLE_TARGET", `The picture is too small (${image.width}×${image.height} px)`);
    const compiled2 = compileTarget({
      info: { id: targetId, width: image.width, height: image.height, physicalWidthMeters: null },
      image
    });
    const pointCount = compiled2.points.length / 2;
    if (pointCount < MIN_POINTS)
      throw new PictureError("UNSUITABLE_TARGET", `The picture has too little detail (${pointCount} recognition points)`);
    return { bytes: await encodeTarget(compiled2, image), pointCount };
  }

  // packages/engine/src/compile-worker.ts
  function startCompiler(scope3) {
    let queue = Promise.resolve();
    scope3.addEventListener("message", (event) => {
      const m = event.data;
      if (m.type !== "compile") return;
      queue = queue.then(async () => {
        try {
          let image;
          if (m.gray)
            image = {
              width: m.gray.width,
              height: m.gray.height,
              stride: m.gray.width,
              data: new Uint8Array(m.gray.data)
            };
          else if (!canDrawPictures()) {
            scope3.postMessage({ type: "need-gray", id: m.id });
            return;
          } else image = await decodePicture(m.image, m.maxEdgePx);
          const { bytes, pointCount } = await compilePicture(m.targetId, image);
          const buffer = bytes.buffer;
          scope3.postMessage(
            { type: "compiled", id: m.id, bytes: buffer, widthPx: image.width, heightPx: image.height, pointCount },
            [buffer]
          );
        } catch (error) {
          scope3.postMessage({
            type: "failed",
            id: m.id,
            code: error instanceof PictureError ? error.code : "INVALID_TARGET",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
    });
  }

  // packages/engine/src/worker-entry.ts
  var scope2 = globalThis;
  function chooseRole(event) {
    const message = event.data;
    if (message?.type !== "role") return;
    scope2.removeEventListener("message", chooseRole);
    if (message.role === "vision") startVisionWorker(scope2);
    else if (message.role === "relocalizer") startRelocalizer(scope2);
    else startCompiler(scope2);
  }
  scope2.addEventListener("message", chooseRole);
})();
