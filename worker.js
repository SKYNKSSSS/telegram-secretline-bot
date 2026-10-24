// Hardened two-way anonymous relay bot for Telegram on Cloudflare Workers.
// Based on NotPouria/telegram-secretline-bot (MIT). See LICENSE.
const FAILURE = '⚠️ ارسال تأیید نشد؛ ممکن است تحویل شده باشد. ارسال خودکار تکرار نمی‌شود. کمی بعد دوباره تلاش کنید؛ ممکن است نسخه تکراری ایجاد شود.';
const CATEGORIES = ['پیشنهاد','انتقاد','پرسش'];
const WELCOME = 'سلام! 👋\nبه صندوق پیام خوش آمدید.\n\nموضوع پیام را انتخاب کنید و سپس پیام، عکس، فایل یا صدای خود را بفرستید. پاسخ مدیر همین‌جا برای شما ارسال می‌شود.\n\nبرای ادامه، یکی از موضوع‌های زیر را انتخاب کنید:';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/webhook') return new Response('Not found', {status:404});
    if (request.method !== 'POST') return new Response('Method not allowed', {status:405});
    const ids = String(env.ADMIN_IDS ?? '').split(',');
    if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET ?? '') ||
        ids.length > 5 || !ids.every(id => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))) ||
        new Set(ids).size !== ids.length || !env.INBOX) return new Response('Not configured', {status:503});
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', {status:403});
    // Count actual bytes rather than trusting Content-Length.
    const reader = request.body?.getReader();
    let size = 0; const chunks = [];
    if (!reader) return new Response('Invalid update', {status:400});
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) { await reader.cancel(); return new Response('Too large', {status:413}); }
      chunks.push(value);
    }
    let update;
    try { update = JSON.parse(await new Blob(chunks).text()); }
    catch { return new Response('Invalid JSON', {status:400}); }
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return new Response('Invalid update', {status:400});
    try {
      return await env.INBOX.get(env.INBOX.idFromName('inbox-v1')).fetch(new Request(request.url,{method:'POST',body:JSON.stringify(update)}));
    } catch { return new Response('Temporary failure', {status:503}); }
  },
};

export class Inbox {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS routes (admin TEXT, message INTEGER, user INTEGER, expires INTEGER, PRIMARY KEY(admin,message));
      CREATE TABLE IF NOT EXISTS categories (user INTEGER PRIMARY KEY, category TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS rates (user INTEGER PRIMARY KEY, count INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS blocked (user INTEGER PRIMARY KEY, handle TEXT UNIQUE);`);
  }
  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const table of ['routes','categories','updates','rates']) {
        this.sql.exec(`DELETE FROM ${table} WHERE expires<=?`,now);
      }
    });
    // Hourly cleanup, including idle periods. Logical expiry is checked on lookup.
    await this.ctx.storage.setAlarm(now+3600000);
  }
  async api(method, payload) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload),
        signal:AbortSignal.timeout(5000),
      });
      const body = await res.json();
      if (!res.ok || body.ok !== true || !Number.isSafeInteger(body.result?.message_id)) return null;
      return body.result;
    } catch { return null; } // No tokens, payloads or Telegram error descriptions in logs.

  }
  send(chat_id, text, extra={}) { return this.api('sendMessage', {chat_id,text,...extra}); }
  route(admin, message, user) {
    this.sql.exec('INSERT OR REPLACE INTO routes VALUES (?,?,?,?)',String(admin),message,user,Date.now()+30*86400000);
  }
  async fetch(request) {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+3600000);
    const update = await request.json();
    const m = update.message;
    if (!m || m.chat?.type !== 'private' || m.from?.id !== m.chat.id || !Number.isSafeInteger(m.from?.id) || m.from.id <= 0 || !Number.isSafeInteger(m.message_id) || m.message_id <= 0) return new Response('Ignored');
    // Claim durably BEFORE external side effects. Crash/timeout is not blindly retried.
    const claimed = this.ctx.storage.transactionSync(() => {
      if ([...this.sql.exec('SELECT id FROM updates WHERE id=?',update.update_id)].length) return false;
      this.sql.exec('INSERT INTO updates VALUES (?,?)',update.update_id,Date.now()+7*86400000);
      return true;
    });
    if (!claimed) return new Response('Duplicate');
    const user = m.from.id;
    const admins = this.env.ADMIN_IDS.split(',');
    const admin = admins.includes(String(user));
    const count = this.ctx.storage.transactionSync(() => {
      const rate = [...this.sql.exec('SELECT count,expires FROM rates WHERE user=?',user)][0];
      const active = rate && rate.expires > Date.now();
      const n = active ? rate.count + 1 : 1;
      this.sql.exec('INSERT OR REPLACE INTO rates VALUES (?,?,?)',user,n,active ? rate.expires : Date.now()+60000);
      return n;
    });
    const limit = admin ? 30 : 6;
    if (count > limit) {
      if (count === limit+1) await this.send(user,'محدودیت تعداد پیام؛ یک دقیقه بعد دوباره تلاش کنید.');
      return new Response('Rate limited');
    }
    const unblock = /^\/unblock ([a-f0-9-]{36})$/.exec(m.text ?? '');
    if (admin && unblock) {
      const result = [...this.sql.exec('DELETE FROM blocked WHERE handle=? RETURNING user',unblock[1])];
      await this.send(user,result.length ? 'مسدودی فرستنده رفع شد.' : 'رسید مسدودی یافت نشد.');
      return new Response('OK');
    }
    if (!['text','photo','video','voice','audio','document','sticker','video_note','animation'].some(type => m[type])) {
      await this.send(user,'این نوع پیام پشتیبانی نمی‌شود. متن، عکس، فایل، ویدئو، استیکر یا صدا بفرستید؛ مخاطب و موقعیت ارسال نمی‌شود.');
      return new Response('Unsupported');
    }
    if (!admin && [...this.sql.exec('SELECT user FROM blocked WHERE user=?',user)].length) {
      await this.send(user,'ارسال پیام شما مسدود است.');
      return new Response('Blocked');
    }
    if (m.text === '/start') {
      await this.send(user,admin ? 'پنل مدیر: برای پاسخ روی پیام دریافتی ریپلای کنید.' : WELCOME,
        {reply_markup:{keyboard:CATEGORIES.map(x => [x]),resize_keyboard:true}});
    } else if (admin) {
      const route = [...this.sql.exec('SELECT user FROM routes WHERE admin=? AND message=? AND expires>?',String(user),m.reply_to_message?.message_id ?? -1,Date.now())][0];
      if (!route) await this.send(user,'مسیر پاسخ یافت نشد یا منقضی شده است. روی پیام دریافتی ریپلای کنید.');
      else if (m.text === '/block') {
        this.sql.exec('INSERT OR IGNORE INTO blocked VALUES (?,?)',route.user,crypto.randomUUID());
        const handle = [...this.sql.exec('SELECT handle FROM blocked WHERE user=?',route.user)][0].handle;
        await this.send(user,`فرستنده مسدود شد. رسید را برای رفع مسدودی پس از انقضای مسیر نگه دارید و در صورت نیاز با مدیر دیگر به اشتراک بگذارید:\n/unblock ${handle}`);
      } else if (m.text === '/unblock') {
        this.sql.exec('DELETE FROM blocked WHERE user=?',route.user);
        await this.send(user,'مسدودی فرستنده رفع شد.');
      } else {
        const result = await this.api('copyMessage',{chat_id:route.user,from_chat_id:user,message_id:m.message_id});
        await this.send(user,result ? '✅ پاسخ ارسال شد (به معنای خوانده شدن نیست).' : FAILURE);
      }
    } else if (CATEGORIES.includes(m.text)) {
      this.sql.exec('INSERT OR REPLACE INTO categories VALUES (?,?,?)',user,m.text,Date.now()+30*86400000);
      await this.send(user,'موضوع انتخاب شد؛ اکنون پیام را بفرستید.');
    } else {
      const category = [...this.sql.exec('SELECT category FROM categories WHERE user=? AND expires>?',user,Date.now())][0]?.category ?? CATEGORIES[2];
      let delivered = 0;
      for (const recipient of admins) {
        const copied = await this.api('copyMessage',{chat_id:recipient,from_chat_id:user,message_id:m.message_id});
        if (!copied) continue;
        this.route(recipient,copied.message_id,user);
        delivered++;
        const header = await this.send(recipient,`📩 پیام ناشناس | موضوع: ${category}\nبرای پاسخ، /block یا /unblock روی این پیام یا پیام بالا ریپلای کنید.`,{reply_parameters:{message_id:copied.message_id}});
        if (header) this.route(recipient,header.message_id,user);
      }
      await this.send(user,delivered === admins.length ? '✅ پیام برای مدیران ارسال شد (به معنای خوانده شدن نیست).' : delivered ? '⚠️ پیام فقط به بخشی از مدیران رسید؛ ارسال دوباره ممکن است نسخه تکراری ایجاد کند.' : FAILURE);
    }
    return new Response('OK');
  }
}
