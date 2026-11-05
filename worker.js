// Hardened two-way anonymous relay bot for Telegram on Cloudflare Workers.
// Based on NotPouria/telegram-secretline-bot (MIT). See LICENSE.
const FAILURE = '⚠️ ارسال تأیید نشد؛ ممکن است تحویل شده باشد. ارسال خودکار تکرار نمی‌شود. کمی بعد دوباره تلاش کنید؛ ممکن است نسخه تکراری ایجاد شود.';
const BOOK_SEARCH = '🔎 جستجوی کتاب';
const CATEGORIES = ['پیشنهاد','انتقاد','پرسش',BOOK_SEARCH];
const WELCOME = 'سلام! 👋\nبه صندوق پیام خوش آمدید.\n\nلطفاً از بین این ۴ گزینه، یکی را انتخاب کنید:\n\n📝 پیشنهاد\n⚠️ انتقاد\n❓ پرسش\n🔎 جستجوی کتاب\n\nبعد از انتخاب، پیام یا عبارت موردنظرتان را بفرستید؛ در صورت نیاز پاسخ مدیر همین‌جا برای شما ارسال می‌شود.';
function normalizeSearch(value = '') {
  return String(value).toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی').replace(/[ك]/g, 'ک')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200d\u200f]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(x => x.trim())) rows.push(row); }
  return rows;
}

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
    this.booksCache = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS routes (admin TEXT, message INTEGER, user INTEGER, expires INTEGER, PRIMARY KEY(admin,message));
      CREATE TABLE IF NOT EXISTS categories (user INTEGER PRIMARY KEY, category TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS rates (user INTEGER PRIMARY KEY, count INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS blocked (user INTEGER PRIMARY KEY, handle TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS book_results (user INTEGER, token TEXT, title TEXT, details TEXT, expires INTEGER, PRIMARY KEY(user,token));`);
    try { this.sql.exec('ALTER TABLE routes ADD COLUMN source INTEGER'); } catch {}
  }
  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const table of ['routes','categories','updates','rates','book_results']) {
        this.sql.exec(`DELETE FROM ${table} WHERE expires<=?`,now);
      }
    });
    // Hourly cleanup, including idle periods. Logical expiry is checked on lookup.
    await this.ctx.storage.setAlarm(now+3600000);
  }
  async rawApi(method, payload) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload),
        signal:AbortSignal.timeout(5000),
      });
      return await res.json();
    } catch { return null; }
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

  async searchBooks(query) {
    const url = this.env.BOOKS_CSV_URL;
    if (!url) return [];
    let rows;
    if (this.booksCache && this.booksCache.expires > Date.now()) rows = this.booksCache.rows;
    else {
      try {
        const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
        if (!res.ok) return [];
        rows = parseCsv(await res.text());
        this.booksCache = {rows, expires: Date.now() + 15 * 60 * 1000};
      } catch { return []; }
    }
    if (rows.length < 2) return [];
    const headers = rows[0].map(normalizeSearch);
    const index = name => headers.indexOf(normalizeSearch(name));
    const fields = {title:index('عنوان'), volume:index('شماره جلد'), series:index('چند جلدی'), isbn:index('شابک'), year:index('سال انتشار'), size:index('سایز'), pages:index('تعداد صفحات'), author:index('نویسنده'), translator:index('مترجم'), link:index('لینک محصول در سایت')};
    const q = normalizeSearch(query);
    if (!q) return [];
    const tokens = q.split(' ');
    return rows.slice(1).map(r => {
      const title = r[fields.title] ?? ''; const author = r[fields.author] ?? ''; const translator = r[fields.translator] ?? '';
      const haystack = normalizeSearch([title, author, translator].join(' '));
      const matches = haystack.includes(q) || tokens.every(t => haystack.includes(t));
      const exact = normalizeSearch(title) === q ? 2 : haystack.includes(q) ? 1 : 0;
      return {r, title, author, translator, matches, exact};
    }).filter(x => x.matches).sort((a,b) => b.exact - a.exact || a.title.length - b.title.length).map(x => {
      const get = key => fields[key] >= 0 ? (x.r[fields[key]] ?? '').trim() : '';
      return {title:x.title.trim(), volume:get('volume'), series:get('series'), isbn:get('isbn'), year:get('year'), size:get('size'), pages:get('pages'), author:x.author.trim(), translator:x.translator.trim(), link:get('link')};
    });
  }

  async fetchLivePrice(url) {
    if (!url || !/^https:\/\//i.test(url)) return '';
    try {
      const res = await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; TelegramBookSearch/1.0)'},signal:AbortSignal.timeout(8000)});
      if (!res.ok) return '';
      const html = await res.text();
      const block = html.match(/<p[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>[\s\S]*?<\/p>/i)?.[0] ?? '';
      const ins = block.match(/<ins[\s\S]*?<\/ins>/i)?.[0] ?? '';
      const amount = (ins || block).match(/(?:<bdi>|<span[^>]*class=["'][^"']*amount[^"']*["'][^>]*>)([۰-۹0-9,٬.]+)\s*(?:&nbsp;|<[^>]*>)*تومان/i)?.[1];
      return amount ? amount.replace(/٬/g,',') : '';
    } catch { return ''; }
  }

  formatBookDetails(b) {
    const lines = [`📚 ${b.title}${b.volume && b.volume !== '-' ? ` | جلد ${b.volume}` : ''}`];
    if (b.author && b.author !== '-') lines.push(`نویسنده: ${b.author}`);
    if (b.translator && b.translator !== '-') lines.push(`مترجم: ${b.translator}`);
    if (b.pages && b.pages !== '-') lines.push(`تعداد صفحات: ${b.pages}`);
    if (b.year && b.year !== '-') lines.push(`سال انتشار: ${b.year}`);
    if (b.size && b.size !== '-') lines.push(`سایز: ${b.size}`);
    if (b.isbn && b.isbn !== '-') lines.push(`شابک: ${b.isbn}`);
    if (b.livePrice) lines.push(`قیمت فعلی سایت: ${b.livePrice} تومان`);
    if (b.link && b.link !== '-') lines.push(`لینک محصول: ${b.link}`);
    return lines.join('\n');
  }

  async sendBookResults(user, query) {
    const results = await this.searchBooks(query);
    if (!results.length) {
      await this.send(user, `نتیجه‌ای برای «${query}» پیدا نشد. نام کتاب، نویسنده یا مترجم را دقیق‌تر بنویسید.`);
      return;
    }
    this.sql.exec('DELETE FROM book_results WHERE user=?',user);
    const keyboard = [];
    for (const b of results) {
      const token = crypto.randomUUID();
      this.sql.exec('INSERT INTO book_results VALUES (?,?,?,?,?)',user,token,b.title,JSON.stringify(b),Date.now()+15*60*1000);
      keyboard.push([{text:`${b.title}${b.volume && b.volume !== '-' ? ` | جلد ${b.volume}` : ''}`,callback_data:`book:${token}`}]);
    }
    await this.send(user,`📚 نتایج جستجو برای «${query}»\n\nبرای دیدن مشخصات کامل، روی عنوان کتاب بزنید:`,{reply_markup:{inline_keyboard:keyboard}});
  }

  send(chat_id, text, extra={}) { return this.api('sendMessage', {chat_id,text,...extra}); }
  route(admin, message, user, source) {
    this.sql.exec('INSERT OR REPLACE INTO routes (admin,message,user,source,expires) VALUES (?,?,?,?,?)',String(admin),message,user,source,Date.now()+30*86400000);
  }
  async fetch(request) {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+3600000);
    const update = await request.json();
    const callback = update.callback_query;
    if (callback) {
      const user = callback.from?.id;
      const chat = callback.message?.chat;
      if (chat?.type !== 'private' || chat.id !== user || !Number.isSafeInteger(user) || user <= 0) return new Response('Ignored');
      const claimed = this.ctx.storage.transactionSync(() => {
        if ([...this.sql.exec('SELECT id FROM updates WHERE id=?',update.update_id)].length) return false;
        this.sql.exec('INSERT INTO updates VALUES (?,?)',update.update_id,Date.now()+7*86400000);
        return true;
      });
      if (!claimed) return new Response('Duplicate');
      const token = /^book:([a-f0-9-]{36})$/.exec(callback.data ?? '')?.[1];
      const row = token ? [...this.sql.exec('SELECT details FROM book_results WHERE user=? AND token=? AND expires>?',user,token,Date.now())][0] : null;
      await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:row ? 'مشخصات کتاب ارسال شد.' : 'این نتیجه منقضی شده است.'});
      if (row) { const book = JSON.parse(row.details); book.livePrice = await this.fetchLivePrice(book.link); await this.send(user,this.formatBookDetails(book)); }
      else await this.send(user,'این نتیجه منقضی شده است؛ دوباره جستجو کنید.');
      return new Response('OK');
    }
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
    const savedCategory = [...this.sql.exec('SELECT category FROM categories WHERE user=? AND expires>?',user,Date.now())][0]?.category;
    const commandQuery = /^\/کتاب(?:\s+(.+))?$/.exec(m.text ?? '');
    if (m.text === BOOK_SEARCH && !m.reply_to_message) {
      this.sql.exec('INSERT OR REPLACE INTO categories VALUES (?,?,?)',user,BOOK_SEARCH,Date.now()+30*86400000);
      await this.send(user,'نام کتاب، نویسنده یا مترجم را بنویسید:');
      return new Response('OK');
    }
    if (commandQuery?.[1] && !m.reply_to_message) {
      await this.sendBookResults(user, commandQuery[1].trim());
      return new Response('OK');
    }
    if (savedCategory === BOOK_SEARCH && m.text && !m.text.startsWith('/') && !m.reply_to_message) {
      await this.sendBookResults(user, m.text.trim());
      return new Response('OK');
    }
    if (m.text && !m.text.startsWith('/') && !CATEGORIES.includes(m.text) && !m.reply_to_message) {
      const automaticMatches = await this.searchBooks(m.text.trim());
      if (automaticMatches.length) {
        await this.sendBookResults(user, m.text.trim());
        return new Response('OK');
      }
    }
    if (m.text === '/start') {
      await this.send(user,admin ? 'پنل مدیر: برای پاسخ روی پیام دریافتی ریپلای کنید.' : WELCOME,
        {reply_markup:{keyboard:CATEGORIES.map(x => [x]),resize_keyboard:true}});
    } else if (admin) {
      const route = [...this.sql.exec('SELECT user,source FROM routes WHERE admin=? AND message=? AND expires>?',String(user),m.reply_to_message?.message_id ?? -1,Date.now())][0];
      if (!route) await this.send(user,'مسیر پاسخ یافت نشد یا منقضی شده است. روی پیام دریافتی ریپلای کنید.');
      else if (m.text === '/block') {
        this.sql.exec('INSERT OR IGNORE INTO blocked VALUES (?,?)',route.user,crypto.randomUUID());
        const handle = [...this.sql.exec('SELECT handle FROM blocked WHERE user=?',route.user)][0].handle;
        await this.send(user,`فرستنده مسدود شد. رسید را برای رفع مسدودی پس از انقضای مسیر نگه دارید و در صورت نیاز با مدیر دیگر به اشتراک بگذارید:\n/unblock ${handle}`);
      } else if (m.text === '/unblock') {
        this.sql.exec('DELETE FROM blocked WHERE user=?',route.user);
        await this.send(user,'مسدودی فرستنده رفع شد.');
      } else {
        const result = await this.api('copyMessage',{chat_id:route.user,from_chat_id:user,message_id:m.message_id,...(route.source ? {reply_parameters:{message_id:route.source}} : {})});
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
        this.route(recipient,copied.message_id,user,m.message_id);
        delivered++;
        const header = await this.send(recipient,`📩 پیام ناشناس | موضوع: ${category}\nبرای پاسخ، /block یا /unblock روی این پیام یا پیام بالا ریپلای کنید.`,{reply_parameters:{message_id:copied.message_id}});
        if (header) this.route(recipient,header.message_id,user,m.message_id);
      }
      await this.send(user,delivered === admins.length ? '✅ پیام شما ارسال شد. لطفاً منتظر پاسخ باشید.' : delivered ? '⚠️ پیام فقط به بخشی از مدیران رسید؛ لطفاً منتظر پاسخ باشید. ارسال دوباره ممکن است نسخه تکراری ایجاد کند.' : FAILURE);
    }
    return new Response('OK');
  }
}
