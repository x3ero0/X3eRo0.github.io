import {loadGLB} from './glb.js';
import {installScene} from './wasm-scene.js';

const clients=new Map(),scenes=new Map(),modules=new Map();
const maxResidentBytes=64*1024*1024;
async function moduleFor(url) {
  if(!modules.has(url))modules.set(url,(async()=>{
    const response=await fetch(url);if(!response.ok)throw new Error(`Wasm request failed (${response.status}).`);
    return WebAssembly.compile(await response.arrayBuffer());
  })());
  return modules.get(url);
}
function prune(keep) {
  let total=0;
  for(const scene of scenes.values())total+=scene.renderer.memory.buffer.byteLength;
  for(const [key,scene] of scenes) {
    if(total<=maxResidentBytes&&scenes.size<=16)break;
    if(key===keep)continue;
    total-=scene.renderer.memory.buffer.byteLength;scenes.delete(key);
  }
}
async function sceneFor(client) {
  if(scenes.has(client.key)) {
    const scene=scenes.get(client.key);scenes.delete(client.key);scenes.set(client.key,scene);return scene;
  }
  const [module,data]=await Promise.all([moduleFor(client.wasm),loadGLB(client.model)]);
  const renderer=new WebAssembly.Instance(module,{}).exports,result=installScene(renderer,data);
  const scene={renderer,...result,signature:'',image:null,renderMs:0};
  scenes.set(client.key,scene);prune(client.key);return scene;
}
async function handle(data) {
  const client=clients.get(data.clientId);if(!client)return {type:'cancelled'};
  if(!client.context)throw new Error('Worker Canvas 2D is unavailable.');
  if(data.type==='init') {
    const scene=await sceneFor(client);
    return {type:'ready',triangles:scene.triangles,maxPixels:scene.maxPixels,duration:scene.duration,memoryBytes:scene.renderer.memory.buffer.byteLength};
  }
  const scene=await sceneFor(client),r=scene.renderer;
  const {width,height,yaw,pitch,zoom,ps1,perspectiveCorrect,antialias=0,textureFilter='auto',vertexSnap=null,textureWarp=null,lighting='studio',ditherResolution=0}=data;
  const signature=[width,height,yaw,pitch,zoom,ps1,perspectiveCorrect,antialias,textureFilter,vertexSnap,textureWarp,lighting,ditherResolution].join(',');
  const start=performance.now(),cacheHit=scene.signature===signature;
  if(!cacheHit) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||!Number.isFinite(yaw)||!Number.isFinite(pitch)||
      !r.set_style(textureFilter==='auto'?-1:textureFilter==='linear'?1:0,vertexSnap??-1,textureWarp??-1,lighting==='vertex'?1:0,ditherResolution)||
      !r.resize(width,height,antialias)||!r.render(Math.cos(yaw),Math.sin(yaw),Math.cos(pitch),Math.sin(pitch),zoom,ps1?1:0,perspectiveCorrect?1:0))throw new Error('Invalid render dimensions or pose.');
    scene.renderMs=performance.now()-start;scene.signature=signature;
    if(!scene.image||scene.image.data.buffer!==r.memory.buffer||scene.imagePointer!==r.pixels_ptr()||scene.image.width!==width||scene.image.height!==height) {
      scene.image=new ImageData(new Uint8ClampedArray(r.memory.buffer,r.pixels_ptr(),width*height*4),width,height);
      scene.imagePointer=r.pixels_ptr();
    }
  }
  if(client.canvas.width!==width)client.canvas.width=width;
  if(client.canvas.height!==height)client.canvas.height=height;
  const copyStart=performance.now();client.context.putImageData(scene.image,0,0);
  prune(client.key);
  return {type:'frame',width,height,id:data.id,memoryBytes:r.memory.buffer.byteLength,
    renderMs:scene.renderMs,copyMs:performance.now()-copyStart,cacheHit,computeMs:performance.now()-start};
}

self.onmessage=async({data})=>{
  if(data.type==='attach') {
    const context=data.canvas.getContext('2d',{alpha:true,desynchronized:true});
    clients.set(data.clientId,{key:data.key,wasm:data.wasm,model:data.model,canvas:data.canvas,context});
    return;
  }
  if(data.type==='drop') {
    const client=clients.get(data.clientId);clients.delete(data.clientId);
    if(client&&!Array.from(clients.values()).some(c=>c.key===client.key))scenes.delete(client.key);
    return;
  }
  if(data.type!=='batch')return;
  const results=[];let computeMs=0;
  for(const job of data.jobs) {
    try {const result=await handle(job);results.push({...result,clientId:job.clientId});computeMs+=result.computeMs || 0;}
    catch(error){results.push({type:'error',clientId:job.clientId,message:error.message || String(error)});}
    // A batch stops before monopolizing a worker. Remaining jobs stay queued.
    if(computeMs>=data.budgetMs)break;
  }
  let residentBytes=0;for(const scene of scenes.values())residentBytes+=scene.renderer.memory.buffer.byteLength;
  self.postMessage({results,computeMs,residentBytes});
};
