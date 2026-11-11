// Hardened two-way anonymous relay bot for Telegram on Cloudflare Workers.
// Based on NotPouria/telegram-secretline-bot (MIT). See LICENSE.
const FAILURE = '⚠️ ارسال تأیید نشد؛ ممکن است تحویل شده باشد. ارسال خودکار تکرار نمی‌شود. کمی بعد دوباره تلاش کنید؛ ممکن است نسخه تکراری ایجاد شود.';
const BOOK_SEARCH = '🔎 جستجوی کتاب';
const ALLOWED_COLLECTIONS = ['تاریخ ایران','نثر روان داستان های هزار و یک شب','پرتقال','ارباب حلقه ها','مدرسه افسانه ای'];
const CATEGORIES = ['پیشنهاد','انتقاد','پرسش',BOOK_SEARCH];
const WELCOME = 'سلام! 👋\nبه صندوق پیام خوش آمدید.\n\nلطفاً از بین این ۳ گزینه، یکی را انتخاب کنید:\n\n📝 پیشنهاد\n❓ پرسش\n🔎 جستجوی کتاب\n\nبعد از انتخاب، پیام یا عبارت موردنظرتان را بفرستید؛ در صورت نیاز پاسخ مدیر همین‌جا برای شما ارسال می‌شود.';
function normalizeSearch(value = '') {
  return String(value).toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی').replace(/[ك]/g, 'ک')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u200c\u200d\u200f]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function editDistance(a, b) {
  const d = Array.from({length:a.length+1},(_,i)=>Array(b.length+1).fill(0));
  for (let i=0;i<=a.length;i++) d[i][0]=i;
  for (let j=0;j<=b.length;j++) d[0][j]=j;
  for (let i=1;i<=a.length;i++) for (let j=1;j<=b.length;j++) {
    d[i][j] = Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    if (i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
  }
  return d[a.length][b.length];
}

function fuzzyMatches(query, haystack) {
  const q = query.split(' ').filter(Boolean);
  const words = haystack.split(' ').filter(Boolean);
  return q.every(token => {
    if (token.length < 3) return words.includes(token);
    const tolerance = token.length >= 8 ? 2 : 1;
    return words.some(word => Math.abs(word.length-token.length)<=tolerance && editDistance(token,word)<=tolerance);
  });
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

function escapeHtml(value = '') { return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }

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
      CREATE TABLE IF NOT EXISTS book_results (user INTEGER, token TEXT, title TEXT, details TEXT, expires INTEGER, search_token TEXT, page INTEGER, PRIMARY KEY(user,token));
      CREATE TABLE IF NOT EXISTS book_searches (user INTEGER, token TEXT PRIMARY KEY, query TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS book_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user INTEGER, query TEXT, status TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS favorites (user INTEGER, token TEXT PRIMARY KEY, book_key TEXT, details TEXT, created INTEGER, UNIQUE(user,book_key));`);
    try { this.sql.exec('ALTER TABLE book_results ADD COLUMN search_token TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE book_results ADD COLUMN page INTEGER'); } catch {}
    try { this.sql.exec('ALTER TABLE routes ADD COLUMN source INTEGER'); } catch {}
  }
  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const table of ['routes','categories','updates','rates','book_results','book_searches']) {
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
    return rows.slice(1).filter(r => {
      const volume = normalizeSearch(r[fields.volume] ?? '');
      const series = normalizeSearch(r[fields.series] ?? '');
      const title = normalizeSearch(r[fields.title] ?? '');
      const isCollection = volume === normalizeSearch('مجموعه') || series === normalizeSearch('بله');
      return !isCollection || ALLOWED_COLLECTIONS.some(name => title.includes(normalizeSearch(name)));
    }).map(r => {
      const title = r[fields.title] ?? ''; const author = r[fields.author] ?? ''; const translator = r[fields.translator] ?? '';
      const haystack = normalizeSearch([title, author, translator, r[fields.link] ?? ''].join(' '));
      const matches = haystack.includes(q) || tokens.every(t => haystack.includes(t)) || fuzzyMatches(q, haystack);
      const exact = normalizeSearch(title) === q ? 2 : haystack.includes(q) ? 1 : 0;
      return {r, title, author, translator, matches, exact};
    }).filter(x => x.matches).sort((a,b) => b.exact - a.exact || a.title.length - b.title.length).map(x => {
      const get = key => fields[key] >= 0 ? (x.r[fields[key]] ?? '').trim() : '';
      const base = normalizeSearch(x.title).split(':')[0];
      const collection = rows.slice(1).find(c => normalizeSearch(c[fields.volume] ?? '') === normalizeSearch('مجموعه') && normalizeSearch(c[fields.title] ?? '').includes(base) && ALLOWED_COLLECTIONS.some(name => normalizeSearch(c[fields.title] ?? '').includes(normalizeSearch(name))));
      return {title:x.title.trim(), volume:get('volume'), series:get('series'), isbn:get('isbn'), year:get('year'), size:get('size'), pages:get('pages'), author:x.author.trim(), translator:x.translator.trim(), link:get('link'), collectionLink: collection && fields.link >= 0 ? (collection[fields.link] ?? '').trim() : ''};
    });
  }

  async fetchLivePrice(url) {
    if (!url || !/^https:\/\//i.test(url)) return null;
    try {
      const res = await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; TelegramBookSearch/1.0)'},signal:AbortSignal.timeout(8000)});
      if (!res.ok) return null;
      const html = await res.text();
      const singleStart = html.search(/woo-price-single/i);
      const scoped = singleStart >= 0 ? html.slice(singleStart, singleStart + 12000) : html;
      const block = scoped.match(/<p[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>[\s\S]*?<\/p>/i)?.[0] ?? '';
      const textPrice = htmlPart => {
        const n = htmlPart.match(/([۰-۹0-9,٬.]+)\s*(?:&nbsp;|<[^>]*>)*تومان/i)?.[1];
        return n ? n.replace(/٬/g,',') : '';
      };
      const regular = textPrice(block.match(/<del[\s\S]*?<\/del>/i)?.[0] ?? block);
      const sale = textPrice(block.match(/<ins[\s\S]*?<\/ins>/i)?.[0] ?? block);
      return regular || sale ? {regular:regular || sale, sale:sale || regular} : null;
    } catch { return null; }
  }

  formatBookDetails(b) {
    const lines = [`📚 ${escapeHtml(b.title)}${b.volume && b.volume !== '-' ? ` | جلد ${escapeHtml(b.volume)}` : ''}`];
    if (b.author && b.author !== '-') lines.push(`نویسنده: ${escapeHtml(b.author)}`);
    if (b.translator && b.translator !== '-') lines.push(`مترجم: ${escapeHtml(b.translator)}`);
    if (b.pages && b.pages !== '-') lines.push(`تعداد صفحات: ${escapeHtml(b.pages)}`);
    if (b.year && b.year !== '-') lines.push(`سال انتشار: ${escapeHtml(b.year)}`);
    if (b.size && b.size !== '-') lines.push(`سایز: ${escapeHtml(b.size)}`);
    if (b.isbn && b.isbn !== '-') lines.push(`شابک: ${escapeHtml(b.isbn)}`);
    if (b.livePrice?.regular && b.livePrice?.sale && b.livePrice.regular !== b.livePrice.sale) {
      lines.push(`💰 قیمت: <s>${escapeHtml(b.livePrice.regular)} تومان</s> ← <b>${escapeHtml(b.livePrice.sale)} تومان</b>`);
    } else if (b.livePrice?.sale) lines.push(`💰 قیمت: <b>${escapeHtml(b.livePrice.sale)} تومان</b>`);
    if (b.link && b.link !== '-') lines.push(`لینک محصول: ${escapeHtml(b.link)}`);
    return lines.join('\n');
  }

  favoriteKey(book) { return `${book.link || ''}|${book.title}|${book.volume || ''}`; }

  menuMarkup(user) {
    const hasFavorites = [...this.sql.exec('SELECT 1 FROM favorites WHERE user=? LIMIT 1',user)].length > 0;
    const rows = [['پیشنهاد','پرسش'], hasFavorites ? [BOOK_SEARCH,'⭐ علاقه‌مندی‌ها'] : [BOOK_SEARCH]];
    return {keyboard:rows,resize_keyboard:true};
  }

  async sendFavorites(user) {
    const rows = [...this.sql.exec('SELECT token,details FROM favorites WHERE user=? ORDER BY created DESC',user)];
    if (!rows.length) { await this.send(user,'⭐ هنوز کتابی به علاقه‌مندی‌ها اضافه نکرده‌اید.'); return; }
    const keyboard = rows.map(row => { const b=JSON.parse(row.details); return [{text:`${b.title}${b.volume && b.volume !== '-' ? ` | جلد ${b.volume}` : ''}`,callback_data:`favbook:${row.token}`}]; });
    await this.send(user,'⭐ کتاب‌های موردعلاقهٔ شما\n\nبرای دیدن مشخصات روی عنوان کتاب بزنید:',{reply_markup:{inline_keyboard:keyboard}});
  }

  async favoriteMarkup(user, book, resultToken = null, favoriteToken = null) {
    const buttons = [];
    if (book.link) buttons.push([{text:'🌐 مشاهده در سایت',url:book.link},{text:'🛒 خرید کتاب',url:book.link}]);
    if (book.collectionLink) buttons.push([{text:'📚 دیدن مجموعه',url:book.collectionLink}]);
    if (favoriteToken) buttons.push([{text:'💛 حذف از علاقه‌مندی‌ها',callback_data:`unfav:${favoriteToken}`}]);
    else if (resultToken) {
      const existing = [...this.sql.exec('SELECT token FROM favorites WHERE user=? AND book_key=?',user,this.favoriteKey(book))][0];
      buttons.push([{text:existing ? '💛 حذف از علاقه‌مندی‌ها' : '⭐ افزودن به علاقه‌مندی‌ها',callback_data:existing ? `unfav:${existing.token}` : `fav:${resultToken}`}]);
    }
    if (resultToken) buttons.push([{text:'🔙 بازگشت به نتایج',callback_data:`back:${resultToken}`}]);
    return {inline_keyboard:buttons};
  }

  async sendBookResults(user, query, page = 0, searchToken = null, editMessageId = null) {
    const results = await this.searchBooks(query);
    if (!results.length) {
      const searchToken = crypto.randomUUID();
      this.sql.exec('INSERT OR REPLACE INTO book_searches VALUES (?,?,?,?)',user,searchToken,query,Date.now()+15*60*1000);
      await this.send(user,`نتیجه‌ای برای «${query}» پیدا نشد. می‌خواهید درخواستش را ثبت کنید؟`,{reply_markup:{inline_keyboard:[[{text:'📩 ثبت درخواست کتاب',callback_data:`request:${searchToken}`}],[{text:'❌ لغو',callback_data:`cancel:${searchToken}`}]]}});
      return;
    }
    const pageSize = 8;
    const totalPages = Math.ceil(results.length / pageSize);
    if (!searchToken) {
      searchToken = crypto.randomUUID();
      this.sql.exec('INSERT OR REPLACE INTO book_searches VALUES (?,?,?,?)',user,searchToken,query,Date.now()+15*60*1000);
    }
    page = Math.max(0, Math.min(page, totalPages - 1));
    this.sql.exec('DELETE FROM book_results WHERE user=?',user);
    const pageResults = results.slice(page * pageSize, (page + 1) * pageSize);
    const keyboard = [];
    for (const b of pageResults) {
      const token = crypto.randomUUID();
      this.sql.exec('INSERT INTO book_results (user,token,title,details,expires,search_token,page) VALUES (?,?,?,?,?,?,?)',user,token,b.title,JSON.stringify(b),Date.now()+15*60*1000,searchToken,page);
      keyboard.push([{text:`${b.title}${b.volume && b.volume !== '-' ? ` | جلد ${b.volume}` : ''}`,callback_data:`book:${token}`}]);
    }
    const nav = [];
    if (page > 0) nav.push({text:'⬅️ قبلی',callback_data:`page:${searchToken}:${page-1}`});
    if (page < totalPages - 1) nav.push({text:'بعدی ➡️',callback_data:`page:${searchToken}:${page+1}`});
    if (nav.length) keyboard.push(nav);
    const pageLabel = totalPages > 1 ? `\nصفحه ${page+1} از ${totalPages}` : '';
    const text = `📚 نتایج جستجو برای «${query}»${pageLabel}\n\nبرای دیدن مشخصات کامل، روی عنوان کتاب بزنید:`;
    const markup = {inline_keyboard:keyboard};
    if (editMessageId) await this.rawApi('editMessageText',{chat_id:user,message_id:editMessageId,text,reply_markup:markup});
    else await this.send(user,text,{reply_markup:markup});
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
      const request = /^request:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      const cancel = /^cancel:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      if (request || cancel) {
        const token = (request || cancel)[1];
        const session = [...this.sql.exec('SELECT query FROM book_searches WHERE user=? AND token=? AND expires>?',user,token,Date.now())][0];
        if (cancel) {
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'درخواست لغو شد.'});
          await this.send(user,'درخواست ثبت نشد.');
          return new Response('OK');
        }
        if (!session) {
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'این درخواست منقضی شده است.'});
          await this.send(user,'این درخواست منقضی شده است؛ دوباره جستجو کنید.');
          return new Response('OK');
        }
        this.sql.exec('INSERT INTO book_requests (user,query,status,created) VALUES (?,?,?,?)',user,session.query,'new',Date.now());
        const admins = this.env.ADMIN_IDS.split(',');
        for (const adminId of admins) await this.send(adminId,`📚 درخواست جدید کتاب\n\nعبارت جستجو: ${session.query}\n\nبرای بررسی و پیگیری، عبارت بالا را جستجو کنید.`);
        await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'درخواست ثبت شد.'});
        await this.send(user,'✅ درخواست کتاب شما ثبت شد. در صورت موجودشدن یا پیدا شدن اطلاعات، پیگیری می‌شود.');
        return new Response('OK');
      }
      const fav = /^fav:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      const unfav = /^unfav:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      const favbook = /^favbook:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      if (fav || unfav || favbook) {
        if (unfav) {
          this.sql.exec('DELETE FROM favorites WHERE user=? AND token=?',user,unfav[1]);
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'از علاقه‌مندی‌ها حذف شد.'});
          await this.send(user,'💛 کتاب از علاقه‌مندی‌های شما حذف شد.',{reply_markup:this.menuMarkup(user)});
          return new Response('OK');
        }
        const token = (fav || favbook)[1];
        const row = fav ? [...this.sql.exec('SELECT details FROM book_results WHERE user=? AND token=? AND expires>?',user,token,Date.now())][0] : [...this.sql.exec('SELECT details FROM favorites WHERE user=? AND token=?',user,token)][0];
        if (!row) {
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'این نتیجه منقضی شده است.'});
          await this.send(user,'این نتیجه منقضی شده است؛ دوباره جستجو کنید.');
          return new Response('OK');
        }
        const book = JSON.parse(row.details);
        if (fav) {
          const favoriteToken = crypto.randomUUID();
          this.sql.exec('INSERT OR IGNORE INTO favorites (user,token,book_key,details,created) VALUES (?,?,?,?,?)',user,favoriteToken,this.favoriteKey(book),JSON.stringify(book),Date.now());
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'به علاقه‌مندی‌ها اضافه شد.'});
          await this.send(user,'⭐ کتاب به علاقه‌مندی‌های شما اضافه شد. گزینهٔ علاقه‌مندی‌ها به منوی شما اضافه شد.',{reply_markup:this.menuMarkup(user)});
        } else {
          book.livePrice = await this.fetchLivePrice(book.link);
          await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:'مشخصات کتاب ارسال شد.'});
          await this.send(user,this.formatBookDetails(book),{parse_mode:'HTML',reply_markup:await this.favoriteMarkup(user,book,null,token)});
        }
        return new Response('OK');
      }
      const page = /^page:([a-f0-9-]{36}):(\d+)$/.exec(callback.data ?? '');
      if (page) {
        const session = [...this.sql.exec('SELECT query FROM book_searches WHERE user=? AND token=? AND expires>?',user,page[1],Date.now())][0];
        await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:session ? 'در حال نمایش صفحه بعد...' : 'این جستجو منقضی شده است.'});
        if (session) await this.sendBookResults(user,session.query,Number(page[2]),page[1],callback.message.message_id);
        else await this.send(user,'این جستجو منقضی شده است؛ دوباره جستجو کنید.');
        return new Response('OK');
      }
      const back = /^back:([a-f0-9-]{36})$/.exec(callback.data ?? '');
      if (back) {
        const row = [...this.sql.exec('SELECT search_token,page FROM book_results WHERE user=? AND token=? AND expires>?',user,back[1],Date.now())][0];
        const session = row ? [...this.sql.exec('SELECT query FROM book_searches WHERE user=? AND token=? AND expires>?',user,row.search_token,Date.now())][0] : null;
        await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:session ? 'بازگشت به نتایج' : 'این نتیجه منقضی شده است.'});
        if (session) await this.sendBookResults(user,session.query,Number(row.page ?? 0),row.search_token,callback.message.message_id);
        else await this.send(user,'این نتیجه منقضی شده است؛ دوباره جستجو کنید.');
        return new Response('OK');
      }
      const token = /^book:([a-f0-9-]{36})$/.exec(callback.data ?? '')?.[1];
      const row = token ? [...this.sql.exec('SELECT details FROM book_results WHERE user=? AND token=? AND expires>?',user,token,Date.now())][0] : null;
      await this.rawApi('answerCallbackQuery',{callback_query_id:callback.id,text:row ? 'مشخصات کتاب ارسال شد.' : 'این نتیجه منقضی شده است.'});
      if (row) {
        const book = JSON.parse(row.details);
        book.livePrice = await this.fetchLivePrice(book.link);
        await this.send(user,this.formatBookDetails(book),{parse_mode:'HTML',reply_markup:await this.favoriteMarkup(user,book,token)});
      } else await this.send(user,'این نتیجه منقضی شده است؛ دوباره جستجو کنید.');
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
    if (m.text === '⭐ علاقه‌مندی‌ها' || m.text === '/علاقه‌مندی‌ها' || m.text === '/علاقه_مندی_ها') {
      await this.sendFavorites(user);
      return new Response('OK');
    }
    if (m.text === '/start') {
      await this.send(user,admin ? 'پنل مدیر: برای پاسخ روی پیام دریافتی ریپلای کنید.' : WELCOME,
        {reply_markup:this.menuMarkup(user)});
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
