export function installScene(renderer,scene) {
  renderer.reset();
  const allocate=bytes=>{const pointer=renderer.alloc(bytes);if(!pointer)throw new Error('Renderer memory limit exceeded.');return pointer;};
  const copy=array=>{
    const pointer=allocate(array.byteLength);
    new Uint8Array(renderer.memory.buffer,pointer,array.byteLength).set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));
    return pointer;
  };
  const lut=new Float32Array(renderer.memory.buffer,renderer.color_lut_ptr(),256);
  for(let i=0;i<256;i++){const c=i/255;lut[i]=c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}
  const vp=copy(scene.vertices),ip=copy(scene.indices),tp=copy(scene.triangleMaterials);
  const materialBytes=new ArrayBuffer(scene.materials.length*64),m=new DataView(materialBytes);
  scene.materials.forEach((material,i)=>{
    const floats=[...material.base,material.metal,material.rough,material.normalScale,material.transmission,material.clearcoat,material.clearRough,material.ior];
    floats.forEach((v,j)=>m.setFloat32(i*64+j*4,v,true));
    [material.colorTex,material.normalTex,material.roughTex,material.transmissionTex].forEach((v,j)=>m.setInt32(i*64+44+j*4,v,true));
    m.setFloat32(i*64+60,material.alphaCutoff,true);
  });
  const mp=copy(new Uint8Array(materialBytes));
  const table=new Uint32Array(scene.textures.length*4);
  scene.textures.forEach((texture,i)=>table.set([copy(texture.pixels),texture.width,texture.height,texture.wrap],i*4));
  const xp=table.byteLength?copy(table):0;
  const triangles=renderer.bind_scene(vp,scene.vertices.length/8,ip,tp,scene.indices.length/3,mp,scene.materials.length,xp,scene.textures.length);
  if(!triangles)throw new Error('Invalid or unsupported model data.');
  return {triangles,maxPixels:renderer.max_pixels(),duration:scene.duration};
}
