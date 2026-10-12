/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Demo integration example. Bind to existing UI; this does not create DOM. */
export function bindMediaControls({engine,renderer,targetId,fileInput,urlInput,loadUrlButton,audioButton,muteButton,retryButton,clearButton,onStatus=()=>{}}) {
  let blockedRetry=null;
  const listeners=[];
  const listen=(element,event,fn)=>{if(element){element.addEventListener(event,fn);listeners.push(()=>element.removeEventListener(event,fn));}};
  const resetRetry=()=>{blockedRetry=null;retryButton.hidden=true;};
  const offBlocked=engine.on('playbackBlocked',event=>{if(event.targetId!==targetId)return;blockedRetry=event.retry;retryButton.hidden=false;onStatus('playback-gesture-required');});
  const offError=engine.on('error',event=>{if(event.targetId!==targetId||event.error.code!=='RESOURCE_FAILED')return;blockedRetry=null;retryButton.hidden=false;onStatus('media-resource-failed');});
  listen(fileInput,'change',()=>{const file=fileInput.files?.[0];if(!file)return;resetRetry();renderer.setTargetMediaFile(targetId,file,{muted:true,loop:true,fit:'contain'});onStatus('local-media-selected');});
  listen(loadUrlButton,'click',()=>{const url=urlInput.value.trim();if(!url)return;resetRetry();engine.setTargetMedia(targetId,{url,muted:true,loop:true,fit:'contain'});onStatus('url-media-selected');});
  listen(audioButton,'click',()=>{void renderer.setMutedFromGesture(false);});
  listen(muteButton,'click',()=>{void renderer.setMutedFromGesture(true);});
  listen(retryButton,'click',async()=>{
    const attempt=blockedRetry;blockedRetry=null;retryButton.hidden=true;
    // Invoke synchronously inside the click; do not await network work before play.
    if(attempt)await attempt();else if(!await renderer.retryActiveMediaFromGesture()){retryButton.hidden=false;onStatus('wait-for-visible-target-or-retry');}
    // A new playbackBlocked/error event can show the button during await; keep it shown.
  });
  listen(clearButton,'click',()=>{resetRetry();renderer.clearTargetMedia(targetId);onStatus('media-cleared');});
  return ()=>{for(const remove of listeners)remove();offBlocked();offError();blockedRetry=null;};
}
