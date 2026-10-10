// A deliberately small static GLB loader. Rendering happens entirely in Wasm.
const limits = { bytes: 64 * 1024 * 1024, vertices: 1_000_000, triangles: 1_000_000 };
const identity = () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const finite = (values, name) => { if (!values.every(Number.isFinite)) throw new Error(`Nonfinite ${name}.`); return values; };

export function parseGLB(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (bytes.byteLength < 20 || bytes.byteLength > limits.bytes) throw new Error('Invalid GLB file size.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0,true) !== 0x46546c67 || view.getUint32(4,true) !== 2 || view.getUint32(8,true) !== bytes.byteLength) throw new Error('Expected a complete GLB version 2 file.');
  let json, binary;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('Truncated GLB chunk header.');
    const length = view.getUint32(offset,true), type = view.getUint32(offset+4,true);
    if (length % 4 || offset + 8 + length > bytes.byteLength) throw new Error('Invalid GLB chunk length.');
    const chunk = bytes.subarray(offset+8,offset+8+length);
    if (type === 0x4e4f534a) { if (json) throw new Error('Duplicate GLB JSON.'); json = JSON.parse(new TextDecoder().decode(chunk)); }
    if (type === 0x004e4942) { if (binary) throw new Error('Duplicate GLB binary.'); binary = chunk; }
    offset += 8 + length;
  }
  if (!json || !binary || json.asset?.version !== '2.0') throw new Error('GLB JSON or binary is missing.');
  if (json.buffers?.length !== 1 || json.buffers[0].uri || json.buffers[0].byteLength > binary.byteLength) throw new Error('Use a self-contained GLB with one embedded buffer.');
  const supported = new Set(['KHR_materials_transmission','KHR_materials_volume','KHR_materials_clearcoat','KHR_materials_ior']);
  for (const extension of json.extensionsRequired || []) if (!supported.has(extension)) throw new Error(`Unsupported required extension: ${extension}`);
  return { json, binary };
}

function bufferView(file, index) {
  const value = file.json.bufferViews?.[index];
  if (!value || value.buffer !== 0 || !Number.isInteger(value.byteLength) || value.byteLength < 0) throw new Error('Invalid GLB buffer view.');
  const start = value.byteOffset || 0;
  if (!Number.isInteger(start) || start < 0 || start + value.byteLength > file.json.buffers[0].byteLength) throw new Error('GLB buffer view is out of bounds.');
  return { definition:value, bytes:file.binary.subarray(start,start+value.byteLength) };
}

export function readAccessor(file, index) {
  const accessor = file.json.accessors?.[index];
  if (!accessor || accessor.sparse || accessor.bufferView === undefined) throw new Error('Sparse or missing GLB accessors are unsupported.');
  const components = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[accessor.type];
  const types = {5120:[1,'getInt8'],5121:[1,'getUint8'],5122:[2,'getInt16'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']};
  const type = types[accessor.componentType];
  if (!components || !type || !Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > limits.vertices * 3) throw new Error('Unsupported GLB accessor format or count.');
  const source = bufferView(file,accessor.bufferView), componentBytes = type[0];
  const stride = source.definition.byteStride || componentBytes * components;
  const start = accessor.byteOffset || 0;
  if (!Number.isInteger(start) || start < 0 || start % componentBytes || stride < componentBytes*components || stride % componentBytes || start + (accessor.count-1)*stride + componentBytes*components > source.bytes.byteLength) throw new Error('GLB accessor is out of bounds.');
  const view = new DataView(source.bytes.buffer,source.bytes.byteOffset,source.bytes.byteLength);
  const values = new Float64Array(accessor.count*components);
  for (let i=0;i<accessor.count;i++) for(let j=0;j<components;j++) {
    let value = view[type[1]](start+i*stride+j*componentBytes,true);
    if (accessor.normalized && accessor.componentType !== 5126) {
      if (accessor.componentType===5120) value=Math.max(-1,value/127);
      else if (accessor.componentType===5122) value=Math.max(-1,value/32767);
      else value/=({5121:255,5123:65535,5125:4294967295}[accessor.componentType]);
    }
    if (!Number.isFinite(value)) throw new Error('Nonfinite GLB accessor data.');
    values[i*components+j]=value;
  }
  return {values,count:accessor.count,components,componentType:accessor.componentType};
}

function multiply(a,b) {
  return Array.from({length:16},(_,index) => {
    const row=index%4,column=Math.floor(index/4);
    return a[row]*b[column*4]+a[row+4]*b[column*4+1]+a[row+8]*b[column*4+2]+a[row+12]*b[column*4+3];
  });
}
function nodeMatrix(node) {
  if (node.matrix) { if(node.matrix.length!==16)throw new Error('Invalid node matrix.'); return finite(node.matrix,'node matrix'); }
  const t=node.translation || [0,0,0],s=node.scale || [1,1,1],q=node.rotation || [0,0,0,1];
  if(t.length!==3||s.length!==3||q.length!==4)throw new Error('Invalid node transform.');
  finite([...t,...s,...q],'node transform');
  const length=Math.hypot(...q);if(length<1e-12)throw new Error('Invalid node rotation.');
  const [x,y,z,w]=q.map(v=>v/length);
  return [(1-2*(y*y+z*z))*s[0],2*(x*y+z*w)*s[0],2*(x*z-y*w)*s[0],0,
    2*(x*y-z*w)*s[1],(1-2*(x*x+z*z))*s[1],2*(y*z+x*w)*s[1],0,
    2*(x*z+y*w)*s[2],2*(y*z-x*w)*s[2],(1-2*(x*x+y*y))*s[2],0,...t,1];
}
function normalMatrix(m) {
  const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(Math.abs(det)<1e-20)throw new Error('Singular node transform.');
  return {det,values:[(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,
    (c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,(b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det]};
}
const normalized = v => {const n=Math.hypot(...v);return n>1e-20?v.map(x=>x/n):[0,0,1];};

export function extractGeometry(file) {
  const vertices=[],indices=[],triangleMaterials=[];
  const nodes=file.json.nodes || [],scene=file.json.scenes?.[file.json.scene || 0];
  if(!scene || nodes.length>10000)throw new Error('Missing or oversized GLB scene.');
  const active=new Set();
  function visit(index,parent) {
    const node=nodes[index];if(!node||active.has(index))throw new Error('Invalid or cyclic node hierarchy.');
    if(node.skin!==undefined)throw new Error('Skinned models are unsupported.');
    active.add(index);const matrix=multiply(parent,nodeMatrix(node)),normal=normalMatrix(matrix);
    if(node.mesh!==undefined) {
      const mesh=file.json.meshes?.[node.mesh];if(!mesh)throw new Error('Invalid mesh.');
      for(const primitive of mesh.primitives) {
        if((primitive.mode ?? 4)!==4 || primitive.targets)throw new Error('Only static triangle primitives are supported.');
        const pos=readAccessor(file,primitive.attributes?.POSITION);
        if(pos.components!==3)throw new Error('POSITION must be VEC3.');
        const norm=primitive.attributes.NORMAL!==undefined?readAccessor(file,primitive.attributes.NORMAL):null;
        const uv=primitive.attributes.TEXCOORD_0!==undefined?readAccessor(file,primitive.attributes.TEXCOORD_0):null;
        if(norm && (norm.components!==3||norm.count!==pos.count) || uv && (uv.components!==2||uv.count!==pos.count))throw new Error('Mismatched vertex attributes.');
        const accessor=primitive.indices!==undefined?readAccessor(file,primitive.indices):null;
        if(accessor && (accessor.components!==1||![5121,5123,5125].includes(accessor.componentType)))throw new Error('Invalid index format.');
        const local=accessor?Array.from(accessor.values):Array.from({length:pos.count},(_,i)=>i);
        if(local.length%3)throw new Error('Triangle indices are incomplete.');
        if(vertices.length/8+pos.count>limits.vertices || indices.length/3+local.length/3>limits.triangles)throw new Error('Model exceeds geometry limits.');
        if(local.some(i=>!Number.isInteger(i)||i<0||i>=pos.count))throw new Error('Invalid vertex index.');
        const offset=vertices.length/8;
        for(let i=0;i<pos.count;i++) {
          const p=pos.values.subarray(i*3,i*3+3),n=norm?norm.values.subarray(i*3,i*3+3):[0,0,0],nm=normal.values;
          const point=[matrix[0]*p[0]+matrix[4]*p[1]+matrix[8]*p[2]+matrix[12],matrix[1]*p[0]+matrix[5]*p[1]+matrix[9]*p[2]+matrix[13],matrix[2]*p[0]+matrix[6]*p[1]+matrix[10]*p[2]+matrix[14]];
          const direction=norm?normalized([nm[0]*n[0]+nm[1]*n[1]+nm[2]*n[2],nm[3]*n[0]+nm[4]*n[1]+nm[5]*n[2],nm[6]*n[0]+nm[7]*n[1]+nm[8]*n[2]]):[0,0,0];
          vertices.push(...point,...direction,uv?uv.values[i*2]:0,uv?uv.values[i*2+1]:0);
        }
        const material=primitive.material ?? file.json.materials?.length ?? 0;
        for(let i=0;i<local.length;i+=3) {
          const face=normal.det<0?[local[i],local[i+2],local[i+1]]:local.slice(i,i+3);
          indices.push(...face.map(v=>v+offset));triangleMaterials.push(material);
          if(!norm) {
            const points=face.map(v=>vertices.slice((v+offset)*8,(v+offset)*8+3));
            const a=points[1].map((v,j)=>v-points[0][j]),b=points[2].map((v,j)=>v-points[0][j]);
            const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
            for(const vertex of face)for(let j=0;j<3;j++)vertices[(vertex+offset)*8+3+j]+=n[j];
          }
        }
        if(!norm)for(let i=0;i<pos.count;i++) {
          const start=(offset+i)*8+3,n=normalized(vertices.slice(start,start+3));
          for(let j=0;j<3;j++)vertices[start+j]=n[j];
        }
      }
    }
    for(const child of node.children || [])visit(child,matrix);
    active.delete(index);
  }
  for(const root of scene.nodes || [])visit(root,identity());
  if(!indices.length)throw new Error('GLB contains no triangles.');
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),triangleMaterials:new Uint32Array(triangleMaterials)};
}

function textureIndex(info,file) {
  if(!info)return -1;
  if((info.texCoord ?? 0)!==0 || info.extensions?.KHR_texture_transform)throw new Error('Only untransformed TEXCOORD_0 textures are supported.');
  if(!Number.isInteger(info.index)||!file.json.textures?.[info.index])throw new Error('Invalid material texture.');
  return info.index;
}
export function extractMaterials(file) {
  const definitions=[...(file.json.materials || []),{}];
  if(definitions.length>256)throw new Error('Too many materials.');
  return definitions.map(material=>{
    if(material.alphaMode==='BLEND' || material.doubleSided)throw new Error('Use opaque or alpha-mask materials with outward-facing geometry.');
    const pbr=material.pbrMetallicRoughness || {},extensions=material.extensions || {},volume=extensions.KHR_materials_volume || {};
    const base=pbr.baseColorFactor || [1,1,1,1];if(base.length!==4)throw new Error('Invalid base color.');
    return {base,metal:pbr.metallicFactor ?? 1,rough:pbr.roughnessFactor ?? 1,normalScale:material.normalTexture?.scale ?? 1,
      transmission:extensions.KHR_materials_transmission?.transmissionFactor ?? 0,clearcoat:extensions.KHR_materials_clearcoat?.clearcoatFactor ?? 0,
      clearRough:extensions.KHR_materials_clearcoat?.clearcoatRoughnessFactor ?? .08,ior:extensions.KHR_materials_ior?.ior ?? 1.5,
      colorTex:textureIndex(pbr.baseColorTexture,file),normalTex:textureIndex(material.normalTexture,file),roughTex:textureIndex(pbr.metallicRoughnessTexture,file),
      transmissionTex:textureIndex(extensions.KHR_materials_transmission?.transmissionTexture,file),alphaCutoff:material.alphaMode==='MASK'?(material.alphaCutoff ?? .5):0,
      // Volume parameters are recorded; Wasm currently approximates tinted transmission.
      attenuation:volume.attenuationColor || [1,1,1]};
  });
}

async function decodeImage(file,index) {
  const image=file.json.images?.[index];
  if(!image||image.bufferView===undefined||!['image/png','image/jpeg'].includes(image.mimeType))throw new Error('Embed PNG or JPEG textures inside the GLB.');
  if(typeof createImageBitmap!=='function'||typeof OffscreenCanvas==='undefined')throw new Error('This browser needs worker image decoding and OffscreenCanvas 2D.');
  const source=bufferView(file,image.bufferView).bytes;
  const bitmap=await createImageBitmap(new Blob([source],{type:image.mimeType}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  try {
    if(!bitmap.width||!bitmap.height||bitmap.width>4096||bitmap.height>4096)throw new Error('Texture exceeds 4096 pixels per side.');
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('Texture decoding context is unavailable.');
    context.drawImage(bitmap,0,0);
    return {width:bitmap.width,height:bitmap.height,pixels:context.getImageData(0,0,bitmap.width,bitmap.height).data};
  } finally {bitmap.close();}
}
export async function loadGLB(url,{signal}={}) {
  const response=await fetch(url,{signal});if(!response.ok)throw new Error(`Model request failed (${response.status}).`);
  const file=parseGLB(await response.arrayBuffer()),geometry=extractGeometry(file),materials=extractMaterials(file);
  const definitions=file.json.textures || [];if(definitions.length>256)throw new Error('Too many textures.');
  const images=new Map();
  const textures=await Promise.all(definitions.map(async texture=>{
    if(!Number.isInteger(texture.source))throw new Error('Missing texture image.');
    if(!images.has(texture.source))images.set(texture.source,decodeImage(file,texture.source));
    const image=await images.get(texture.source),sampler=file.json.samplers?.[texture.sampler] || {};
    const mode=value=>value===33071?1:value===33648?2:0;
    return {...image,wrap:mode(sampler.wrapS ?? 10497)|(mode(sampler.wrapT ?? 10497)<<2)};
  }));
  let duration=12;
  const animation=file.json.animations?.[0];
  if(animation?.samplers?.[0]?.input!==undefined){const times=readAccessor(file,animation.samplers[0].input);const end=times.values[times.values.length-1];if(end>0)duration=end;}
  return {...geometry,materials,textures,duration};
}
