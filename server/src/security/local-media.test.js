import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withLocalMediaAccess,readOwnedLocalMedia} from './local-media.js';
import {mediaHttp} from './public-http.js';
import {createImageDownload} from '../services/image-package.js';

test('authenticated local downloads read only owned assets without loopback HTTP',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'owned-media-'));const owner=join(dir,'files/uploads/owner');
  await mkdir(owner,{recursive:true});await mkdir(join(dir,'files/uploads/other'),{recursive:true});
  const image=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
  await writeFile(join(owner,'image.png'),image);await writeFile(join(dir,'files/uploads/other/private.png'),image);
  await symlink(join(dir,'files/uploads/other/private.png'),join(owner,'link.png'));
  const config={dataDir:dir,publicApiBaseUrl:'http://127.0.0.1:18787'};
  try{
    assert.equal(await readOwnedLocalMedia('/files/uploads/owner/image.png'),null);
    await withLocalMediaAccess({id:'owner'},config,async()=>{
      const result=await createImageDownload({url:'/files/uploads/owner/image.png'});
      assert.deepEqual(result.buffer,image);
      const local=await mediaHttp.fetch('http://127.0.0.1:18787/files/uploads/owner/image.png');
      assert.equal((await local.arrayBuffer()).byteLength,image.length);
      for(const url of ['/files/uploads/other/private.png','/files/uploads/owner/../other/private.png','/files/uploads/owner/%2e%2e/other/private.png','/files/uploads/owner/link.png'])await assert.rejects(readOwnedLocalMedia(url),error=>error.status===403);
      await assert.rejects(mediaHttp.fetch('http://127.0.0.1:9999/files/uploads/owner/image.png'),error=>error.status===400);
      await assert.rejects(readOwnedLocalMedia('/files/uploads/owner/image.png',{maxBytes:1}),error=>error.status===413);
    });
  }finally{await rm(dir,{recursive:true,force:true});}
});
