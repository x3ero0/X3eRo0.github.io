// Bounded pool, shared scenes, batched messages, and measured CPU duty limits.
const groups=new Map();
const limit=Math.min(2,Math.max(1,Math.floor((navigator.hardwareConcurrency || 2)/2)));
const duty=.35;
let sequence=0;

class Slot {
  constructor(group) {
    this.group=group;this.clients=new Map();this.qualities=new Map();this.queue=[];this.active=null;this.nextAt=0;this.timer=0;this.frames=0;this.cacheHits=0;this.residentBytes=0;
    this.worker=new Worker(group.url,{type:'module'});
    this.worker.onmessage=({data})=>{
      const active=this.active;this.active=null;
      if(!active)return;
      this.residentBytes=data.residentBytes || 0;
      this.nextAt=performance.now()+(data.computeMs || 0)*(1/duty-1);
      const processed=new Set(data.results.map(result=>result.clientId));
      this.queue.unshift(...active.filter(job=>!processed.has(job.clientId)&&this.clients.has(job.clientId)));
      for(const result of data.results) {
        if(result.type==='frame'){this.frames++;if(result.cacheHit)this.cacheHits++;}
        const client=this.clients.get(result.clientId);
        if(client)client.onmessage?.({data:result});
      }
      this.kick();
    };
    this.worker.onerror=event=>{
      event.preventDefault();
      for(const client of Array.from(this.clients.values()))client.onerror?.(event);
    };
  }
  kick() {
    if(this.active||this.timer||!this.queue.length)return;
    const wait=this.nextAt-performance.now();
    if(wait>1){this.timer=setTimeout(()=>{this.timer=0;this.kick();},wait);return;}
    this.timer=-1;
    queueMicrotask(()=>{
      if(this.timer!==-1)return;
      this.timer=0;
      if(this.active||!this.queue.length)return;
      this.active=this.queue.splice(0,16);
      this.worker.postMessage({type:'batch',jobs:this.active,budgetMs:8});
    });
  }
  remove(client) {
    this.clients.delete(client.id);this.queue=this.queue.filter(job=>job.clientId!==client.id);
    this.worker.postMessage({type:'drop',clientId:client.id});
    if(!Array.from(this.clients.values()).some(c=>c.key===client.key))this.group.models.delete(client.key);
    if(!this.clients.size) {
      if(this.timer>0)clearTimeout(this.timer);this.timer=0;
      this.worker.terminate();this.group.slots=this.group.slots.filter(slot=>slot!==this);
      if(!this.group.slots.length)groups.delete(this.group.url);
    }
  }
}

export function createRendererClient(workerURL,key) {
  const url=new URL(workerURL,document.baseURI).href;
  if(!groups.has(url))groups.set(url,{url,slots:[],models:new Map()});
  const group=groups.get(url);
  let slot=group.models.get(key);
  if(!slot) {
    slot=group.slots.length<limit?new Slot(group):group.slots.reduce((a,b)=>a.clients.size<=b.clients.size?a:b);
    if(!group.slots.includes(slot))group.slots.push(slot);
    group.models.set(key,slot);
  }
  const client={id:++sequence,key,slot,onmessage:null,onerror:null,active:false,workload:'',fps:60,
    postMessage(data) {
      if(data.canvas) {
        slot.worker.postMessage({...data,type:'attach',clientId:this.id,key:this.key},[data.canvas]);
        data={...data};delete data.canvas;
      }
      slot.queue.push({...data,clientId:this.id,key:this.key});slot.kick();
    },
    suspend() {
      const queued=slot.queue.some(job=>job.clientId===this.id&&job.type==='render');
      slot.queue=slot.queue.filter(job=>job.clientId!==this.id||job.type!=='render');
      this.active=false;
      if(queued)this.onmessage?.({data:{type:'cancelled'}});
    },
    budgetMs() {
      const active=Array.from(slot.clients.values()).filter(c=>c.active);
      const count=Math.max(1,new Set(active.map(c=>c.workload)).size);
      // Reserve part of the budget for canvas uploads and message overhead.
      return 1000*duty*.75/(Math.max(this.fps,...active.map(c=>c.fps))*count);
    },
    quality() {
      let state=slot.qualities.get(this.workload);
      if(!state) {
        state={scale:1,bad:0,good:0};slot.qualities.set(this.workload,state);
        if(slot.qualities.size>128)slot.qualities.delete(slot.qualities.keys().next().value);
      }
      return state;
    },
    terminate(){if(!this.terminated){this.terminated=true;slot.remove(this);}}
  };
  slot.clients.set(client.id,client);return client;
}

/** Diagnostics for integration tests and pages with many models. */
export function rendererPoolStats() {
  const slots=Array.from(groups.values()).flatMap(group=>group.slots);
  return {workers:slots.length,workerLimit:limit,views:slots.reduce((n,s)=>n+s.clients.size,0),
    queued:slots.reduce((n,s)=>n+s.queue.length,0),inFlight:slots.filter(s=>s.active).length,cpuDuty:duty,
    frames:slots.reduce((n,s)=>n+s.frames,0),cacheHits:slots.reduce((n,s)=>n+s.cacheHits,0),residentBytes:slots.reduce((n,s)=>n+s.residentBytes,0)};
}
