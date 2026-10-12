/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import {validateGray} from '../experimental/features.mjs';
export const LEGACY_INTERMEDIATE_SCALE = Math.SQRT1_2;
// An extra frame sampling scale; it does not modify stored legacy descriptors.
export function intermediateLegacyImage(image) {
 validateGray(image);
 const scale=LEGACY_INTERMEDIATE_SCALE,width=Math.floor(image.width*scale),height=Math.floor(image.height*scale);
 if(width<32||height<32)return null;
 const data=new Uint8Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const sx=(x+.5)/scale-.5,sy=(y+.5)/scale-.5,ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy,i=iy*image.width+ix;
  data[y*width+x]=Math.round((1-fy)*((1-fx)*image.data[i]+fx*image.data[i+1])+fy*((1-fx)*image.data[i+image.width]+fx*image.data[i+image.width+1]));
 }
 return{width,height,data};
}
