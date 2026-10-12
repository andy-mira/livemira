/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MediaConfig } from '@livemira/contracts';
export class VideoSession {
  constructor(video: HTMLVideoElement,onEvent?:(event:{type:string;code:string;recoverable:boolean;reason:string})=>void);
  configure(config:MediaConfig):void;
  play(restart?:boolean):Promise<boolean>;
  resumeFromGesture():Promise<boolean>;
  retryFromGesture():Promise<boolean>;
  setMuted(muted:boolean):void;
  getDiagnostics():{paused:boolean;muted:boolean;playsInline:boolean;currentTime:number|null;duration:number|null;readyState:number;networkState:number;width:number;height:number;errorCode:number|null;decodedFrames:number|null;droppedFrames:number|null;loop:boolean;ended:boolean;loopRecoveries:number;playbackPath?:'native'|'wechat-bridge'|null;wechatRecoveryAttempts?:number};
  pause():void;
  observeFrames(callback:(frame:{presentedFrames:number;mediaTime:number})=>void):boolean;
  cancelFrames():void;
  awaitPresentableFrame(callback:(frame:{signal:'video-frame-callback'|'time-progress';mediaTime:number|null;presentedFrames:number|null;decodedFrames:number|null})=>void):'video-frame-callback'|'time-progress';
  cancelPresentable():void;
  stop():void;
  dispose():void;
}
