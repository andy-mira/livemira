import { project } from '../../packages/recognition/experimental/geometry.mjs';
export function texture(seed = 1234, width = 320, height = 240) {
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const data = new Uint8Array(width * height).fill(80);
  for (let i = 0; i < 900; i++) {
    const x = random() % width, y = random() % height, w = 3 + random() % 20, h = 3 + random() % 20, color = random() % 256;
    for (let dy = 0; dy < h && y + dy < height; dy++) for (let dx = 0; dx < w && x + dx < width; dx++) data[(y + dy) * width + x + dx] = color;
  }
  return { data, width, height };
}
export function inverse(h) {
  const [a,b,c,d,e,f,g,i,j] = h;
  const cof = [e*j-f*i,c*i-b*j,b*f-c*e,f*g-d*j,a*j-c*g,c*d-a*f,d*i-e*g,b*g-a*i,a*e-b*d];
  const det = a*cof[0]+b*cof[3]+c*cof[6];
  return cof.map(v => v/det);
}
export function warp(image, h, width = image.width, height = image.height) {
  const data = new Uint8Array(width * height).fill(30), inv = inverse(h);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [sx, sy] = project(inv, [x, y]), ix = Math.floor(sx), iy = Math.floor(sy);
    if (ix >= 0 && iy >= 0 && ix + 1 < image.width && iy + 1 < image.height) {
      const fx = sx - ix, fy = sy - iy, p = iy * image.width + ix;
      data[y * width + x] = Math.round((1-fy)*((1-fx)*image.data[p]+fx*image.data[p+1])+fy*((1-fx)*image.data[p+image.width]+fx*image.data[p+image.width+1]));
    }
  }
  return { data, width, height };
}
