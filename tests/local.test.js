/**
 * 本地离线版前端验收测试（Node 原生 assert + vm，零依赖、零网络）
 *
 * 运行： node tests/local.test.js
 *
 * 两套关注点：
 *   1) 静态契约：前端确实脱离了云端 SDK、脚本顺序正确、app.js 与原版字节级一致；
 *   2) 运行契约：在 vm 沙箱里加载 config.js + local-cloud.js，用假 fetch
 *      验证 auth / database / llm 三大模块发给 /api 的请求形状完全符合 server.py。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const CLOUD_ROOT = path.resolve(ROOT, '..', 'personal-info-agent');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
let skipped = 0;

// ---------------------------------------------------------------- 静态契约
t('index.html 不含云端 SDK / CDN / sharecode', () => {
  const html = read('index.html');
  assert.ok(!/cdn\.jsdelivr\.net/.test(html), '仍引入云端 SDK CDN');
  assert.ok(!/workbuddy-cloud-sdk/.test(html), '仍引用云端 SDK');
  assert.ok(!/sharecode/.test(html), '仍带发布链接参数');
  assert.ok(!/https?:\/\/[^\s"']+\.js/.test(html), '存在外链 JS');
});

t('脚本顺序：字典 → i18n → config → local-cloud → app', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const names = srcs.map((s) => s.split('?')[0]);
  assert.deepStrictEqual(names.slice(-5), [
    'i18n-dict.js', 'i18n.js', 'config.js', 'local-cloud.js', 'app.js',
  ]);
});

t('所有静态资源缓存版本号一致（不写死具体值）', () => {
  const html = read('index.html');
  const versions = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 6, '版本号数量过少');
  // 只校验「全部一致 + 格式合法」，不写死某次发版的值：
  // 缓存版本号本来就会随每次发布递增，写死会让每次发版都误报。
  assert.strictEqual(new Set(versions).size, 1, '版本号不一致：' + versions.join(','));
  assert.ok(/^2026[0-9]{4}[a-z]+$/.test(versions[0]), '版本号格式异常：' + versions[0]);
});

t('config.js 无密钥、无云资源、apiBase 指向同源 /api', () => {
  const cfg = read('config.js');
  assert.ok(!/wbpk_|wbcs_|sk-|ghp_|github_pat_/.test(cfg), '含疑似凭证');
  const urls = cfg.match(/https?:\/\/[^\s'"）)]+/g) || [];
  assert.ok(urls.every((u) => /127\.0\.0\.1|localhost/.test(u)),
    '含非本机地址：' + urls.join(', '));
  assert.ok(/apiBase\s*:\s*['"]\/api['"]/.test(cfg));
  assert.ok(/endpoint\s*:\s*['"]['"]/.test(cfg), 'endpoint 应为空');
});

t('local-cloud.js 只访问同源 /api，不含任何外链或密钥', () => {
  const js = read('local-cloud.js');
  assert.ok(!/cdn\.|https?:\/\//.test(js), '存在外部地址');
  assert.ok(!/wbpk_|wbcs_|publishableKey\s*:/.test(js), '含云资源凭证');
  assert.ok(/\/api\/db|\/api\/llm\/models|\/api\/llm\/chat/.test(js));
  assert.ok(/global\.WorkBuddyCloud\s*=/.test(js), '未导出同名工厂');
});

t('server.py 具备回环绑定、Origin 校验、体积上限与离线规则引擎', () => {
  const py = read('server.py');
  for (const token of ['127.0.0.1', 'origin_rejected', 'MAX_BODY_BYTES',
                       'local-rules', 'CREATE TABLE IF NOT EXISTS items',
                       'guard_origin', 'json_each']) {
    assert.ok(py.includes(token), 'server.py 缺少 ' + token);
  }
});

t('前端四个文件与云端开源版字节级一致（app.js 零改动）', () => {
  if (!fs.existsSync(path.join(CLOUD_ROOT, 'app.js'))) {
    skipped++;
    console.log('    (跳过：未找到同级 personal-info-agent 云端版目录)');
    return;
  }
  for (const name of ['app.js', 'i18n.js', 'i18n-dict.js', 'styles.css']) {
    assert.strictEqual(read(name), fs.readFileSync(path.join(CLOUD_ROOT, name), 'utf8'),
      name + ' 与云端版不一致');
  }
});

// ---------------------------------------------------------------- vm 沙箱
function fakeResponse(body, opts = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(opts.text || ''),
    body: opts.body || null,
  };
}

function ndjsonResponse(lines) {
  const enc = new TextEncoder();
  const chunks = lines.map((l) => enc.encode(l + '\n'));
  let i = 0;
  return fakeResponse({}, {
    body: {
      getReader: () => ({
        read: () => Promise.resolve(
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined }
        ),
      }),
    },
  });
}

function makeContext(fetchImpl, lang = 'zh') {
  const calls = [];
  const storage = Object.create(null);
  const ctx = {
    console,
    setTimeout, clearTimeout,
    Promise, JSON, Error, TypeError, Math, Date, String, Number, Boolean,
    Object, Array, RegExp, Symbol, TextDecoder, TextEncoder, Uint8Array,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    I18N: { currentLang: () => lang },
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(fetchImpl ? fetchImpl(url, init) : fakeResponse({ data: [], error: null }));
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('config.js'), ctx, { filename: 'config.js' });
  vm.runInContext(read('local-cloud.js'), ctx, { filename: 'local-cloud.js' });
  return { ctx, calls, storage };
}

function cloudOf(ctx) {
  return ctx.WorkBuddyCloud.createWorkBuddyCloud();
}

function lastBody(calls) {
  const call = calls[calls.length - 1];
  assert.ok(call, '没有发出请求');
  return JSON.parse(call.init.body);
}

// ---------------------------------------------------------------- auth
t('auth.getSession 打开即用，不发任何网络请求', async () => {
  const { ctx, calls } = makeContext();
  const res = await cloudOf(ctx).auth.getSession();
  assert.strictEqual(res.error, null);
  assert.strictEqual(res.data.user.id, 'local');
  assert.strictEqual(calls.length, 0, '不应请求网络');
});

t('英文界面下本机用户名自动变英文', async () => {
  const { ctx } = makeContext(null, 'en');
  const res = await cloudOf(ctx).auth.getSession();
  assert.strictEqual(res.data.user.name, 'This device');
});

t('sendOtp 不发短信/邮件，verifyOtp 空验证码被拒', async () => {
  const { ctx, calls } = makeContext();
  const c = cloudOf(ctx);
  const sent = await c.auth.sendOtp({ phone: '13800000000' });
  assert.strictEqual(sent.data.verificationId, 'local');
  const bad = await c.auth.verifyOtp({ token: '  ' });
  assert.ok(bad.error, '空验证码应返回 error');
  assert.strictEqual(bad.error.code, 'request_rejected');
  assert.strictEqual(calls.length, 0, '本地验证码不应产生任何费用/请求');
});

t('退出后登录页可凭任意非空验证码重新进入', async () => {
  const { ctx, storage } = makeContext();
  const c = cloudOf(ctx);
  await c.auth.signOut();
  assert.strictEqual(storage.pia_local_logged_out, '1');
  assert.strictEqual((await c.auth.getSession()).data, null);
  const ok = await c.auth.verifyOtp({ token: '1234' });
  assert.ok(ok.data && ok.data.user, '应重新拿到本机用户');
  assert.strictEqual(storage.pia_local_logged_out, undefined);
});

t('第三方登录明确报错，绝不伪造成功 URL', async () => {
  const { ctx } = makeContext();
  const res = await cloudOf(ctx).auth.signInWithOAuth({ provider: 'wechat' });
  assert.strictEqual(res.data, null);
  assert.strictEqual(res.error.code, 'auth_provider_unavailable');
  assert.ok(!res.error.url);
});

t('OAuth 回调处理返回空数据，不会误跳转', async () => {
  const { ctx } = makeContext();
  const c = cloudOf(ctx);
  assert.strictEqual((await c.auth.handleWorkBuddyCallback()).data, null);
  assert.strictEqual((await c.auth.handleWechatWebCallback()).data, null);
});

// ---------------------------------------------------------------- database
t('thenable Query 把链式描述完整发给 /api/db', async () => {
  const { ctx, calls } = makeContext();
  const q = cloudOf(ctx).database.from('items')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300)
    .eq('category', 'idea')
    .contains('tags', ['Flask']);
  assert.strictEqual(calls.length, 0, '链式阶段不应发请求');
  await q;
  assert.strictEqual(calls[0].url, '/api/db');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.credentials, 'same-origin');
  const body = lastBody(calls);
  assert.strictEqual(body.table, 'items');
  assert.strictEqual(body.op, 'select');
  assert.strictEqual(body.columns, '*');
  assert.deepStrictEqual(body.order, { column: 'created_at', ascending: false });
  assert.strictEqual(body.limit, 300);
  assert.deepStrictEqual(body.filters[0], { kind: 'eq', column: 'category', value: 'idea' });
  assert.deepStrictEqual(body.filters[1], { kind: 'contains', column: 'tags', value: ['Flask'] });
});

t('insert(rows).select() 设置 returning，update/delete 形状正确', async () => {
  const { ctx, calls } = makeContext();
  const c = cloudOf(ctx);
  await c.database.from('items').insert([{ title: 'A' }, { title: 'B' }]).select();
  let b = lastBody(calls);
  assert.strictEqual(b.op, 'insert');
  assert.strictEqual(b.returning, true);
  assert.strictEqual(b.payload.length, 2);

  await c.database.from('items').update({ title: 'C' }).eq('id', 7).select();
  b = lastBody(calls);
  assert.strictEqual(b.op, 'update');
  assert.strictEqual(b.returning, true);
  assert.deepStrictEqual(b.payload, { title: 'C' });
  assert.deepStrictEqual(b.filters[0], { kind: 'eq', column: 'id', value: 7 });

  await c.database.from('item_links').delete().or('source_id.eq.7,target_id.eq.7');
  b = lastBody(calls);
  assert.strictEqual(b.op, 'delete');
  assert.deepStrictEqual(b.filters[0],
    { kind: 'or', expr: 'source_id.eq.7,target_id.eq.7' });
});

t('DB 请求解包为 {data, error}，业务错误不会被当成成功', async () => {
  const { ctx } = makeContext(() => fakeResponse({
    data: null, error: { code: 'db_error', message: 'boom' },
  }));
  const res = await cloudOf(ctx).database.from('items').select('*');
  assert.strictEqual(res.data, null);
  assert.strictEqual(res.error.code, 'db_error');
});

t('HTTP 非 2xx 抛出带 status 的 Error', async () => {
  const { ctx } = makeContext(() => fakeResponse(
    { error: { code: 'origin_rejected', message: 'blocked' } },
    { ok: false, status: 403 }
  ));
  await assert.rejects(
    () => Promise.resolve(cloudOf(ctx).database.from('items').select('*')),
    (e) => e.status === 403 && /blocked/.test(e.message)
  );
});

// ---------------------------------------------------------------- llm
t('models.list() 走 GET /api/llm/models 并返回数组', async () => {
  const { ctx, calls } = makeContext(() => fakeResponse({
    models: [{ id: 'local-rules', isDefault: true }], error: null,
  }));
  const list = await cloudOf(ctx).llm.models.list();
  assert.strictEqual(calls[0].url, '/api/llm/models');
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(list[0].id, 'local-rules');
});

t('chat 把 NDJSON 流转成 OpenAI 风格 chunk，可 for-await 拼接', async () => {
  const { ctx, calls } = makeContext(() => ndjsonResponse([
    JSON.stringify({ content: '你好' }),
    JSON.stringify({ content: '，世界' }),
    'not-json-should-be-skipped',
    '',
  ]));
  ctx.__payload = {
    model: 'local-rules',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  };
  const assembled = await vm.runInContext(`(async () => {
    var s = await WorkBuddyCloud.createWorkBuddyCloud().llm.chat.completions.create(__payload);
    var acc = '';
    for await (var c of s) { acc += (c.choices[0].delta.content || ''); }
    return acc;
  })()`, ctx);
  assert.strictEqual(assembled, '你好，世界');
  assert.strictEqual(calls[0].url, '/api/llm/chat');
  const body = lastBody(calls);
  assert.strictEqual(body.json, true, 'response_format 应转成 json 标记');
  assert.strictEqual(body.model, 'local-rules');
});

t('chat 无 response_format 时 json=false，且 signal 会透传', async () => {
  const { ctx, calls } = makeContext(() => ndjsonResponse([JSON.stringify({ content: 'ok' })]));
  const controller = new AbortController();
  ctx.__payload = { model: 'local-rules', messages: [], signal: controller.signal };
  await vm.runInContext(`(async () => {
    var s = await WorkBuddyCloud.createWorkBuddyCloud().llm.chat.completions.create(__payload);
    for await (var c of s) { /* drain */ }
  })()`, ctx);
  const body = lastBody(calls);
  assert.strictEqual(body.json, false);
  assert.strictEqual(calls[0].init.signal, controller.signal);
});

t('chat 的 NDJSON error 行会中断流并抛错', async () => {
  const { ctx } = makeContext(() => ndjsonResponse([
    JSON.stringify({ content: 'partial' }),
    JSON.stringify({ error: 'model blew up' }),
  ]));
  ctx.__payload = { model: 'local-rules', messages: [] };
  await assert.rejects(
    () => vm.runInContext(`(async () => {
      var s = await WorkBuddyCloud.createWorkBuddyCloud().llm.chat.completions.create(__payload);
      for await (var c of s) { /* drain */ }
    })()`, ctx),
    /model blew up/
  );
});

t('chat 的 HTTP 错误会抛出可读错误', async () => {
  const { ctx } = makeContext(() => fakeResponse(
    { error: { code: 'request_too_large', message: 'too big' } },
    { ok: false, status: 413 }
  ));
  ctx.__payload = { model: 'local-rules', messages: [] };
  await assert.rejects(
    () => vm.runInContext(`(async () => {
      var s = await WorkBuddyCloud.createWorkBuddyCloud().llm.chat.completions.create(__payload);
      for await (var c of s) { /* drain */ }
    })()`, ctx),
    /too big/
  );
});

// ---------------------------------------------------------------- runner
(async () => {
  console.log('本地离线版前端契约验收（' + cases.length + ' 项）');
  let passed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log('  ok  ' + name);
    } catch (e) {
      console.error('  FAIL ' + name);
      console.error(e && e.stack ? e.stack : e);
      process.exitCode = 1;
    }
  }
  console.log('\n通过 ' + passed + '/' + cases.length +
    (skipped ? '（其中 ' + skipped + ' 项因缺少同级云端版目录而跳过内容比对）' : ''));
  if (process.exitCode) process.exit(1);
})();
