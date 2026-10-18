/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Point2 } from '@livemira/contracts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const dotPath = (points: readonly Point2[]): string =>
  points.map((p) => `M${p[0].toFixed(1)} ${p[1].toFixed(1)}h0`).join('');

/** One SVG in the extension layer: the target boundary (green when measured, amber dashed when predicted) and dots. */
export class SvgLayer {
  shownDots = 0;
  isBoundaryShown = false;
  private readonly svg: SVGSVGElement;
  private readonly polygon: SVGPolygonElement;
  private readonly dots: SVGPathElement;

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('data-lm-visual', 'tracking');
    Object.assign(this.svg.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      overflow: 'visible',
      pointerEvents: 'none',
      zIndex: '2',
      display: 'none',
    });
    this.polygon = doc.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
    this.polygon.setAttribute('fill', 'rgba(0,255,136,.08)');
    this.polygon.setAttribute('stroke-width', '3');
    this.polygon.setAttribute('stroke-linejoin', 'round');
    this.dots = doc.createElementNS(SVG_NS, 'path') as SVGPathElement;
    this.dots.setAttribute('fill', 'none');
    this.dots.setAttribute('stroke', '#ffeb3b');
    this.dots.setAttribute('stroke-width', '5');
    this.dots.setAttribute('stroke-linecap', 'round');
    this.polygon.style.display = this.dots.style.display = 'none';
    this.svg.append(this.polygon, this.dots);
    container.append(this.svg);
  }

  draw(
    boundary: readonly Point2[] | null,
    points: readonly Point2[] | null,
    isMeasured: boolean,
  ): void {
    this.isBoundaryShown = boundary !== null;
    if (boundary) {
      this.polygon.setAttribute('points', boundary.map((p) => `${p[0]},${p[1]}`).join(' '));
      this.polygon.setAttribute('stroke', isMeasured ? '#00ff88' : '#ffc65c');
      if (isMeasured) this.polygon.removeAttribute('stroke-dasharray');
      else this.polygon.setAttribute('stroke-dasharray', '7 5');
    }
    this.polygon.style.display = boundary ? 'block' : 'none';
    this.shownDots = points?.length ?? 0;
    if (points?.length) this.dots.setAttribute('d', dotPath(points));
    else this.dots.removeAttribute('d');
    this.dots.style.display = points?.length ? 'block' : 'none';
    this.svg.style.display = boundary || points?.length ? 'block' : 'none';
  }

  dispose(): void {
    this.draw(null, null, true);
    this.svg.remove();
  }
}
