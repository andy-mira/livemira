/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Experimental control model. Measurements are supplied by tests, not images.
export class TrackingExperiment {
  constructor(sessionId) { this.reset(sessionId); }
  reset(sessionId) {
    this.sessionId=sessionId; this.state='SEARCHING'; this.target=null;
    this.lastFrame=-1; this.lastTime=-1; this.lastImage=null; this.lastGood=null;
    this.candidate=null; this.count=0; this.firstTime=0;
  }
  snapshot(now,reason) {
    const age=this.lastGood===null?null:now-this.lastGood.time;
    const visible=['TRACKING','LIMITED'].includes(this.state) && age!==null && age<100000;
    return {state:this.state,target:this.target,h:visible?[...this.lastGood.h]:null,
      predicted:visible && (age>0 || reason!=='measured'),predictionAgeUs:age,reason,
      pose:null,poseMetricValid:false};
  }
  tick(now) {
    if(!Number.isFinite(now)||now<this.lastTime)return this.snapshot(this.lastTime,'clock-rejected');
    this.lastTime=now;
    if(['TRACKING','LIMITED'].includes(this.state)) {
      if(now-this.lastGood.time>=100000) {this.state='LOST';return this.snapshot(now,'prediction-expired');}
      this.state='LIMITED';
    }
    return this.snapshot(now,'prediction-hold');
  }
  update({sessionId,frameId,imageId,time,target=null,h=null,good=false}) {
    if(sessionId!==this.sessionId)return this.snapshot(this.lastTime,'stale-session');
    if(!Number.isFinite(time)||time<this.lastTime||frameId<=this.lastFrame)
      return this.snapshot(this.lastTime,'stale-frame-or-clock');
    const duplicate=imageId===this.lastImage;
    this.lastFrame=frameId;this.lastImage=imageId;this.lastTime=time;
    good=good && !duplicate && target!==null && Array.isArray(h) && h.length===9 && h.every(Number.isFinite);
    if(this.state==='LOST') {this.state='SEARCHING';this.target=null;this.lastGood=null;this.candidate=null;this.count=0;}
    if(['TRACKING','LIMITED'].includes(this.state)) {
      if(time-this.lastGood.time>=100000) {
        this.state='LOST';return this.snapshot(time,'prediction-expired');
      }
      if(good && target===this.target) {
        this.state='TRACKING';this.lastGood={h:[...h],time};return this.snapshot(time,'measured');
      }
      return this.tick(time);
    }
    if(!good) {
      if(!duplicate) {this.state='SEARCHING';this.candidate=null;this.count=0;}
      return this.snapshot(time,duplicate?'duplicate-image':'no-valid-measurement');
    }
    if(this.candidate!==target || time-this.firstTime>250000) {
      this.candidate=target;this.count=0;this.firstTime=time;
    }
    this.count++;this.state='ACQUIRING';
    if(this.count>=3 && time-this.firstTime>=50000) {
      this.state='TRACKING';this.target=target;this.lastGood={h:[...h],time};
    }
    return this.snapshot(time,'measured');
  }
}
