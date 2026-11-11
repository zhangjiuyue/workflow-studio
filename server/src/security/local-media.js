import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { httpError } from '../http.js';

const access=new AsyncLocalStorage();
export function withLocalMediaAccess(user,config,callback){return access.run({user,config},callback);}
export async function readOwnedLocalMedia(value,{maxBytes=30*1024*1024,headersOnly=false}={}){
  const context=access.getStore();
  if(!context?.user?.id)return null;
  const {user,config}=context;
  let pathname;
  if(String(value).startsWith('/files/'))pathname=String(value);
  else {
    let url,base;
    try{url=new URL(value);base=new URL(config.publicApiBaseUrl);}catch{return null;}
    if(url.origin!==base.origin||!url.pathname.startsWith('/files/'))return null;
    if(url.search||url.hash||url.username||url.password)throw httpError(400,'本地素材地址格式不正确。');
    pathname=url.pathname;
  }
  let parts;
  try{parts=pathname.slice('/files/'.length).split('/').map(decodeURIComponent);}catch{throw httpError(400,'本地素材路径无效。');}
  const owner=String(user.id).replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'')||'item';
  if(owner==='.'||owner==='..'||parts.length<3||parts[0]!=='uploads'||parts[1]!==owner||parts.some(part=>!part||part==='.'||part==='..'||/[\\/\x00]/.test(part)))throw httpError(403,'不能读取其他用户的本地素材。');
  const root=path.resolve(config.dataDir||'./data','files');
  let resolved,ownerRoot;
  try{resolved=await realpath(path.join(root,...parts));ownerRoot=await realpath(path.join(root,'uploads',owner));}catch{throw httpError(404,'本地素材不存在。');}
  if(!resolved.startsWith(ownerRoot+path.sep))throw httpError(403,'本地素材路径不允许。');
  const file=await open(resolved,'r');
  try{
    const info=await file.stat();
    if(!info.isFile())throw httpError(400,'本地素材不是文件。');
    if(info.size>maxBytes)throw httpError(413,'素材文件超过允许大小。');
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg','.mp4':'video/mp4','.wav':'audio/wav'}[path.extname(resolved).toLowerCase()]||'application/octet-stream';
    if(headersOnly)return new Response(null,{headers:{'content-type':mime}});
    const buffer=Buffer.alloc(info.size);
    let offset=0;
    while(offset<buffer.length){const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    return new Response(buffer.subarray(0,offset),{headers:{'content-type':mime}});
  }finally{await file.close();}
}
