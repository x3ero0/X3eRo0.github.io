import {scheduleFrame,cancelFrame} from './frame-clock.js';
import {createRendererClient,rendererPoolStats} from './worker-pool.js';
export {rendererPoolStats};
const owners=new WeakMap();
const TAU=Math.PI*2;
const bounded=(value,min,max,name)=>{
  if(!Number.isFinite(value)||value<min||value>max)throw new TypeError(`${name} must be between ${min} and ${max}.`);
  return value;
};

/** Responsive, transparent Wasm-rendered GLB inside a normal page container. */
export class ModelView extends EventTarget {
  constructor(container,options={}) {
    super();
    if(!(container instanceof HTMLElement)||container instanceof HTMLCanvasElement)throw new TypeError('Pass a page container element.');
    if(owners.has(container))throw new Error('This container already has a ModelView.');
    if(!options.model)throw new TypeError('A model URL is required.');
    this.options={resolution:'native',pixelRatio:null,maxPixels:4_000_000,ps1:true,perspectiveCorrect:false,antialias:0,textureFilter:'auto',vertexSnap:null,textureWarp:null,lighting:'studio',ditherResolution:0,fps:60,autoplay:true,interactive:true,adaptive:true,lazy:true,...options};
    if(![0,4,8].includes(this.options.antialias))throw new TypeError('antialias must be 0, 4, or 8 coverage samples.');
    if(!['auto','nearest','linear'].includes(this.options.textureFilter))throw new TypeError('textureFilter must be auto, nearest, or linear.');
    if(!['studio','vertex'].includes(this.options.lighting))throw new TypeError('lighting must be studio or vertex.');
    if(this.options.vertexSnap!==null)bounded(this.options.vertexSnap,0,16384,'vertexSnap');
    if(this.options.textureWarp!==null)bounded(this.options.textureWarp,0,1,'textureWarp');
    bounded(this.options.ditherResolution,0,16384,'ditherResolution');
    if(this.options.resolution!=='native')bounded(this.options.resolution,1,16384,'resolution');
    if(this.options.pixelRatio!==null)bounded(this.options.pixelRatio,.125,4,'pixelRatio');
    bounded(this.options.maxPixels,1,16_777_216,'maxPixels');bounded(this.options.fps,1,60,'fps');
    this.container=container;this.pose={yaw:0,pitch:-.08,zoom:1};
    this.state='loading';this.error=null;
    this.stats={frames:0,width:0,height:0,memoryBytes:0,triangles:0,lastFrameMs:0};
    this._dirty=true;this._busy=false;this._visible=false;this._lastRequest=0;this._id=0;this._heldUntil=0;
    this._spinOffset=0;this._quality=1;this._size=null;
    this._duration=12;this._listeners=new AbortController();
    this._motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.playing=this.options.autoplay&&!this._motion.matches;
    this._resolve=null;this._reject=null;
    this.ready=new Promise((resolve,reject)=>{this._resolve=resolve;this._reject=reject;});
    // Consumers can use either ready.catch() or the error event, without warnings.
    this.ready.catch(()=>{});
    this.canvas=document.createElement('canvas');
    this.canvas.className='wasm-model-canvas';this.canvas.dataset.state='loading';
    this.canvas.setAttribute('role','img');
    this.canvas.setAttribute('aria-label',options.label || 'Spinning 3D model. Drag to turn; scroll to zoom; Space pauses.');
    this.canvas.tabIndex=this.options.interactive?0:-1;
    Object.assign(this.canvas.style,{position:'absolute',inset:'0',display:'block',width:'100%',height:'100%',background:'transparent',imageRendering:this.options.ps1&&!this.options.antialias?'pixelated':'auto',touchAction:this.options.interactive?'none':'auto'});
    this._previousPosition=container.style.position;
    this._positionChanged=getComputedStyle(container).position==='static';
    if(this._positionChanged)container.style.position='relative';
    container.append(this.canvas);owners.set(container,this);
    try {
      if(typeof WebAssembly==='undefined'||typeof Worker==='undefined'||!this.canvas.transferControlToOffscreen)throw new Error('WebAssembly, workers, and OffscreenCanvas are required.');
      this._resizeObserver=new ResizeObserver(()=>this.resize());this._resizeObserver.observe(container);
      this._intersectionObserver=new IntersectionObserver(entries=>{
        this._visible=entries[0].isIntersecting;
        if(this._visible){this._start();this.resize();}else {this._stopTick();this._worker?.suspend();}
      });this._intersectionObserver.observe(container);
      const signal=this._listeners.signal;
      window.addEventListener('resize',()=>this.resize(),{signal});
      document.addEventListener('visibilitychange',()=>{
        if(document.hidden){this._stopTick();this._worker?.suspend();}else {if(this._visible)this._start();this.resize();}
      },{signal});
      this._motion.addEventListener('change',event=>{if(event.matches)this.pause();},{signal});
      window.addEventListener('pagehide',event=>{if(event.persisted)this._stopTick();else this.dispose();},{signal});
      window.addEventListener('pageshow',()=>this.resize(),{signal});
      if(this.options.interactive)this._input(signal);
      if(!this.options.lazy)this._start();
    }catch(error){queueMicrotask(()=>this._fail(error));}
  }

  _start() {
    if(this._worker||['error','disposed'].includes(this.state)||document.hidden&&this.options.lazy)return;
    try {
      const wasm=new URL(this.options.wasm || './renderer.wasm',this.options.wasm?document.baseURI:import.meta.url).href;
      const model=new URL(this.options.model,document.baseURI).href;
      this._worker=createRendererClient(this.options.worker || new URL('./renderer-worker.js',import.meta.url),`${wasm}|${model}`);
      this._worker.onmessage=event=>this._message(event.data);
      this._worker.onerror=event=>this._fail(new Error(event.message || 'Renderer worker failed.'));
      this._worker.fps=this.options.fps;
      this._timeout=setTimeout(()=>this._fail(new Error('Model loading timed out.')),30000);
      this._worker.postMessage({type:'init',wasm,model,canvas:this.canvas.transferControlToOffscreen()});
    }catch(error){this._fail(error);}
  }

  _dimensions() {
    const box=this._size || (this._size=this.container.getBoundingClientRect());
    if(box.width<=0||box.height<=0)return null;
    const ratio=this.options.pixelRatio ?? Math.min(devicePixelRatio || 1,2);
    let width=Math.max(1,Math.round(box.width*ratio)),height=Math.max(1,Math.round(box.height*ratio));
    let maxEdge=this.options.resolution==='native'?16384:this.options.resolution;
    if(this.options.adaptive&&this.playing)maxEdge=Math.min(maxEdge,512);
    let factor=Math.min(1,maxEdge/Math.max(width,height),Math.sqrt(this.options.maxPixels/(width*height)));
    if(this.options.adaptive&&this.playing)factor*=this._quality;
    width=Math.max(1,Math.floor(width*factor));height=Math.max(1,Math.floor(height*factor));
    return {width,height};
  }
  _stopTick(){cancelFrame(this);if(this._worker)this._worker.active=false;}
  _schedule() {
    if(this._workerReady&&this._visible&&!document.hidden&&!['error','disposed'].includes(this.state))scheduleFrame(this);
  }
  _tick(now) {
    if(!this._visible||document.hidden||['error','disposed'].includes(this.state))return;
    if(this._busy)return;
    if(this.playing) {
      if(this._gesture||now<this._heldUntil)this._spinOffset=this.pose.yaw-now*.001*TAU/this._duration;
      else this.pose.yaw=(this._spinOffset+now*.001*TAU/this._duration)%TAU;
      this._dirty=true;
    }
    if(!this._size)this._size=this.container.getBoundingClientRect();
    this._worker.active=this.playing||this._dirty;
    this._worker.workload=`${this._worker.key}:${this._size.width}:${this._size.height}:${this.options.resolution}:${this.options.pixelRatio ?? devicePixelRatio}:${this.options.maxPixels}:${this.options.fps}:${this.options.adaptive}:${this.options.ps1}:${this.options.perspectiveCorrect}:${this.options.antialias}:${this.options.textureFilter}:${this.options.vertexSnap}:${this.options.textureWarp}:${this.options.lighting}:${this.options.ditherResolution}:${this._spinOffset}:${this.pose.pitch}:${this.pose.zoom}`;
    if(this.options.adaptive)this._quality=this._worker.quality().scale;
    if(this._dirty&&!this._busy&&now-this._lastRequest>=1000/this.options.fps-.5) {
      const size=this._dimensions();
      if(size) {
        this._busy=true;this._dirty=false;this._lastRequest=now;
        this._pending={...size,...this.pose,id:++this._id,start:performance.now(),qualityScale:this.options.adaptive&&this.playing?this._quality:1,animated:this.playing,workload:this._worker.workload};
        this._timeout=setTimeout(()=>this._fail(new Error('Model rendering timed out.')),15000);
        this._worker.postMessage({type:'render',...this._pending,ps1:this.options.ps1,perspectiveCorrect:this.options.perspectiveCorrect,antialias:this.options.antialias,
          textureFilter:this.options.textureFilter,vertexSnap:this.options.vertexSnap,textureWarp:this.options.textureWarp,lighting:this.options.lighting,ditherResolution:this.options.ditherResolution});
      }else {this._stopTick();return;}
    }
    if(!this._busy&&(this.playing||this._dirty))this._schedule();
  }
  _message(data) {
    if(['error','disposed'].includes(this.state))return;
    clearTimeout(this._timeout);
    if(data.type==='error'){this._fail(new Error(data.message));return;}
    if(data.type==='cancelled'){this._busy=false;this._dirty=true;this._schedule();return;}
    if(data.type==='ready') {
      this._workerReady=true;this._duration=data.duration;
      this.stats.triangles=data.triangles;this.stats.memoryBytes=data.memoryBytes || 0;
      this.options.maxPixels=Math.min(this.options.maxPixels,data.maxPixels);
      this.state='loaded';this.canvas.dataset.state='loaded';
      this._resolve(this);this._resolve=this._reject=null;
      this.dispatchEvent(new CustomEvent('ready',{detail:{triangles:data.triangles,duration:data.duration}}));this.resize();
    } else if(data.type==='frame') {
      this._busy=false;
      if(data.id!==this._pending?.id){this._fail(new Error('Unexpected frame response.'));return;}
      this.stats={...this.stats,width:data.width,height:data.height,frames:this.stats.frames+1,lastFrameMs:performance.now()-this._pending.start,memoryBytes:data.memoryBytes,renderMs:data.renderMs,copyMs:data.copyMs,cacheHit:data.cacheHit,qualityScale:this._pending.qualityScale};
      const quality=this._worker.quality();
      if(this.options.adaptive&&this.playing&&this._pending.animated&&!data.cacheHit&&data.renderMs>0&&quality.scale===this._pending.qualityScale&&this._pending.workload===this._worker.workload) {
        const budget=this._worker.budgetMs(),minimum=Math.min(1,96/(Math.max(1,Math.min(data.width,data.height))/this._pending.qualityScale));
        if(data.renderMs>budget*1.3) {
          quality.good=0;
          if(++quality.bad>=2){quality.scale=Math.max(minimum,quality.scale*Math.max(.65,Math.sqrt(budget/data.renderMs)));quality.bad=0;}
        }else {
          quality.bad=0;
          if(data.renderMs<budget*.65&&++quality.good>=120){quality.scale=Math.min(1,quality.scale*1.08);quality.good=0;}
        }
      }
      this.state='ready';this.canvas.dataset.state='ready';
      this.canvas.dataset.yaw=String(this._pending.yaw);
      if(!this.playing&&!this._dirty)this._worker.active=false;
      this.dispatchEvent(new CustomEvent('frame',{detail:{...this.stats,...this._pending}}));
      if(this._dirty||this.playing)this._schedule();
    }
  }
  _fail(error) {
    if(this.state==='disposed'||this.state==='error')return;
    this.error=error;this.state='error';this.canvas.dataset.state='error';this.playing=false;
    clearTimeout(this._timeout);this._stopTick();this._worker?.terminate();this._listeners.abort();
    this._resizeObserver?.disconnect();this._intersectionObserver?.disconnect();
    this._reject?.(error);this._reject=this._resolve=null;
    this.dispatchEvent(new CustomEvent('error',{detail:error}));
  }
  _input(signal) {
    const canvas=this.canvas;
    canvas.addEventListener('pointerdown',event=>{
      if(this.state!=='ready'||!event.isPrimary||event.button!==0||this._gesture)return;
      this._gesture={id:event.pointerId,x:event.clientX,y:event.clientY};
      canvas.setPointerCapture(event.pointerId);canvas.focus({preventScroll:true});
    },{signal});
    canvas.addEventListener('pointermove',event=>{
      if(this._gesture?.id!==event.pointerId)return;
      this.pose.yaw=(this.pose.yaw+(event.clientX-this._gesture.x)*.012)%TAU;
      this.pose.pitch=(this.pose.pitch+(event.clientY-this._gesture.y)*.012)%TAU;
      this._gesture.x=event.clientX;this._gesture.y=event.clientY;this.resize();
    },{signal});
    const release=()=>{if(this._gesture)this._heldUntil=performance.now()+2500;this._gesture=null;};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,release,{signal});
    canvas.addEventListener('wheel',event=>{
      if(event.ctrlKey||this.state!=='ready')return;
      event.preventDefault();this.pose.zoom=Math.max(.25,Math.min(2,this.pose.zoom*Math.exp(-Math.sign(event.deltaY)*.08)));
      this._heldUntil=performance.now()+2500;this.resize();
    },{signal,passive:false});
    canvas.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey||this.state!=='ready')return;
      switch(event.key.toLowerCase()) {
        case ' ':event.preventDefault();if(!event.repeat)this.playing?this.pause():this.play();return;
        case 'arrowleft':this.pose.yaw-=.15;break;
        case 'arrowright':this.pose.yaw+=.15;break;
        case 'arrowup':this.pose.pitch-=.15;break;
        case 'arrowdown':this.pose.pitch+=.15;break;
        case 'f':this.front();break;
        case 'b':this.back();break;
        case 'r':this.setPose({yaw:0,pitch:-.08,zoom:1});break;
        case '+':case '=':this.pose.zoom=Math.min(2,this.pose.zoom+.1);break;
        case '-':this.pose.zoom=Math.max(.25,this.pose.zoom-.1);break;
        default:return;
      }
      event.preventDefault();this._heldUntil=performance.now()+2500;this.resize();
    },{signal});
  }
  resize(){this._size=null;this._dirty=true;this._schedule();return this;}
  setSize(width,height){bounded(width,1,1000000,'width');bounded(height,1,1000000,'height');this.container.style.width=`${width}px`;this.container.style.height=`${height}px`;return this.resize();}
  setResolution(value){if(value!=='native')bounded(value,1,16384,'resolution');this.options.resolution=value;return this.resize();}
  setPixelRatio(value){if(value!==null)bounded(value,.125,4,'pixelRatio');this.options.pixelRatio=value;return this.resize();}
  setPose(pose){
    for(const key of ['yaw','pitch','zoom'])if(pose[key]!==undefined&&!Number.isFinite(pose[key]))throw new TypeError(`Invalid ${key}.`);
    for(const key of ['yaw','pitch','zoom'])if(pose[key]!==undefined)this.pose[key]=pose[key];
    this.pose.yaw%=TAU;this.pose.pitch%=TAU;this.pose.zoom=Math.max(.25,Math.min(2,this.pose.zoom));this._spinOffset=this.pose.yaw-performance.now()*.001*TAU/this._duration;return this.resize();
  }
  front(){this.pause();return this.setPose({yaw:0,pitch:0,zoom:1});}
  back(){this.pause();return this.setPose({yaw:Math.PI,pitch:0,zoom:1});}
  play(){if(!['error','disposed'].includes(this.state)){if(!this.playing)this._spinOffset=this.pose.yaw-performance.now()*.001*TAU/this._duration;this.playing=true;this._heldUntil=0;this._schedule();}return this;}
  pause(){this.playing=false;this._dirty=true;this._schedule();return this;}
  dispose(){
    if(this.state==='disposed')return;
    this.state='disposed';this.playing=false;clearTimeout(this._timeout);this._stopTick();
    this._worker?.terminate();this._listeners.abort();this._resizeObserver?.disconnect();this._intersectionObserver?.disconnect();
    this._reject?.(new DOMException('ModelView was disposed.','AbortError'));this._reject=this._resolve=null;
    this.canvas.remove();owners.delete(this.container);
    if(this._positionChanged&&this.container.style.position==='relative')this.container.style.position=this._previousPosition;
  }
}

export async function createModelView(container,options){const view=new ModelView(container,options);await view.ready;return view;}
