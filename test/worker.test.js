import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';

const SECRET = 'test-only-webhook-secret-0123456789';
let next = 1000; // Mock Telegram allocates new IDs across worker restarts.
async function harness(t, options = {}) {
  const calls = [];
  let script = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  if (options.probe) script += `\nexport class Probe extends Inbox { async fetch(req) {
    if (new URL(req.url).pathname === '/test-sql') { const q = await req.json(); return Response.json([...this.sql.exec(q.sql,...(q.args||[]))]); }
    if (new URL(req.url).pathname === '/test-alarm') { if (!this.alarm) return new Response('missing alarm',{status:501}); await this.alarm(); return new Response('OK'); }
    return super.fetch(req);
  } }`;
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-01',
    ...(script.includes('export class Inbox') ? {durableObjects: {INBOX: {className:options.probe?'Probe':'Inbox', useSQLite:true}}} : {}),
    ...(options.persist ? {durableObjectsPersist:options.persist} : {}),
    bindings: { BOT_TOKEN:'test-only-not-a-real-token', ADMIN_ID:'11', ADMIN_IDS:'11,22', WEBHOOK_SECRET:SECRET, ...options.bindings },
    outboundService: async (req) => {
      assert.equal(new URL(req.url).hostname, 'api.telegram.org', 'no other network destinations allowed');
      const payload = JSON.parse(await req.text());
      const method = new URL(req.url).pathname.split('/').at(-1);
      const call = { method, ...payload }; calls.push(call);
      const response = options.transport?.(call);
      if (response) return response;
      return Response.json({ok:true, result:{message_id:next++}});
    },
  });
  let closed=false;
  const close=async()=>{if(!closed){closed=true;await mf.dispose();}};
  t.after(close);
  const send = (update, secret = SECRET, path = '/webhook') => mf.dispatchFetch('https://local.test'+path, {
    method:'POST', headers:{'content-type':'application/json', 'X-Telegram-Bot-Api-Secret-Token':secret}, body:JSON.stringify(update),
  });
  return {mf, calls, send, close};
}
test('Persian Otaku welcome explains operator privacy and offers requested categories only in private chat', async t => {
  const h = await harness(t);
  await h.send(msg(10,33,{text:'/start'}));
  assert.equal(h.calls.length,1);
  assert.match(h.calls[0].text,/اوتاکو/);
  assert.match(h.calls[0].text,/نگاه آشنا/);
  assert.match(h.calls[0].text,/اپراتور/);
  assert.deepEqual(h.calls[0].reply_markup.keyboard.flat(),['پیشنهاد کتاب','انتقاد','ارتباط با انتشارات']);
  await h.send(msg(11,11,{text:'/start',chat:{id:-100,type:'supergroup'}}));
  await h.send(msg(12,11,{text:'/start',from:{id:99}}));
  assert.equal(h.calls.length,1);
  await h.send(msg(13,22,{text:'/start'}));
  assert.match(h.calls[1].text,/مدیر/);
});

test('both admins get unmodified copy and durable message-id reply routing independent of captions', async t => {
  const h = await harness(t);
  await h.send(msg(20,33,{text:'پیشنهاد کتاب'}));
  await h.send(msg(21,33,{text:undefined,photo:[{file_id:'mock'}],caption:'آ'.repeat(1024)}));
  const copies = h.calls.filter(c => c.method === 'copyMessage');
  assert.deepEqual(copies.map(c => String(c.chat_id)),['11','22']);
  assert.ok(copies.every(c => c.caption === undefined && c.from_chat_id === 33 && c.message_id === 121));
  const headers = h.calls.filter(c => c.text?.includes('موضوع: پیشنهاد کتاب'));
  assert.equal(headers.length,2);
  assert.ok(headers.every(c => !c.text.includes('33')));
  for (const admin of [11,22]) {
    const header = headers.find(c => Number(c.chat_id) === admin);
    await h.send(msg(30+admin,admin,{text:'پاسخ'.repeat(1000),reply_to_message:{message_id:header.reply_parameters.message_id,caption:'truncated or forged'}}));
  }
  const replies = h.calls.filter(c => c.method === 'copyMessage' && c.chat_id === 33);
  assert.equal(replies.length,2);
  assert.deepEqual(replies.map(c => c.from_chat_id),[11,22]);
  const before = replies.length;
  await h.send(msg(90,11,{reply_to_message:{message_id:99999,text:'[#RT_fake]'}}));
  assert.equal(h.calls.filter(c => c.method === 'copyMessage' && c.chat_id === 33).length,before);
});

test('Telegram failures never claim delivery and one failing admin does not prevent the other', async t => {
  for (const kind of ['api','http','json','missing-id','partial']) {
    const h = await harness(t,{transport:c => {
      if(c.method !== 'copyMessage' || (kind==='partial' && String(c.chat_id)==='22')) return;
      if(kind==='json') return new Response('invalid json');
      if(kind==='missing-id') return Response.json({ok:true,result:{}});
      return Response.json({ok:false,error_code:429,parameters:{retry_after:15}}, {status:kind==='http'?503:200});
    }});
    assert.equal((await h.send(msg(100))).status,200);
    assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,2);
    const notice=h.calls.filter(c=>c.chat_id===33 && c.method==='sendMessage').at(-1);
    assert.ok(notice);
    assert.ok(!notice.text.startsWith('✅'));
    assert.match(notice.text,kind==='partial'?/بخشی/:/تأیید نشد/);
  }
  const h=await harness(t,{transport:c=>c.method==='copyMessage'&&c.chat_id===33?Response.json({ok:false,error_code:403}):undefined});
  await h.send(msg(110));
  const header=h.calls.find(c=>c.reply_parameters);
  await h.send(msg(111,11,{reply_to_message:{message_id:header.reply_parameters.message_id}}));
  assert.match(h.calls.at(-1).text,/تأیید نشد/);
});

test('duplicate update is atomically claimed once even under concurrency', async t => {
  const h=await harness(t);
  await Promise.all(Array.from({length:12},()=>h.send(msg(200))));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,2);
  await h.send(msg(200));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,2);
});

test('durable transactional rate gate caps concurrent new messages at six per minute', async t => {
  const h=await harness(t);
  await Promise.all(Array.from({length:12},(_,i)=>h.send(msg(300+i))));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,12);
  assert.ok(h.calls.some(c=>c.text?.includes('محدودیت')));
});

test('either private authenticated admin can block and unblock by stored route, not text or user-supplied IDs', async t => {
  const h=await harness(t);
  await h.send(msg(400));
  const headers=h.calls.filter(c=>c.reply_parameters);
  const reply=id=>({message_id:headers.find(c=>Number(c.chat_id)===id).reply_parameters.message_id});
  await h.send(msg(401,11,{text:'/block',reply_to_message:reply(11)}));
  assert.match(h.calls.at(-1).text,/مسدود شد/);
  const before=h.calls.filter(c=>c.method==='copyMessage').length;
  await h.send(msg(402));
  await h.send(msg(403,33,{text:'/unblock 33'}));
  await h.send(msg(404,22,{text:'/unblock',from:{id:33},reply_to_message:reply(22)}));
  await h.send(msg(405));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,before);
  await h.send(msg(406,22,{text:'/unblock',reply_to_message:reply(22)}));
  assert.match(h.calls.at(-1).text,/رفع شد/);
  await h.send(msg(407));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,before+2);
});

test('invalid JSON/update/config is rejected without effects; unsupported identity-bearing content is not relayed', async t => {
  const h=await harness(t);
  assert.equal((await h.send({message:msg(500).message})).status,400);
  assert.equal((await h.send({update_id:-1})).status,400);
  assert.equal((await h.mf.dispatchFetch('https://local.test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':SECRET},body:'{'})).status,400);
  assert.equal((await h.mf.dispatchFetch('https://local.test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':SECRET},body:'x'.repeat(131073)})).status,413);
  await h.send(msg(501,33,{text:undefined,contact:{phone_number:'not-real',first_name:'Sensitive'}}));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,0);
  await h.send(msg(502,33,{text:'/privacy'}));
  assert.match(h.calls.at(-1).text,/اپراتور/);
  const bad=await harness(t,{bindings:{ADMIN_IDS:'11,not-an-id'}});
  assert.equal((await bad.send(msg(503))).status,503);
  const weak=await harness(t,{bindings:{WEBHOOK_SECRET:'weak'}});
  assert.equal((await weak.send(msg(504),'weak')).status,503);
});

test('retention alarm deletes expired metadata but preserves active routes and block list', async t => {
  const h=await harness(t,{probe:true});
  await h.send(msg(600));
  const bindings=await h.mf.getBindings();
  const stub=bindings.INBOX.get(bindings.INBOX.idFromName('otaku-inbox-v1'));
  const sql=async (q)=> (await stub.fetch('https://internal/test-sql',{method:'POST',body:JSON.stringify({sql:q})})).json();
  await sql('INSERT INTO blocked VALUES (99,NULL)');
  await sql("INSERT INTO categories VALUES (99,'test',0)");
  await sql('INSERT INTO routes VALUES (11,999,99,0)');
  await sql('INSERT INTO rates VALUES (99,6,0)');
  await sql('INSERT INTO updates VALUES (999,0)');
  assert.equal((await stub.fetch('https://internal/test-alarm')).status,200);
  assert.equal((await sql('SELECT * FROM routes WHERE expires=0')).length,0);
  assert.equal((await sql('SELECT * FROM routes')).length,4);
  for(const table of ['rates','updates','categories']) assert.equal((await sql('SELECT * FROM '+table+' WHERE expires=0')).length,0);
  assert.equal((await sql('SELECT * FROM blocked')).length,1);
});

test('unblock receipt works after routing metadata expires without exposing Telegram user ID', async t => {
  const h=await harness(t,{probe:true});
  await h.send(msg(700));
  const header=h.calls.find(c=>c.reply_parameters);
  await h.send(msg(701,11,{text:'/block',reply_to_message:{message_id:header.reply_parameters.message_id}}));
  const receipt=h.calls.at(-1).text;
  assert.match(receipt,/\/unblock [a-f0-9-]{36}/);
  const command=receipt.match(/\/unblock [a-f0-9-]{36}/)[0];
  const bindings=await h.mf.getBindings();
  const stub=bindings.INBOX.get(bindings.INBOX.idFromName('otaku-inbox-v1'));
  await stub.fetch('https://internal/test-sql',{method:'POST',body:JSON.stringify({sql:'DELETE FROM routes'})});
  await h.send(msg(702,22,{text:command}));
  assert.match(h.calls.at(-1).text,/رفع شد/);
  const before=h.calls.filter(c=>c.method==='copyMessage').length;
  await h.send(msg(703));
  assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,before+2);
});

test('real SQLite persistence retains routes, category, dedup, rate and blocks across workerd restart', async t => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'otaku-test-'));
  let h;
  try {
    h=await harness(t,{persist:dir});
    await h.send(msg(799,55,{text:'انتقاد'}));
    await h.send(msg(800,33,{text:'انتقاد'}));
    await h.send(msg(801));
    const header=h.calls.find(c=>c.reply_parameters);
    await h.send(msg(802,44));
    const blockedHeader=h.calls.filter(c=>c.reply_parameters).at(-2);
    await h.send(msg(803,11,{text:'/block',reply_to_message:{message_id:blockedHeader.reply_parameters.message_id}}));
    for(let i=0;i<4;i++) await h.send(msg(810+i));
    await h.close();
    h=await harness(t,{persist:dir});
    await h.send(msg(801));
    assert.equal(h.calls.length,0,'dedup survives restart');
    await h.send(msg(820));
    assert.equal(h.calls.filter(c=>c.method==='copyMessage').length,0,'rate survives restart');
    await h.send(msg(821,44));
    assert.match(h.calls.at(-1).text,/مسدود/);
    await h.send(msg(822,11,{reply_to_message:{message_id:header.reply_parameters.message_id}}));
    assert.equal(h.calls.filter(c=>c.method==='copyMessage' && c.chat_id===33).length,1,'reply route survives restart');
    await h.send(msg(823,55));
    assert.ok(h.calls.some(c=>c.text?.includes('موضوع: انتقاد')),'category survives restart');
  } finally { if(h) await h.close(); rmSync(dir,{recursive:true,force:true}); }
});

const msg = (update_id, user=33, extra={}) => ({update_id, message:{message_id:update_id+100, from:{id:user}, chat:{id:user,type:'private'}, text:'سلام', ...extra}});

test('webhook fails closed for missing/wrong configuration and secret; no public registration', async t => {
  const h = await harness(t);
  assert.equal((await h.send(msg(1), 'wrong')).status, 403);
  assert.equal((await h.send(msg(2), '')).status, 403);
  assert.equal((await h.send(msg(3), SECRET, '/register')).status, 404);
  assert.equal((await h.mf.dispatchFetch('https://local.test/webhook')).status, 405);
  const missing = await harness(t, {bindings:{WEBHOOK_SECRET:''}});
  assert.equal((await missing.send(msg(4))).status, 503);
  assert.equal(h.calls.length + missing.calls.length, 0);
});
