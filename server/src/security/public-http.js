import { readOwnedLocalMedia } from './local-media.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { httpError } from '../http.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address,prefix,'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address,prefix,'ipv6');

export function isPublicAddress(address) {
  const family=isIP(address);
  return family===4 ? !blocked.check(address,'ipv4') : family===6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}

export function publicMediaUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw httpError(400,'素材地址无效。'); }
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.port
    || /(?:^|\.)(localhost|local|internal|test|invalid)$/i.test(host)
    || (!isIP(host)&&!host.includes('.')) || (isIP(host)&&!isPublicAddress(host))) {
    throw httpError(400,'素材地址必须是标准端口的公网 HTTP(S) 地址。');
  }
  return url;
}

// Factory injection is used only by unit tests; runtime callers use the fixed instance below.
export function createPublicHttpClient({lookup=(...args)=>dns.lookup(...args), request=(url,options,callback)=>(url.protocol==='https:'?https:http).request(url,options,callback)}={}) {
  return async function publicHttpFetch(value,{headers={},signal,maxBytes=30*1024*1024,timeoutMs=30000,headersOnly=false}={}) {
    const url=publicMediaUrl(value);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const controller=new AbortController();
    const combined=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    const timer=setTimeout(()=>controller.abort(httpError(504,'素材读取超时。')),timeoutMs);
    let onAbort;
    try {
      return await Promise.race([
        (async()=>{
          const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true,verbatim:true});
          if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address))) throw httpError(400,'素材域名解析到非公网地址，已拒绝读取。');
          combined.throwIfAborted();
          const selected=addresses[0];
          return await new Promise((resolve,reject)=>{
            // Pin the validated address in the actual socket lookup: no second DNS resolution.
            const req=request(url,{method:'GET',agent:false,signal:combined,headers:{'Accept-Encoding':'identity',...headers},
              lookup:(_hostname,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family)},res=>{
              const status=res.statusCode||502;
              if(status>=300&&status<400){res.destroy();reject(httpError(400,'素材地址发生重定向，请使用最终公网文件地址。'));return;}
              const responseHeaders=new Headers();
              for(const [name,value] of Object.entries(res.headers)) if(value!==undefined) responseHeaders.set(name,Array.isArray(value)?value.join(', '):String(value));
              if(headersOnly){res.destroy();resolve(new Response(null,{status,headers:responseHeaders}));return;}
              if(Number(res.headers['content-length'])>maxBytes){res.destroy();reject(httpError(413,'素材文件超过允许大小。'));return;}
              let size=0;const chunks=[];
              res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(httpError(413,'素材文件超过允许大小。'));}else chunks.push(chunk);});
              res.on('error',()=>reject(httpError(502,'素材读取连接中断。')));
              res.on('aborted',()=>reject(httpError(502,'素材读取连接中断。')));
              res.on('end',()=>resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders})));
            });
            req.on('error',()=>reject(combined.aborted?combined.reason:httpError(502,'素材读取失败。')));
            req.end();
          });
        })(),
        new Promise((_,reject)=>{onAbort=()=>reject(combined.reason);if(combined.aborted)onAbort();else combined.addEventListener('abort',onAbort,{once:true});}),
      ]);
    } finally {clearTimeout(timer);if(onAbort)combined.removeEventListener('abort',onAbort);}
  };
}
const publicFetch=createPublicHttpClient();
export const mediaHttp={fetch:async(value,options={})=>await readOwnedLocalMedia(value,options)||publicFetch(value,options)};
