/**
 * local-cloud.js —— 云端 SDK 的本地替身（零依赖、零云资源、零费用）
 * ------------------------------------------------------------------
 * 目的：让原版 app.js **一行都不用改** 就能跑在本机 Flask + SQLite 上。
 *
 * 原理：原版只用到 WorkBuddyCloud.createWorkBuddyCloud() 返回对象上的三个模块，
 * 这里原样复刻它们的调用形状，把请求全部转到同源 /api：
 *
 *   cloud.auth.*                  7 个方法  → 本机「单机账号」，打开即用
 *   cloud.database.from(...).*    9 个链式方法 → /api/db（后端生成参数化 SQL）
 *   cloud.llm.models.list()                  → /api/llm/models
 *   cloud.llm.chat.completions.create()     → /api/llm/chat（NDJSON 流式）
 *
 * 为什么不做成「直接在前端操作 IndexedDB」？
 *   1) 原版的数据模型是四张关系表 + 链式查询，用 SQL 复刻最省代码；
 *   2) 模型 API Key / Ollama 地址必须留在后端，前端直连会暴露配置还容易跨域；
 *   3) 统一走 /api 便于后端做白名单、体积限制和 Origin 校验。
 */
(function (global) {
  'use strict';

  var API = (global.PUBLIC_CONFIG && global.PUBLIC_CONFIG.apiBase) || '/api';
  var SESSION_KEY = 'pia_local_session';
  var LOGOUT_KEY = 'pia_local_logged_out';

  // ---------- localStorage 的安全包装：隐私模式 / 禁用存储时不能让页面崩 ----------
  function storeGet(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; }
    catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { if (global.localStorage) global.localStorage.setItem(key, value); }
    catch (e) { /* 忽略：本地版没有会话也能继续用 */ }
  }
  function storeDel(key) {
    try { if (global.localStorage) global.localStorage.removeItem(key); }
    catch (e) {}
  }

  function isEn() {
    return !!(global.I18N && global.I18N.currentLang && global.I18N.currentLang() === 'en');
  }
  function msg(zh, en) { return isEn() ? en : zh; }

  /** 统一的 JSON 请求；后端约定 { data, error } 形状，HTTP 非 2xx 抛 Error。 */
  function request(path, body, signal) {
    var init = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    return fetch(API + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(
            (data && data.error && data.error.message) ||
            msg('本地服务请求失败（HTTP ' + res.status + '）',
                'Local service request failed (HTTP ' + res.status + ')')
          );
          err.status = res.status;
          if (data && data.error) err.error = data.error;
          throw err;
        }
        return data || {};
      });
    });
  }

  // ================================================================ Auth
  /**
   * 本地版是「单机账号」：数据只在这台电脑的 SQLite 里，本来就没有第二个人能访问，
   * 再要求短信/邮箱验证码既没意义又要花钱。所以 getSession() 直接返回本机用户，
   * 打开页面即进入主界面（原版登录视图不会显示）。
   *
   * 仍然完整实现 sendOtp / verifyOtp：用户若点了「退出」，会看到登录页，
   * 此时输入任意非空验证码即可重新进入，行为在 README 里写明。
   */
  function localUser() {
    var raw = storeGet(SESSION_KEY);
    if (raw) {
      try { return JSON.parse(raw); } catch (e) { /* 落到下面重建 */ }
    }
    var user = {
      user: { id: 'local', name: msg('本机用户', 'This device') }
    };
    storeSet(SESSION_KEY, JSON.stringify(user));
    return user;
  }

  var auth = {
    getSession: function () {
      return Promise.resolve({
        data: storeGet(LOGOUT_KEY) === '1' ? null : localUser(),
        error: null
      });
    },
    sendOtp: function () {
      // 本地不发送任何短信/邮件，自然也不产生费用
      return Promise.resolve({ data: { verificationId: 'local', isExistingUser: false }, error: null });
    },
    verifyOtp: function (args) {
      if (!args || !String(args.token || '').trim()) {
        return Promise.resolve({
          data: null,
          error: { code: 'request_rejected', message: msg('请输入收到的验证码', 'Enter the code you received') }
        });
      }
      storeDel(LOGOUT_KEY);
      return Promise.resolve({ data: localUser(), error: null });
    },
    signOut: function () {
      storeSet(LOGOUT_KEY, '1');
      return Promise.resolve({ error: null });
    },
    signInWithOAuth: function () {
      // 不能伪造成功：原版会 location.assign(res.data.url)，返回 error 才会安全停下
      return Promise.resolve({
        data: null,
        error: {
          code: 'auth_provider_unavailable',
          message: msg('本地离线版不支持第三方账号登录',
                       'Third-party sign-in is not available in the offline edition')
        }
      });
    },
    handleWorkBuddyCallback: function () { return Promise.resolve({ data: null }); },
    handleWechatWebCallback: function () { return Promise.resolve({ data: null }); }
  };

  // ================================================================ Database
  /**
   * 复刻 Supabase 风格的链式查询。方法只「记录意图」，不立刻发请求；
   * 直到被 await（引擎调用 .then）才一次性把查询描述发给 /api/db。
   * 这样 app.js 里的 .select().order().limit() / .update().eq().select() 完全不用改。
   */
  function Query(table) {
    this.table = table;
    this.op = 'select';
    this.columns = '*';
    this.filters = [];
    this.orderBy = null;
    this.limitN = null;
    this.payload = null;
    this.returning = false;
  }
  Query.prototype.select = function (cols) {
    if (this.op === 'select') this.columns = cols || '*';
    else this.returning = true;   // insert/update/delete 之后的 .select() = RETURNING
    return this;
  };
  Query.prototype.insert = function (rows) {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  };
  Query.prototype.update = function (patch) { this.op = 'update'; this.payload = patch; return this; };
  Query.prototype.delete = function () { this.op = 'delete'; return this; };
  Query.prototype.order = function (col, opts) {
    this.orderBy = { column: col, ascending: !opts || opts.ascending !== false };
    return this;
  };
  Query.prototype.limit = function (n) { this.limitN = n; return this; };
  Query.prototype.eq = function (col, val) {
    this.filters.push({ kind: 'eq', column: col, value: val });
    return this;
  };
  Query.prototype.contains = function (col, arr) {
    this.filters.push({ kind: 'contains', column: col, value: arr });
    return this;
  };
  Query.prototype.or = function (expr) {
    this.filters.push({ kind: 'or', expr: String(expr) });
    return this;
  };
  // thenable：让 `await cloud.database.from('items').select('*')` 生效
  Query.prototype.then = function (resolve, reject) {
    var body = {
      table: this.table,
      op: this.op,
      columns: this.columns,
      filters: this.filters,
      order: this.orderBy,
      limit: this.limitN,
      payload: this.payload,
      returning: this.returning
    };
    return request('/db', body).then(function (res) {
      return { data: res.data, error: res.error || null };
    }).then(resolve, reject);
  };

  var database = {
    from: function (table) { return new Query(table); }
  };

  // ================================================================ LLM
  /**
   * chat.completions.create 必须返回**异步可迭代对象**：原版是
   *   var stream = await cloud.llm...create(payload)
   *   for await (var chunk of stream) { chunk.choices[0].delta.content }
   * async generator 不是 thenable，`await` 会原样返回它，正好对上。
   * 后端按 NDJSON 逐行输出 {"content":"..."}，这里翻译成 OpenAI 风格的 chunk。
   */
  function createCompletion(payload) {
    return (async function* () {
      var res = await fetch(API + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: payload.signal || undefined,
        body: JSON.stringify({
          model: payload.model,
          messages: payload.messages,
          temperature: payload.temperature,
          json: !!(payload.response_format && payload.response_format.type === 'json_object')
        })
      });
      if (!res.ok) {
        var info = await res.json().catch(function () { return {}; });
        var e = new Error(
          (info && info.error && info.error.message) ||
          msg('本地模型调用失败（HTTP ' + res.status + '）',
              'Local model call failed (HTTP ' + res.status + ')')
        );
        if (info && info.error) e.error = info.error;
        throw e;
      }
      if (!res.body || !res.body.getReader) {
        // 某些测试/降级环境只给普通 Response：整段文本当一个 chunk 也能用
        var text = await res.text();
        if (text) yield { choices: [{ delta: { content: text } }] };
        return;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function emit(line) {
        line = String(line).trim();
        if (!line) return null;
        var obj;
        try { obj = JSON.parse(line); } catch (e) { return null; }
        if (obj.error) throw new Error(obj.error);
        return obj.content ? { choices: [{ delta: { content: obj.content } }] } : null;
      }
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        buf += decoder.decode(part.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var chunk = emit(lines[i]);
          if (chunk) yield chunk;
        }
      }
      var last = emit(buf);
      if (last) yield last;
    })();
  }

  var llm = {
    models: {
      list: function () {
        return request('/llm/models').then(function (res) { return res.models || []; });
      }
    },
    chat: { completions: { create: createCompletion } }
  };

  var client = { auth: auth, database: database, llm: llm, storage: {} };

  global.WorkBuddyCloud = {
    // 原版会传入 endpoint / publishableKey 等云资源参数；本地版一律忽略，
    // 仅保留同名工厂函数，保证 app.js 第 18 行不用改。
    createWorkBuddyCloud: function () { return client; }
  };
})(window);
