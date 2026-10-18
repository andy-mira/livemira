/*! LiveMira tracking-visuals | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

// packages/contracts/src/errors.ts
var EngineError = class extends Error {
  code;
  isRecoverable;
  constructor(code, message, options) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "EngineError";
    this.code = code;
    this.isRecoverable = options.isRecoverable;
  }
};

// packages/contracts/src/tracking-result.ts
var MAX_MATCHED_POINTS = 512;

// packages/tracking-visuals/src/svg-layer.ts
var SVG_NS = "http://www.w3.org/2000/svg";
var dotPath = (points) => points.map((p) => `M${p[0].toFixed(1)} ${p[1].toFixed(1)}h0`).join("");
var SvgLayer = class {
  shownDots = 0;
  isBoundaryShown = false;
  svg;
  polygon;
  dots;
  constructor(container) {
    const doc = container.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.setAttribute("data-lm-visual", "tracking");
    Object.assign(this.svg.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "2",
      display: "none"
    });
    this.polygon = doc.createElementNS(SVG_NS, "polygon");
    this.polygon.setAttribute("fill", "rgba(0,255,136,.08)");
    this.polygon.setAttribute("stroke-width", "3");
    this.polygon.setAttribute("stroke-linejoin", "round");
    this.dots = doc.createElementNS(SVG_NS, "path");
    this.dots.setAttribute("fill", "none");
    this.dots.setAttribute("stroke", "#ffeb3b");
    this.dots.setAttribute("stroke-width", "5");
    this.dots.setAttribute("stroke-linecap", "round");
    this.polygon.style.display = this.dots.style.display = "none";
    this.svg.append(this.polygon, this.dots);
    container.append(this.svg);
  }
  draw(boundary, points, isMeasured) {
    this.isBoundaryShown = boundary !== null;
    if (boundary) {
      this.polygon.setAttribute("points", boundary.map((p) => `${p[0]},${p[1]}`).join(" "));
      this.polygon.setAttribute("stroke", isMeasured ? "#00ff88" : "#ffc65c");
      if (isMeasured) this.polygon.removeAttribute("stroke-dasharray");
      else this.polygon.setAttribute("stroke-dasharray", "7 5");
    }
    this.polygon.style.display = boundary ? "block" : "none";
    this.shownDots = points?.length ?? 0;
    if (points?.length) this.dots.setAttribute("d", dotPath(points));
    else this.dots.removeAttribute("d");
    this.dots.style.display = points?.length ? "block" : "none";
    this.svg.style.display = boundary || points?.length ? "block" : "none";
  }
  dispose() {
    this.draw(null, null, true);
    this.svg.remove();
  }
};

// packages/tracking-visuals/src/tracking-visuals.ts
function parseFlags(value) {
  const fail = () => {
    throw new EngineError(
      "INVALID_CONFIG",
      "visualization must be { boundary?: boolean, points?: boolean }",
      {
        isRecoverable: false
      }
    );
  };
  if (value === void 0) return { boundary: false, points: false };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value;
  for (const key of Object.keys(record)) if (key !== "boundary" && key !== "points") fail();
  for (const key of ["boundary", "points"])
    if (record[key] !== void 0 && typeof record[key] !== "boolean") fail();
  return { boundary: record.boundary === true, points: record.points === true };
}
function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) return null;
  const q = [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
}
function currentMatchedPoints(result) {
  const m = result?.matchedPoints;
  if (!m || typeof m !== "object" || result.state !== "TRACKING" && result.state !== "LIMITED" || !result.quality?.isMeasured || result.quality.isDegenerate)
    return null;
  if (!result.targetId || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId)
    return null;
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p)
    if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))
      return null;
  return p;
}
function createTrackingVisuals(options = {}) {
  let flags = parseFlags(options);
  let layer = null;
  let host = null;
  const clear = () => layer?.draw(null, null, true);
  const drop = () => {
    layer?.dispose();
    layer = null;
  };
  const draw = (result, h) => {
    let boundary = null;
    let points = null;
    try {
      if (h.length !== 9 || !h.every(Number.isFinite)) {
        clear();
        return false;
      }
      const map = (list) => list.flatMap((p) => {
        const q = project(h, p[0], p[1]);
        return q ? [q] : [];
      });
      if (flags.boundary) {
        const size = host.getTargets().find((t) => t.targetId === result.targetId);
        const corners = result.cornersPx ?? (size && result.H_imageFromTarget ? [
          [0, 0],
          [size.widthPx, 0],
          [size.widthPx, size.heightPx],
          [0, size.heightPx]
        ].flatMap(([x, y]) => {
          const q = project(result.H_imageFromTarget, x, y);
          return q ? [q] : [];
        }) : null);
        if (corners && corners.length === 4) {
          const q = map(corners);
          boundary = q.length === 4 ? q : null;
        }
      }
      const current = flags.points ? currentMatchedPoints(result) : null;
      if (current) {
        const q = map(current);
        points = q.length ? q : null;
      }
    } catch {
      boundary = points = null;
    }
    if (!boundary && !points) {
      clear();
      return false;
    }
    layer ??= new SvgLayer(host.overlayLayer);
    layer.draw(boundary, points, result.quality.isMeasured);
    return true;
  };
  return {
    name: "tracking-visuals",
    needs: { matchedPoints: flags.points },
    attach(next) {
      host = next;
      const offPresented = next.onPresented((result, geometry) => {
        if (!flags.boundary && !flags.points) {
          clear();
          return false;
        }
        return draw(result, geometry.H_viewportFromStandard);
      });
      const offCleared = next.onCleared((reason) => {
        if (reason === "stop" || reason === "session") drop();
        else clear();
      });
      return {
        detach() {
          offPresented();
          offCleared();
          drop();
          host = null;
        }
      };
    },
    setVisualization(next) {
      flags = parseFlags(next);
      clear();
      if (!flags.boundary && !flags.points) drop();
    },
    getVisualization: () => ({ ...flags }),
    getDiagnostics: () => ({
      ...flags,
      isBoundaryShown: layer?.isBoundaryShown ?? false,
      shownPoints: layer?.shownDots ?? 0,
      isLayerAttached: layer !== null
    })
  };
}
export {
  createTrackingVisuals,
  currentMatchedPoints
};
