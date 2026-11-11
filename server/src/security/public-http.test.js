import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createPublicHttpClient,isPublicAddress,publicMediaUrl} from './public-http.js';

test('rejects private, loopback, link-local, mapped and reserved IP forms',()=>{
  for(const address of ['0.0.0.0','127.1.2.3','10.0.0.1','100.64.0.1','169.254.169.254','172.31.1.1','192.168.1.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
  for(const url of ['http://2130706433','http://0x7f000001','http://127.1','https://user:pass@media.example.com','http://localhost','https://a.internal','https://media.example.com:8443/file','file:///etc/passwd'])assert.throws(()=>publicMediaUrl(url));
});

test('mixed public/private DNS answers are blocked before opening a socket',async()=>{
  let calls=0;
  const fetch=createPublicHttpClient({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],request:()=>{calls++;}});
  await assert.rejects(fetch('https://media.example.com/file'),error=>error.status===400);
  assert.equal(calls,0);
});

function transport({status=200,headers={},chunks=['hello'],stall=false}={}) {
  const calls=[];
  return {calls, request(url,options,callback){
    calls.push({url,options});
    const req=new EventEmitter();
    req.end=()=>queueMicrotask(()=>{
      if(stall)return;
      const res=new PassThrough();res.statusCode=status;res.headers=headers;
      callback(res);
      if(!res.destroyed){for(const chunk of chunks)res.write(Buffer.from(chunk));res.end();}
    });
    return req;
  }};
}

test('actual socket lookup is pinned to the validated DNS answer',async()=>{
  let lookups=0;const mock=transport();
  const fetch=createPublicHttpClient({lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4}];},request:mock.request});
  const result=await fetch('https://media.example.com/file');assert.equal(await result.text(),'hello');
  assert.equal(lookups,1);assert.equal(mock.calls[0].options.agent,false);
  assert.equal(mock.calls[0].url.hostname,'media.example.com');
  mock.calls[0].options.lookup('media.example.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  mock.calls[0].options.lookup('media.example.com',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
});

test('redirects are rejected without opening a second connection',async()=>{
  const mock=transport({status:302,headers:{location:'http://169.254.169.254/latest/meta-data'}});
  const fetch=createPublicHttpClient({lookup:async()=>[{address:'8.8.8.8',family:4}],request:mock.request});
  await assert.rejects(fetch('https://media.example.com/file'),error=>error.status===400);assert.equal(mock.calls.length,1);
});

test('both declared size and streaming byte count are limited',async()=>{
  for(const setup of [{headers:{'content-length':'100'}},{chunks:['123','456']}]){
    const mock=transport(setup);
    const fetch=createPublicHttpClient({lookup:async()=>[{address:'8.8.8.8',family:4}],request:mock.request});
    await assert.rejects(fetch('https://media.example.com/file',{maxBytes:4}),error=>error.status===413);
  }
});

test('deadlines cover DNS resolution and a stalled connection',async()=>{
  const stalledDns=createPublicHttpClient({lookup:()=>new Promise(()=>{})});
  await assert.rejects(stalledDns('https://media.example.com/file',{timeoutMs:10}),error=>error.status===504);
  const mock=transport({stall:true});
  const stalledConnection=createPublicHttpClient({lookup:async()=>[{address:'8.8.8.8',family:4}],request:mock.request});
  await assert.rejects(stalledConnection('https://media.example.com/file',{timeoutMs:10}),error=>error.status===504);
});

test('headers-only probing cancels the response without buffering a media file',async()=>{
  const mock=transport({headers:{'content-length':'999999999'}});
  const fetch=createPublicHttpClient({lookup:async()=>[{address:'8.8.8.8',family:4}],request:mock.request});
  const response=await fetch('https://media.example.com/file',{headersOnly:true});
  assert.equal(response.status,200);assert.equal(await response.text(),'');
});
