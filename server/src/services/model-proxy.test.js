import assert from 'node:assert/strict';
import test from 'node:test';
import {extractVideoTaskId} from './model-proxy.js';
import {validateAdapterResult,requestChatCompletion} from './configured-provider-runner.js';

test('task identifiers support normalized and nested upstream shapes',()=>{
  for(const body of [{taskId:'one'},{data:{task_id:'one'}},{result:{job_id:'one'}},{data:[{id:'one'}]}]) assert.equal(extractVideoTaskId(body),'one');
  assert.equal(extractVideoTaskId({task:{unknown:true}}),'');
});
test('each operation rejects incomplete results before workflows can mark success',()=>{
  const results={llm:{content:'ok'},image:{images:[{url:'https://media.example.com/i.png'}]},audio:{audioUrl:'https://media.example.com/a.mp3'},transcribe:{segments:[]},'video-create':{taskId:'task'},'video-query':{status:'processing'},draft:{draftUrl:'https://draft.example.com/d'}};
  for(const [operation,result] of Object.entries(results)) {
    assert.equal(validateAdapterResult(operation,result),result);
    assert.throws(()=>validateAdapterResult(operation,{}));
    assert.throws(()=>validateAdapterResult(operation,[]));
  }
});
test('text HTTP rejections retain status without exposing upstream body',async()=>{
  const original=globalThis.fetch;
  const policy={endpoint:'https://text.example.com',authType:'Bearer',models:['text']};
  try{
    globalThis.fetch=async()=>new Response('private-upstream-error',{status:400});
    await assert.rejects(requestChatCompletion(policy,'synthetic',{model:'text',messages:[{role:'user',content:'prompt'}]}),error=>error.status===400&&!error.message.includes('private-upstream-error'));
    globalThis.fetch=async()=>new Response(JSON.stringify({choices:[]}));
    await assert.rejects(requestChatCompletion(policy,'synthetic',{model:'text',messages:[{role:'user',content:'prompt'}]}),error=>error.status===502);
  }finally{globalThis.fetch=original;}
});
