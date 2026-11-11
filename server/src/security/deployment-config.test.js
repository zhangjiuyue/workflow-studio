import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {assertDeploymentConfig} from './deployment-config.js';
test('production entry points reject missing secrets, wildcard origins and split JSON workers',()=>{
  const config={env:'production',sessionSecret:randomBytes(32).toString('hex'),apiKeyEncryptionKey:randomBytes(32).toString('base64'),appOrigins:['http://127.0.0.1:13000'],store:{driver:'json'},bootstrapAdmin:{password:randomBytes(24).toString('hex')}};
  assert.doesNotThrow(()=>assertDeploymentConfig(config));
  for(const patch of [{sessionSecret:''},{apiKeyEncryptionKey:''},{appOrigins:['*']},{bootstrapAdmin:{password:'short'}}])assert.throws(()=>assertDeploymentConfig({...config,...patch}));
  assert.throws(()=>assertDeploymentConfig(config,{separateWorker:true}));
  assert.throws(()=>assertDeploymentConfig({...config,store:{driver:'postgres'}}));
  assert.doesNotThrow(()=>assertDeploymentConfig({...config,store:{driver:'postgres'},databaseUrl:'postgresql://example.invalid/test'},{separateWorker:true}));
});
