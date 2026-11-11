import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {saveApiKey, getDecryptedApiKey} from './api-key-store.js';
import {ensureUser} from './user-store.js';
import {readStore} from '../storage/store.js';
import {decryptSecret} from '../security/crypto.js';
import {proxyLlmCompletion} from './model-proxy.js';

test('unknown channels discard secrets, reject insecure metadata and block every outbound call', async () => {
  const dir=await mkdtemp(join(tmpdir(),'unknown-provider-'));
  const config={env:'test',dataDir:dir,apiKeyEncryptionKey:randomBytes(32).toString('base64'),store:{driver:'json'}};
  const user=ensureUser(config,{id:'test',email:'test@example.invalid'});
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No external requests allowed');};
  try {
    const input={id:'unknown',channel:'Unregistered',serviceType:'llm',apiKey:'sensitive-test-secret',model:'test-model',endpoint:'https://unregistered.example.com'};
    await assert.rejects(saveApiKey(user,{...input,endpoint:'http://unregistered.example.com'},config),error=>error.status===400);
    const saved=await saveApiKey(user,input,config);
    assert.equal(saved.keyPreview,'********');
    const stored=readStore(config).apiKeys.find(key=>key.id===saved.id);
    assert.equal(decryptSecret(stored.encryptedApiKey,config.apiKeyEncryptionKey),'custom-channel-secret-not-stored');
    assert.ok(!JSON.stringify(saved).includes(input.apiKey));
    await assert.rejects(proxyLlmCompletion({apiKeyId:saved.id,model:'test-model',messages:[{role:'user',content:'private'}]},config,user),error=>error.status===503);
    assert.equal(calls,0);
    const other=ensureUser(config,{id:'other',email:'other@example.invalid'});
    assert.equal(await getDecryptedApiKey(other.id,saved.id,config),null);
  } finally {globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
