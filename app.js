/* 个人信息管家 Agent —— 记录 / 分类 / 检索 / 问答 / 总结 */
(function () {
  'use strict'

  // tr = 双语翻译函数：中文模式原样返回，英文模式查 i18n-dict.js 的字典。
  // 用户数据全是变量，永不经过 tr()，因此切换语言不会改动任何已保存内容。
  var tr = window.I18N.t
  var CFG = window.PUBLIC_CONFIG
  var CATEGORY = { idea: tr('想法'), material: tr('资料'), todo: tr('待办') }
  var PRIORITY = { high: tr('高'), medium: tr('中'), low: tr('低') }

  // 分类 / 优先级标签在模块加载时求值一次，切换语言后要重算
  function refreshLabels() {
    CATEGORY.idea = tr('想法'); CATEGORY.material = tr('资料'); CATEGORY.todo = tr('待办')
    PRIORITY.high = tr('高'); PRIORITY.medium = tr('中'); PRIORITY.low = tr('低')
  }

  var cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: CFG.endpoint,
    oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
    publishableKey: CFG.publishableKey
  })

  var state = {
    session: null,
    models: [],
    modelId: null,
    items: [],
    links: [],
    chats: [],
    reports: [],
    view: 'capture',
    authMethod: 'phone',   // 'phone' | 'email'，验证码登录的当前通道
    filter: { category: 'all', tag: '', q: '' },
    captureCat: 'auto',
    asking: false,
    reportDays: 7,
    im: { source: 'paste', mode: 'auto', text: '', url: '', result: null, selected: {} }
  }

  /* ---------------- 准入与额度保护 ----------------
   * 说明：这是纯前端护栏，用来挡住"随手转发后被人反复刷短信"的常见情况，
   *       挡不住直接调接口的恶意脚本。要彻底限制，把 registerOpen 改成 false
   *       并把允许的手机号填进 whitelist。
   */
  var GUARD = {
    registerOpen: true,   // false = 只有 whitelist 里的号码能注册/登录
    whitelist: [],        // 例：['13800138000', '13900139000']
    smsPerPhone: 3,       // 同一手机号每天最多获取几次验证码
    smsPerDay: 30,        // 全站每天最多发出多少条验证码（额度保险丝）
    regPerDevice: 3       // 同一浏览器每天最多新建几个账号
  }

  /* ---------------- 工具 ---------------- */
  function $(sel) { return document.querySelector(sel) }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)) }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  var toastTimer = null
  function toast(msg, ms) {
    var el = $('#toast')
    el.textContent = msg
    el.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.classList.add('hidden') }, ms || 2600)
  }

  function fmtDate(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    var p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function fmtDay(iso) { return iso ? String(iso).slice(0, 10) : '' }

  function unwrap(res) {
    if (res.error) throw res.error
    return res.data
  }

  /* ---------------- 额度计数（按天、按浏览器） ---------------- */
  function guardDay() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
  }
  function guardGet(k) {
    try { return parseInt(localStorage.getItem('pi_g_' + k + '_' + guardDay()) || '0', 10) || 0 } catch (e) { return 0 }
  }
  function guardInc(k) {
    try { localStorage.setItem('pi_g_' + k + '_' + guardDay(), String(guardGet(k) + 1)) } catch (e) {}
  }
  // 放行返回 null，拦截返回提示文案。手机号与邮箱共用同一套额度策略，按通道分开计数。
  function guardCheck(channel, value) {
    if (!GUARD.registerOpen && GUARD.whitelist.indexOf(value) < 0) return tr('该账号暂未开通使用权限')
    if (guardGet('otp_' + channel + '_' + value) >= GUARD.smsPerPhone) return tr('该账号今天获取验证码次数已达上限，请明天再试')
    if (guardGet('smsall') >= GUARD.smsPerDay) return tr('本站今日验证码发送量已达上限，请明天再试')
    if (guardGet('reg') >= GUARD.regPerDevice) return tr('当前浏览器今日注册账号数已达上限，请明天再试')
    return null
  }

  /* ---------------- 登录标识校验 ----------------
   * 大陆号保持 11 位原样交给 SDK（SDK 自己补 +86，应用侧不要重复规范化）；
   * 海外号只去掉用户输入的空格/连字符，保留 + 区号原样交给 SDK。
   */
  function normalizeLoginValue(method, raw) {
    var v = String(raw == null ? '' : raw).trim()
    if (method === 'email') return v.toLowerCase()
    var n = v.replace(/[\s\-()]/g, '')
    // 用户给大陆号手动加 +86 时去掉前缀，把 11 位原样交给 SDK 规范化。
    // 否则 SDK 会把它当成「海外号码」原样保存，生成与纯 11 位号码不同的账号，
    // 用户会以为「换了种写法就看不到原来的数据」。
    if (/^\+86(1\d{10})$/.test(n)) return n.slice(3)
    return n
  }
  function validateLoginValue(method, raw) {
    var v = normalizeLoginValue(method, raw)
    if (method === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v)) return tr('请输入正确的邮箱地址')
      return null
    }
    if (/^1\d{10}$/.test(v)) return null
    if (/^\+[1-9]\d{6,14}$/.test(v)) return null
    return tr('中国大陆请输入 11 位手机号；海外号码请以 + 区号开头（如 +14155550123）')
  }

  /* ---------------- 大模型 ---------------- */
  function llmErrorText(err) {
    if (err && err.timeout) return err.message
    var code = (err && err.error && err.error.code) || ''
    var msg = (err && err.error && err.error.message) || (err && err.message) || ''
    if (code.indexOf('auth_') === 0) return tr('AI 服务鉴权未通过，请刷新页面后重试')
    if (code.indexOf('quota_') === 0) return tr('AI 调用额度已用尽或触发限流，请稍后再试')
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return tr('AI 服务暂时不可用，请稍后重试')
    if (code.indexOf('request_') === 0) return tr('AI 请求被拒绝：') + msg
    if (code.indexOf('internal_') === 0) return tr('AI 服务内部错误，请稍后重试')
    return msg || tr('AI 调用失败，请稍后重试')
  }

  // 每次调用都必须以 system 消息开头；统一走 stream: true
  function callLLM(messages, opts) {
    opts = opts || {}
    var ctrl = new AbortController()
    var payload = {
      model: state.modelId,
      messages: messages,
      stream: true,
      temperature: opts.json ? 0.35 : 0.7,
      signal: ctrl.signal
    }
    if (opts.json) payload.response_format = { type: 'json_object' }

    var timer = setTimeout(function () {
      try { ctrl.abort() } catch (e) {}
    }, opts.timeout || 90000)

    var acc = ''
    return (async function () {
      try {
        var stream = await cloud.llm.chat.completions.create(payload)
        for await (var chunk of stream) {
          var choice = chunk.choices && chunk.choices[0]
          var delta = choice && choice.delta
          if (delta && delta.content) {
            acc += delta.content
            if (opts.onDelta) opts.onDelta(delta.content)
          }
        }
        return acc
      } catch (e) {
        if (ctrl.signal.aborted) {
          var t = new Error(tr('AI 响应超时，请重试或换一段更短的内容'))
          t.timeout = true
          throw t
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  function parseJSON(text) {
    var s = String(text || '').trim()
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    var start = s.indexOf('{')
    var end = s.lastIndexOf('}')
    if (start >= 0 && end > start) s = s.slice(start, end + 1)
    return JSON.parse(s)
  }

  function sys(text) {
    // 内部指令随界面语言切换（字典已提供英文版），输出语言由下面的 suffix 统一指定。
    // JSON 字段名与枚举值是代码契约，必须保持英文，绝不翻译。
    var suffix = (window.I18N && window.I18N.currentLang() === 'en')
      ? '\n\nRespond in English. Keep JSON keys and enum values (idea/material/todo, high/medium/low) unchanged.'
      : ''
    return { role: 'system', content: text + suffix }
  }

  // 改成函数：切换语言后下一次调用重新求值，不会残留旧语言
  function sysBase() {
    return tr('你是「个人信息管家」的智能整理引擎，服务于一位用户的私人知识库。') +
      tr('只依据用户给出的内容作答，不编造事实，不臆测未提供的信息。输出使用简体中文，简洁克制。')
  }

  /* ---------------- 认证 ---------------- */
  var pendingOtp = null

  function ensureSession() {
    if (state.session) return true
    showAuth()
    toast(tr('请先登录后再操作'))
    return false
  }

  async function restoreAuth() {
    var url = new URL(location.href)
    var hasCode = url.searchParams.has('code')
    var hasErr = url.searchParams.has('error')
    if (!hasCode && !hasErr) {
      await continueNormalStartup()
      return
    }
    var provider = url.searchParams.get('provider')
    if (provider !== 'workbuddy' && provider !== 'wechat') {
      setAuthError(tr('授权回调缺少有效的登录方式，请重新登录。'))
      showAuth()
      return
    }
    var handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback
    if (typeof handler !== 'function') {
      setAuthError(tr('当前环境暂不支持该登录方式，请改用手机号登录。'))
      showAuth()
      return
    }
    var res = await handler.call(cloud.auth)
    if (res.error) {
      setAuthError(res.error.message)
      showAuth()
      return
    }
    if (res.data) {
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      url.searchParams.delete('provider')
      history.replaceState(null, '', url.pathname + url.search + url.hash)
      state.session = res.data
      await enterApp()
    } else {
      await continueNormalStartup()
    }
  }

  async function continueNormalStartup() {
    var res = await cloud.auth.getSession()
    if (res.error || !res.data) {
      showAuth()
      return
    }
    state.session = res.data
    await enterApp()
  }

  function showAuth() {
    $('#auth-view').classList.remove('hidden')
    $('#app-view').classList.add('hidden')
  }

  function showApp() {
    $('#auth-view').classList.add('hidden')
    $('#app-view').classList.remove('hidden')
  }

  function setAuthError(msg) {
    $('#auth-error').textContent = msg || ''
  }

  function renderUser() {
    var u = state.session && state.session.user
    var name = (u && (u.name || u.phone || u.email)) || tr('我的账号')
    $('#user-chip').textContent = '👤 ' + name
  }

  var codeTimer = null
  function startCountdown(sec) {
    var btn = $('#send-code-btn')
    var left = sec
    btn.disabled = true
    btn.textContent = left + tr('s 后重发')
    clearInterval(codeTimer)
    codeTimer = setInterval(function () {
      left -= 1
      if (left <= 0) {
        clearInterval(codeTimer)
        btn.disabled = false
        btn.textContent = tr('获取验证码')
      } else {
        btn.textContent = left + tr('s 后重发')
      }
    }, 1000)
  }

  function currentLoginInput() {
    var method = state.authMethod
    return {
      method: method,
      input: $(method === 'email' ? '#email-input' : '#phone-input'),
      error: $(method === 'email' ? '#email-error' : '#phone-error'),
      label: method === 'email' ? tr('邮箱') : tr('手机号')
    }
  }

  function switchAuthMethod(method) {
    if (method !== 'phone' && method !== 'email') return
    state.authMethod = method
    $$('.auth-tab').forEach(function (b) {
      var on = b.getAttribute('data-method') === method
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    $('#pane-phone').classList.toggle('hidden', method !== 'phone')
    $('#pane-email').classList.toggle('hidden', method !== 'email')
    $('#phone-error').textContent = ''
    $('#email-error').textContent = ''
    $('#code-input').value = ''
    setAuthError('')
    pendingOtp = null
    clearInterval(codeTimer)
    var send = $('#send-code-btn')
    send.disabled = false
    send.textContent = tr('获取验证码')
  }

  // OAuth 回调必须落在站点根路径，但要保留应用自身的参数（尤其 ?sharecode=…）。
  // 用 location.origin 会把 sharecode 丢掉，回调后落到「链接不完整」占位页。
  function oauthRedirect() {
    var back = new URL(location.href)
    back.pathname = '/'
    ;['code', 'state', 'provider'].forEach(function (k) { back.searchParams.delete(k) })
    return back.toString()
  }
  function oauthError(res, fallback) {
    if (!res || !res.error) return false
    var msg = res.error.message || fallback
    setAuthError(msg + tr('（若提示未开通，请在 WorkBuddy 管理页 → 认证 中开启该登录方式）'))
    return true
  }

  function bindAuth() {
    // 国际用户（浏览器非中文）默认落在邮箱 Tab：Gmail / Outlook 直接收码，无需手机号
    if (window.I18N && window.I18N.currentLang() === 'en') switchAuthMethod('email')
    $('#phone-input').addEventListener('input', function () { $('#phone-error').textContent = '' })
    $('#email-input').addEventListener('input', function () { $('#email-error').textContent = '' })
    $$('.auth-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchAuthMethod(b.getAttribute('data-method')) })
    })

    $('#send-code-btn').addEventListener('click', async function () {
      var ctx = currentLoginInput()
      var err = validateLoginValue(ctx.method, ctx.input.value)
      if (err) { ctx.error.textContent = err; return }
      var value = normalizeLoginValue(ctx.method, ctx.input.value)
      var blocked = guardCheck(ctx.method, value)
      if (blocked) { ctx.error.textContent = blocked; return }
      ctx.error.textContent = ''
      setAuthError('')
      var btn = this
      btn.disabled = true
      btn.textContent = tr('发送中…')
      // email 与 phone 互斥，一次只传一个
      var payload = {}
      payload[ctx.method] = value
      var sent = await cloud.auth.sendOtp(payload)
      btn.disabled = false
      if (sent.error) {
        btn.textContent = tr('获取验证码')
        setAuthError(sent.error.message || tr('验证码发送失败'))
        return
      }
      pendingOtp = {
        method: ctx.method,
        value: value,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser
      }
      guardInc('smsall')
      guardInc('otp_' + ctx.method + '_' + value)
      if (sent.data && sent.data.isExistingUser === false) guardInc('reg')
      toast(ctx.method === 'email' ? tr('验证码已发送到邮箱') : tr('验证码已发送'))
      startCountdown(60)
    })

    $('#login-btn').addEventListener('click', async function () {
      var ctx = currentLoginInput()
      var err = validateLoginValue(ctx.method, ctx.input.value)
      if (err) { ctx.error.textContent = err; return }
      var value = normalizeLoginValue(ctx.method, ctx.input.value)
      var code = $('#code-input').value.trim()
      if (!code) { setAuthError(tr('请输入收到的验证码')); return }
      if (!pendingOtp || pendingOtp.method !== ctx.method || pendingOtp.value !== value) {
        setAuthError(tr('请先为当前登录方式重新获取验证码'))
        return
      }
      var btn = this
      btn.disabled = true
      btn.textContent = tr('登录中…')
      var args = {
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token: code
      }
      args[pendingOtp.method] = pendingOtp.value
      var done = await cloud.auth.verifyOtp(args)
      btn.disabled = false
      btn.textContent = tr('登录 / 注册')
      if (done.error) {
        setAuthError(done.error.message || tr('验证码不正确'))
        return
      }
      pendingOtp = null
      state.session = done.data
      await enterApp()
    })

    $('#wechat-btn').addEventListener('click', async function () {
      setAuthError('')
      var res = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: oauthRedirect() })
      if (oauthError(res, tr('微信登录不可用'))) return
      location.assign(res.data.url)
    })

    $('#workbuddy-btn').addEventListener('click', async function () {
      setAuthError('')
      var res = await cloud.auth.signInWithOAuth({ provider: 'workbuddy', redirectTo: oauthRedirect() })
      if (oauthError(res, tr('WorkBuddy 登录不可用'))) return
      location.assign(res.data.url)
    })

    $('#logout-btn').addEventListener('click', async function () {
      await cloud.auth.signOut()
      state.session = null
      state.items = []
      state.links = []
      state.chats = []
      state.reports = []
      showAuth()
    })
  }

  /* ---------------- 模型 ---------------- */
  async function loadModels() {
    var list = await cloud.llm.models.list()
    var arr = Array.isArray(list) ? list : (list && list.data) || []
    state.models = arr.filter(function (m) { return m && m.id && m.enabled !== false && m.disabled !== true })
    if (!state.models.length) {
      toast(tr('当前没有可用的 AI 模型，AI 整理功能将不可用'))
      return
    }
    var def = state.models.filter(function (m) { return m.isDefault })[0] || state.models[0]
    state.modelId = def.id
    var sel = $('#model-select')
    sel.innerHTML = state.models.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.name || m.id) + '</option>'
    }).join('')
    sel.value = state.modelId
    sel.addEventListener('change', function () { state.modelId = sel.value })
  }

  /* ---------------- 数据 ---------------- */
  async function loadItems() {
    var q = cloud.database.from('items').select('*').order('created_at', { ascending: false }).limit(300)
    if (state.filter.category !== 'all') q = q.eq('category', state.filter.category)
    if (state.filter.tag) q = q.contains('tags', [state.filter.tag])
    state.items = unwrap(await q) || []
  }

  async function loadLinks() {
    state.links = unwrap(await cloud.database.from('item_links').select('*').order('created_at', { ascending: false }).limit(500)) || []
  }

  async function loadChats() {
    state.chats = unwrap(await cloud.database.from('chats').select('*').order('created_at', { ascending: false }).limit(30)) || []
  }

  async function loadReports() {
    state.reports = unwrap(await cloud.database.from('reports').select('*').order('created_at', { ascending: false }).limit(30)) || []
  }

  async function refresh() {
    await Promise.all([loadItems(), loadLinks()])
    render()
  }

  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]
    return null
  }

  function relationsOf(id) {
    var out = []
    state.links.forEach(function (l) {
      var otherId = null
      if (l.source_id === id) otherId = l.target_id
      else if (l.target_id === id) otherId = l.source_id
      if (otherId == null) return
      var it = itemById(otherId)
      if (it) out.push({ item: it, reason: l.reason })
    })
    return out
  }

  function allTags() {
    var set = {}
    state.items.forEach(function (it) { (it.tags || []).forEach(function (t) { set[t] = (set[t] || 0) + 1 }) })
    return Object.keys(set).sort(function (a, b) { return set[b] - set[a] })
  }

  function visibleItems() {
    var kw = state.filter.q.trim().toLowerCase()
    if (!kw) return state.items
    return state.items.filter(function (it) {
      var hay = [it.title, it.content, it.summary, (it.tags || []).join(' '), (it.key_points || []).join(' ')].join(' ').toLowerCase()
      return hay.indexOf(kw) >= 0
    })
  }

  /* ---------------- 视图渲染 ---------------- */
  // 切换语言会重绘 #main：先缓存未提交的输入与已生成的结果，重绘后写回，
  // 避免国际用户切到英文时丢失正在写的草稿或刚生成的总结 / 回答。
  var PRESERVE_BOXES = ['answer-box', 'refs-box', 'report-box', 'plan-box']
  function snapshotView() {
    var snap = { values: {}, boxes: {} }
    $$('#main textarea, #main input').forEach(function (el) {
      if (el.id && typeof el.value === 'string') snap.values[el.id] = el.value
    })
    PRESERVE_BOXES.forEach(function (id) {
      var el = document.getElementById(id)
      if (el) snap.boxes[id] = { html: el.innerHTML, cls: el.className }
    })
    return snap
  }
  function restoreView(snap) {
    if (!snap) return
    Object.keys(snap.values).forEach(function (id) {
      var el = document.getElementById(id)
      if (el) el.value = snap.values[id]
    })
    Object.keys(snap.boxes).forEach(function (id) {
      var el = document.getElementById(id)
      if (el) { el.innerHTML = snap.boxes[id].html; el.className = snap.boxes[id].cls }
    })
  }

  function render(preserve) {
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === state.view) })
    var snap = preserve ? snapshotView() : null
    var main = $('#main')
    if (state.view === 'capture') main.innerHTML = viewCapture()
    else if (state.view === 'import') main.innerHTML = viewImport()
    else if (state.view === 'library') main.innerHTML = viewLibrary()
    else if (state.view === 'todos') main.innerHTML = viewTodos()
    else if (state.view === 'ask') main.innerHTML = viewAsk()
    else main.innerHTML = viewReports()
    restoreView(snap)   // 必须早于 bindView()，事件才绑到恢复后的节点上
    bindView()
  }

  function viewCapture() {
    return '' +
      '<div class="card">' +
        tr('<h2 class="card-title">记下此刻的想法</h2>') +
        tr('<p class="card-desc">粘贴或输入任意内容。AI 会判断它属于想法 / 资料 / 待办，自动生成标题、标签、摘要与重点，并把它关联到已有的相关内容。</p>') +
        tr('<textarea id="capture-input" class="big" placeholder="例如：下周要把物联网实训的传感器数据接进 Flask，记得先申请云平台 API Key，文档在共享盘 /iot 目录下…"></textarea>') +
        '<div class="row" style="margin-top:14px">' +
          tr('<span class="time">分类</span>') +
          tr('<button type="button" class="chip active" data-cat="auto">自动判断</button>') +
          tr('<button type="button" class="chip" data-cat="idea">想法</button>') +
          tr('<button type="button" class="chip" data-cat="material">资料</button>') +
          tr('<button type="button" class="chip" data-cat="todo">待办</button>') +
          '<div class="spacer"></div>' +
          tr('<button type="button" id="capture-save" class="btn btn-solid">保存并智能整理</button>') +
        '</div>' +
        '<div class="row" style="margin-top:10px">' +
          tr('<span class="time">要录入网页文章、聊天记录或本地文件？</span>') +
          tr('<button type="button" class="btn btn-sm" id="goto-import">📥 去内容导入</button>') +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        tr('<div class="section-head"><h2>最近记录</h2><span class="time">共 ') + state.items.length + tr(' 条</span></div>') +
        renderItemList(state.items.slice(0, 5)) +
      '</div>'
  }

  function viewLibrary() {
    var tags = allTags()
    var list = visibleItems()
    var head = '' +
      '<div class="card">' +
        '<div class="filters">' +
          '<button type="button" class="chip' + (state.filter.category === 'all' ? ' active' : '') + tr('" data-cat="all">全部</button>') +
          '<button type="button" class="chip' + (state.filter.category === 'idea' ? ' active' : '') + tr('" data-cat="idea">想法</button>') +
          '<button type="button" class="chip' + (state.filter.category === 'material' ? ' active' : '') + tr('" data-cat="material">资料</button>') +
          '<button type="button" class="chip' + (state.filter.category === 'todo' ? ' active' : '') + tr('" data-cat="todo">待办</button>') +
          tr('<input id="search-input" class="search-input" placeholder="关键词检索：标题 / 正文 / 摘要 / 标签 / 要点" value="') + esc(state.filter.q) + '" />' +
        '</div>' +
        (tags.length ? '<div class="filters" style="margin-top:10px">' +
          tr('<span class="time">标签</span>') +
          '<button type="button" class="chip' + (!state.filter.tag ? ' active' : '') + tr('" data-tag="">不限</button>') +
          tags.slice(0, 14).map(function (t) {
            return '<button type="button" class="chip' + (state.filter.tag === t ? ' active' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + '</button>'
          }).join('') +
        '</div>' : '') +
      '</div>'
    return head + tr('<div class="section-head"><h2>共 ') + list.length + tr(' 条</h2></div>') + renderItemList(list)
  }

  function renderItemList(list) {
    if (!list.length) {
      return tr('<div class="empty"><div class="empty-icon">🗂️</div><div>还没有内容，去「快速记录」写下第一条吧</div></div>')
    }
    return '<div class="item-list">' + list.map(function (it) {
      var rels = relationsOf(it.id)
      return '' +
        '<div class="item">' +
          '<div class="item-head">' +
            '<h3 class="item-title">' + esc(it.title || tr('（无标题）')) + '</h3>' +
            '<span class="badge badge-' + esc(it.category) + '">' + esc(CATEGORY[it.category] || it.category) + '</span>' +
          '</div>' +
          (it.summary ? '<p class="item-summary">' + esc(it.summary) + '</p>' : '') +
          (it.content ? '<div class="item-content">' + esc(it.content) + '</div>' : '') +
          '<div class="item-meta">' +
            (it.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>' }).join('') +
            (it.priority ? '<span class="badge prio-' + esc(it.priority) + '">' + esc(PRIORITY[it.priority] || it.priority) + tr('优先</span>') : '') +
            (it.due_date ? tr('<span class="time">截止 ') + esc(fmtDay(it.due_date)) + '</span>' : '') +
            '<span class="time">' + esc(fmtDate(it.created_at)) + '</span>' +
            (rels.length ? tr('<span class="time">🔗 关联 ') + rels.length + tr(' 条</span>') : '') +
          '</div>' +
          '<div class="item-actions">' +
            '<button type="button" class="btn btn-sm" data-open="' + it.id + tr('">查看详情</button>') +
            '<button type="button" class="btn btn-sm" data-points="' + it.id + tr('">提取重点</button>') +
            (it.is_todo ? '<button type="button" class="btn btn-sm" data-done="' + it.id + '">' + (it.todo_done ? tr('标记未完成') : tr('标记完成')) + '</button>' : '') +
            '<button type="button" class="btn btn-sm btn-danger" data-del="' + it.id + tr('">删除</button>') +
          '</div>' +
        '</div>'
    }).join('') + '</div>'
  }

  function viewTodos() {
    var todos = state.items.filter(function (it) { return it.is_todo })
    var open = todos.filter(function (t) { return !t.todo_done })
    var done = todos.filter(function (t) { return t.todo_done })
    open.sort(function (a, b) {
      var pa = ['high', 'medium', 'low'].indexOf(a.priority) + 1 || 9
      var pb = ['high', 'medium', 'low'].indexOf(b.priority) + 1 || 9
      if (pa !== pb) return pa - pb
      return (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1
    })
    return '' +
      '<div class="card">' +
        '<div class="section-head">' +
          tr('<h2>待办清单</h2>') +
          tr('<div class="row"><span class="time">未完成 ') + open.length + tr(' · 已完成 ') + done.length + '</span>' +
          tr('<button type="button" class="btn btn-solid btn-sm" id="ai-plan">AI 整理待办</button></div>') +
        '</div>' +
        '<div id="plan-box" class="chat-box hidden" data-placeholder=""></div>' +
        (open.length ? open.map(todoRow).join('') : tr('<div class="empty" style="border:none"><div class="empty-icon">✅</div><div>没有未完成的待办</div></div>')) +
        (done.length ? tr('<div class="section-head" style="margin-top:18px"><h2>已完成</h2></div>') + done.map(todoRow).join('') : '') +
      '</div>'
  }

  function todoRow(it) {
    return '' +
      '<div class="todo-item' + (it.todo_done ? ' done' : '') + '">' +
        '<button type="button" class="todo-check' + (it.todo_done ? ' on' : '') + '" data-toggle="' + it.id + '">' + (it.todo_done ? '✓' : '') + '</button>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="todo-title">' + esc(it.title) + '</div>' +
          '<div class="todo-sub">' +
            (it.priority ? '<span class="badge prio-' + esc(it.priority) + '">' + esc(PRIORITY[it.priority]) + tr('优先</span> ') : '') +
            (it.due_date ? tr('截止 ') + esc(fmtDay(it.due_date)) + ' · ' : '') +
            esc(fmtDate(it.created_at)) +
          '</div>' +
          (it.summary ? '<div class="todo-sub">' + esc(it.summary) + '</div>' : '') +
        '</div>' +
        '<button type="button" class="btn btn-sm" data-open="' + it.id + tr('">详情</button>') +
      '</div>'
  }

  function viewAsk() {
    return '' +
      '<div class="card">' +
        tr('<h2 class="card-title">基于你的资料库提问</h2>') +
        tr('<p class="card-desc">AI 会先在你已记录的 ') + state.items.length + tr(' 条内容中检索相关片段，再作答，并列出引用来源。</p>') +
        '<div class="ask-row">' +
          tr('<input id="ask-input" placeholder="例如：我最近在物联网实训上有哪些待推进的事？" />') +
          tr('<button type="button" class="btn btn-solid" id="ask-btn">提问</button>') +
        '</div>' +
        '<div class="row" style="margin-top:10px">' +
          tr('<span class="time">资料库里没有的内容，可以先导入再提问</span>') +
          tr('<button type="button" class="btn btn-sm" id="goto-import">📥 导入外部内容</button>') +
        '</div>' +
        tr('<div id="answer-box" class="chat-box" data-placeholder="答案会在这里流式生成…" style="margin-top:14px"></div>') +
        '<div id="refs-box" class="row" style="margin-top:10px"></div>' +
      '</div>' +
      '<div class="card">' +
        tr('<div class="section-head"><h2>问答历史</h2></div>') +
        (state.chats.length ? state.chats.map(function (c) {
          return '<div class="history-item"><div class="history-q">Q：' + esc(c.question) + '</div>' +
            '<div class="history-a">' + esc(c.answer) + '</div>' +
            '<div class="time" style="margin-top:6px">' + esc(fmtDate(c.created_at)) + '</div></div>'
        }).join('') : tr('<div class="time">还没有提问记录</div>')) +
      '</div>'
  }

  function viewReports() {
    return '' +
      '<div class="card">' +
        tr('<h2 class="card-title">生成阶段总结</h2>') +
        tr('<p class="card-desc">AI 会汇总选定时间段内的全部记录，输出阶段总结、重点进展与后续行动建议。</p>') +
        '<div class="row">' +
          '<button type="button" class="chip' + (state.reportDays === 7 ? ' active' : '') + tr('" data-days="7">最近 7 天</button>') +
          '<button type="button" class="chip' + (state.reportDays === 30 ? ' active' : '') + tr('" data-days="30">最近 30 天</button>') +
          '<button type="button" class="chip' + (state.reportDays === 90 ? ' active' : '') + tr('" data-days="90">最近 90 天</button>') +
          '<div class="spacer"></div>' +
          tr('<button type="button" class="btn btn-solid" id="gen-report">生成总结</button>') +
        '</div>' +
        '<div id="report-box" class="chat-box hidden" data-placeholder="" style="margin-top:14px"></div>' +
      '</div>' +
      '<div class="card">' +
        tr('<div class="section-head"><h2>历史总结</h2></div>') +
        (state.reports.length ? state.reports.map(renderReport).join('') : tr('<div class="time">还没有生成过总结</div>')) +
      '</div>'
  }

  function renderReport(r) {
    return '' +
      '<div class="report">' +
        '<h3>' + esc(r.period_label) + ' <span class="time">· ' + esc(fmtDate(r.created_at)) + tr(' · 基于 ') + r.item_count + tr(' 条记录</span></h3>') +
        '<div class="report-body">' + esc(r.summary) + '</div>' +
        ((r.highlights && r.highlights.length) ? tr('<div class="list-block"><div class="lb-title">重点进展</div><ul>') +
          r.highlights.map(function (h) { return '<li>' + esc(h) + '</li>' }).join('') + '</ul></div>' : '') +
        ((r.actions && r.actions.length) ? tr('<div class="list-block"><div class="lb-title">后续行动建议</div><ol>') +
          r.actions.map(function (a) { return '<li>' + esc(a) + '</li>' }).join('') + '</ol></div>' : '') +
      '</div>'
  }

  /* ---------------- 内容导入：网页 / 聊天 / 文件 ---------------- */
  var APP_URL = location.origin + location.pathname

  function syncImportText() {
    var t = $('#im-text')
    if (t) state.im.text = t.value
  }

  function htmlToText(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html')
    ;['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer'].forEach(function (tag) {
      Array.prototype.forEach.call(doc.querySelectorAll(tag), function (n) { n.remove() })
    })
    var main = doc.querySelector('article') || doc.querySelector('main') || doc.body
    return String((main && main.textContent) || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  // 网页抓取：直连 → 公共代理 → 失败提示手动粘贴
  async function fetchUrlText(rawUrl) {
    var url = rawUrl.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(tr('请输入以 http:// 或 https:// 开头的完整网址'))
    var lastErr = null
    try {
      var r = await fetch(url, { mode: 'cors', redirect: 'follow', credentials: 'omit' })
      if (r.ok) return htmlToText(await r.text())
      lastErr = new Error('HTTP ' + r.status)
    } catch (e) { lastErr = e }

    var proxies = [
      'https://api.allorigins.win/raw?url=',
      'https://api.codetabs.com/v1/proxy?quest='
    ]
    for (var i = 0; i < proxies.length; i++) {
      try {
        var p = await fetch(proxies[i] + encodeURIComponent(url), { mode: 'cors', credentials: 'omit' })
        if (p.ok) {
          var txt = await p.text()
          if (txt && txt.length > 40) return /<html|<!doctype/i.test(txt.slice(0, 400)) ? htmlToText(txt) : txt
        }
      } catch (e) { lastErr = e }
    }
    throw new Error('CORS_BLOCKED')
  }

  function viewImport() {
    var im = state.im
    var srcPanel = ''
    if (im.source === 'paste') {
      srcPanel = '<div class="row">' +
        tr('<button type="button" class="btn btn-sm" id="im-clipboard">📋 从剪贴板读取</button>') +
        tr('<span class="src-hint" style="margin:0">在网页或聊天窗口里选中内容复制后，点这里一键读入</span></div>')
    } else if (im.source === 'file') {
      srcPanel = '<div class="row"><input type="file" id="im-file" class="file-input" accept=".txt,.md,.markdown,.csv,.json,.log,.html,.htm,.xml,.yml,.yaml" /></div>' +
        tr('<p class="src-hint">支持 txt / md / csv / json / log / html 等文本文件；微信、飞书等导出的聊天记录 txt 可直接上传。文件只在本机读取，不会先上传到服务器。</p>')
    } else {
      srcPanel = '<div class="row">' +
        tr('<input id="im-url" class="search-input" placeholder="https://… 粘贴网页地址" value="') + esc(im.url || '') + '" />' +
        tr('<button type="button" class="btn btn-sm btn-solid" id="im-fetch">抓取正文</button></div>') +
        tr('<p class="src-hint">部分网站禁止跨域读取，抓取失败时会自动尝试公共代理；仍失败请改用「粘贴」方式复制正文。</p>')
    }

    return '' +
      '<div class="card">' +
        tr('<h2 class="card-title">读取外部内容</h2>') +
        tr('<p class="card-desc">把网页文章、聊天对话或本地文件读进来，先让 AI 拆解分析，再逐条勾选入库。</p>') +
        '<div class="filters">' +
          '<button type="button" class="chip' + (im.source === 'paste' ? ' active' : '') + tr('" data-src="paste">📋 粘贴 / 剪贴板</button>') +
          '<button type="button" class="chip' + (im.source === 'file' ? ' active' : '') + tr('" data-src="file">📄 上传文件</button>') +
          '<button type="button" class="chip' + (im.source === 'url' ? ' active' : '') + tr('" data-src="url">🌐 网页链接</button>') +
        '</div>' +
        '<div class="src-panel" style="margin-top:12px">' + srcPanel + '</div>' +
        tr('<label class="mini-label">内容预览（可编辑）</label>') +
        tr('<textarea id="im-text" class="big" placeholder="这里会显示待导入的内容，可以直接修改…">') + esc(im.text) + '</textarea>' +
        '<div class="row" style="margin-top:12px">' +
          '<span class="time" id="im-count">' + im.text.length + tr(' 字</span>') +
          '<div class="spacer"></div>' +
          tr('<span class="time">拆解方式</span>') +
          '<button type="button" class="chip' + (im.mode === 'auto' ? ' active' : '') + tr('" data-mode="auto">自动判断</button>') +
          '<button type="button" class="chip' + (im.mode === 'chat' ? ' active' : '') + tr('" data-mode="chat">聊天记录</button>') +
          '<button type="button" class="chip' + (im.mode === 'article' ? ' active' : '') + tr('" data-mode="article">网页文章</button>') +
          '<button type="button" class="chip' + (im.mode === 'single' ? ' active' : '') + tr('" data-mode="single">整段单条</button>') +
          tr('<button type="button" class="btn" id="im-clear">清空</button>') +
          tr('<button type="button" class="btn btn-solid" id="im-analyze">AI 分析并拆解</button>') +
        '</div>' +
      '</div>' +
      (im.result ? renderImportResult() : '') +
      '<div class="card">' +
        tr('<h2 class="card-title">网页一键抓取小工具</h2>') +
        tr('<p class="card-desc">把下面这段代码存成浏览器书签，之后在任意网页点一下书签，就会自动复制该页正文并打开本站导入页，粘贴即可分析。</p>') +
        '<textarea class="bookmarklet" id="bm-code" readonly>' + esc(bookmarkletCode()) + '</textarea>' +
        '<div class="row" style="margin-top:10px">' +
          tr('<button type="button" class="btn btn-sm" id="bm-copy">复制代码</button>') +
          tr('<span class="src-hint" style="margin:0">使用方法：浏览器书签管理器 → 新建书签 → 网址粘贴这段代码 → 命名「读到管家」</span>') +
        '</div>' +
      '</div>'
  }

  function bookmarkletCode() {
    return tr("javascript:(function(){var s=window.getSelection().toString().trim();var t=s||document.body.innerText;if(!t){alert('没有读到内容');return;}navigator.clipboard.writeText(t).then(function(){alert('已复制 '+t.length+' 字，即将打开导入页');window.open('") + APP_URL + tr("?view=import','_blank');}).catch(function(){prompt('复制这段内容：',t);});})();")
  }

  function renderImportResult() {
    var im = state.im.result
    var picked = Object.keys(state.im.selected).filter(function (k) { return state.im.selected[k] }).length
    return '' +
      '<div class="card" id="im-result-anchor">' +
        tr('<div class="section-head"><h2>AI 分析结果</h2><span class="time">共拆解出 ') + im.items.length + tr(' 条 · 已选 ') + picked + tr(' 条</span></div>') +
        (im.analysis ? '<div class="analysis-box">' + esc(im.analysis) + '</div>' : '') +
        '<div class="row" style="margin-top:14px">' +
          tr('<button type="button" class="btn btn-sm" id="im-all">全选</button>') +
          tr('<button type="button" class="btn btn-sm" id="im-none">全不选</button>') +
          '<div class="spacer"></div>' +
          tr('<button type="button" class="btn btn-solid" id="im-import">导入选中的 ') + picked + tr(' 条</button>') +
        '</div>' +
        '<div style="margin-top:14px">' + im.items.map(function (it, i) {
          return '<div class="result-item">' +
            '<input type="checkbox" class="ri-check" data-idx="' + i + '"' + (state.im.selected[i] ? ' checked' : '') + ' />' +
            '<div class="result-main">' +
              '<div class="result-title">' + esc(it.title) + ' <span class="badge badge-' + esc(it.category) + '">' + esc(CATEGORY[it.category] || it.category) + '</span>' +
              (it.priority ? ' <span class="badge prio-' + esc(it.priority) + '">' + esc(PRIORITY[it.priority]) + tr('优先</span>') : '') + '</div>' +
              (it.summary ? '<div class="result-sum">' + esc(it.summary) + '</div>' : '') +
              (it.key_points && it.key_points.length ? tr('<div class="result-sum">重点：') + esc(it.key_points.join(tr('；'))) + '</div>' : '') +
              (it.content ? '<div class="result-quote">' + esc(it.content) + '</div>' : '') +
            '</div>' +
          '</div>'
        }).join('') + '</div>' +
      '</div>'
  }

  async function analyzeImport() {
    if (!ensureSession()) return
    syncImportText()
    var text = state.im.text.trim()
    if (!text) { toast(tr('请先读入内容')); return }
    state.im.result = null
    state.im.selected = {}
    var btn = $('#im-analyze')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>分析中')
    var slow = setTimeout(function () {
      if (!btn.isConnected) return
      btn.innerHTML = tr('<span class="spin"></span>分析中，内容较长时会久一点')
    }, 5000)

    try {
      if (state.im.mode === 'single') {
        var meta = await classifyText(text.slice(0, 4000), 'auto')
        state.im.result = {
          analysis: '',
          items: [{
            title: meta.title, content: text.slice(0, 4000), category: meta.category,
            tags: meta.tags, summary: meta.summary, key_points: meta.key_points,
            is_todo: meta.is_todo, due_date: meta.due_date, priority: meta.priority
          }]
        }
        state.im.selected = { 0: true }
        finishAnalyze()
        return
      }

      var modeDesc = {
        auto: tr('自行判断内容形态（文章、笔记、聊天记录或杂项），按其内在结构拆分'),
        chat: tr('这是一段聊天 / 对话记录。请按「话题、结论、决策、待办、待确认问题」拆分，每条 content 保留相关的原始发言片段并标明说话人'),
        article: tr('这是一篇网页文章或长文。请拆成若干条独立知识点 / 观点 / 可行动项，每条 content 保留原文中最相关的段落')
      }[state.im.mode] || tr('自行判断')

      var prompt = tr('请读取下面这段外部内容，') + modeDesc + tr('。\n\n') +
        tr('输出 JSON：\n') +
        tr('{"analysis":"200 字以内的整体分析：这段内容在讲什么、关键结论、值得注意的点",') +
        tr('"items":[{"title":"不超过 20 字","content":"300 字以内，提炼或引用原文","category":"idea|material|todo",') +
        tr('"tags":["2-3 个标签"],"summary":"一句话摘要","key_points":["1-3 条重点"],') +
        tr('"is_todo":布尔,"due_date":"YYYY-MM-DD 或 null","priority":"high|medium|low|null"}]}\n\n') +
        tr('要求：最多 12 条；去掉寒暄、重复与无信息量的内容；不要编造原文没有的信息。\n\n') +
        tr('内容如下：\n"""\n') + text.slice(0, 12000) + '\n"""'

      var raw = await callLLM(
        [sys(sysBase() + tr('你负责把外部读入的长文本拆解为结构化的个人知识条目，只输出 JSON。')), { role: 'user', content: prompt }],
        { json: true, timeout: 150000 }
      )
      var obj = parseJSON(raw)
      var items = (obj && obj.items) || []
      items = items.slice(0, 12).map(function (x) {
        return {
          title: String(x.title || '').slice(0, 40) || tr('未命名条目'),
          content: String(x.content || '').slice(0, 1200),
          category: CATEGORY[x.category] ? x.category : (x.is_todo ? 'todo' : 'material'),
          tags: Array.isArray(x.tags) ? x.tags.slice(0, 4) : [],
          summary: String(x.summary || '').slice(0, 120),
          key_points: Array.isArray(x.key_points) ? x.key_points.slice(0, 4) : [],
          is_todo: !!x.is_todo,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? x.due_date : null,
          priority: ['high', 'medium', 'low'].indexOf(x.priority) >= 0 ? x.priority : null
        }
      })
      if (!items.length) { toast(tr('没有拆解出可用条目')); return }
      state.im.result = { analysis: String((obj && obj.analysis) || '').slice(0, 800), items: items }
      items.forEach(function (_, i) { state.im.selected[i] = true })
      finishAnalyze()
    } catch (e) {
      toast(llmErrorText(e), 5000)
    } finally {
      clearTimeout(slow)
      btn.disabled = false
      btn.textContent = tr('AI 分析并拆解')
    }
  }

  function finishAnalyze() {
    render()
    var card = $('#im-result-anchor')
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function doImport() {
    if (!ensureSession()) return
    var res = state.im.result
    var picked = res.items.filter(function (_, i) { return state.im.selected[i] })
    if (!picked.length) { toast(tr('请先勾选要导入的条目')); return }
    var btn = $('#im-import')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>导入中')
    try {
      var rows = picked.map(function (it) {
        return {
          title: it.title, content: it.content, category: it.category, tags: it.tags,
          summary: it.summary, key_points: it.key_points,
          is_todo: it.is_todo, todo_done: false, due_date: it.due_date, priority: it.priority
        }
      })
      var created = unwrap(await cloud.database.from('items').insert(rows).select())
      if (!created || !created.length) throw new Error(tr('导入失败，请确认已登录'))
      toast(tr('已导入 ') + created.length + tr(' 条'))
      state.im.result = null
      state.im.selected = {}
      state.im.text = ''
      await refresh()
      linkBatch(created)
    } catch (e) {
      toast((e && e.message) || tr('导入失败'))
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = tr('重新导入') }
    }
  }

  // 批量关联：一次模型调用，为导入的条目同时建立「彼此之间」与「与已有内容」的关联
  async function linkBatch(newItems) {
    try {
      await loadLinks()
      var newIds = newItems.map(function (x) { return x.id })
      var existing = state.items.filter(function (x) { return newIds.indexOf(x.id) < 0 }).slice(0, 30)
      if (!existing.length && newItems.length < 2) return
      var briefNew = newItems.map(function (c) {
        return 'N' + c.id + ' [' + (CATEGORY[c.category] || c.category) + '] ' + c.title + ' — ' + (c.summary || '').slice(0, 40)
      }).join('\n')
      var briefOld = existing.map(function (c) {
        return 'O' + c.id + ' [' + (CATEGORY[c.category] || c.category) + '] ' + c.title + ' — ' + (c.summary || '').slice(0, 40)
      }).join('\n')
      var prompt = tr('新导入的条目：\n') + briefNew + tr('\n\n已有条目：\n') + (briefOld || tr('（无）')) +
        tr('\n\n请找出真正相关的配对，最多 8 对。输出 JSON：{"links":[{"source":数字,"target":数字,"reason":"不超过 20 字"}]}\n') +
        tr('id 去掉前缀字母后的数字部分。不要关联自己，不要凑数。')
      var raw = await callLLM([sys(sysBase() + tr('你负责发现个人知识库中内容之间的语义关联，只输出 JSON。')), { role: 'user', content: prompt }], { json: true })
      var obj = parseJSON(raw)
      var pairs = (obj && obj.links) || []
      var used = {}
      var n = 0
      for (var i = 0; i < pairs.length && n < 8; i++) {
        var s = Number(pairs[i].source)
        var t = Number(pairs[i].target)
        if (!s || !t || s === t) continue
        if (newIds.indexOf(s) < 0 && newIds.indexOf(t) < 0) continue
        var key = Math.min(s, t) + '-' + Math.max(s, t)
        if (used[key]) continue
        used[key] = 1
        await cloud.database.from('item_links').insert({
          source_id: s, target_id: t, reason: String(pairs[i].reason || '').slice(0, 50)
        })
        n++
      }
      if (n) { await loadLinks(); render() }
    } catch (e) { /* 关联是增强能力，失败不影响导入结果 */ }
  }

  /* ---------------- 视图事件 ---------------- */
  function bindView() {
    if (state.view === 'capture') {
      $$('#main .chip[data-cat]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.captureCat = b.dataset.cat
          $$('#main .chip[data-cat]').forEach(function (x) { x.classList.toggle('active', x === b) })
        })
      })
      $('#capture-save').addEventListener('click', saveCapture)
    }

    if (state.view === 'import') bindImport()

    if (state.view === 'library') {
      $$('#main .chip[data-cat]').forEach(function (b) {
        b.addEventListener('click', function () { state.filter.category = b.dataset.cat; refresh() })
      })
      $$('#main .chip[data-tag]').forEach(function (b) {
        b.addEventListener('click', function () { state.filter.tag = b.dataset.tag; refresh() })
      })
      var si = $('#search-input')
      if (si) {
        si.focus()
        si.addEventListener('input', function () {
          state.filter.q = si.value
          $('#main').innerHTML = viewLibrary()
          bindView()
          var again = $('#search-input')
          if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length) }
        })
      }
    }

    $$('#main [data-open]').forEach(function (b) {
      b.addEventListener('click', function () { openDetail(Number(b.dataset.open)) })
    })
    $$('#main [data-points]').forEach(function (b) {
      b.addEventListener('click', function () { extractPoints(Number(b.dataset.points)) })
    })
    $$('#main [data-del]').forEach(function (b) {
      b.addEventListener('click', function () { removeItem(Number(b.dataset.del)) })
    })
    $$('#main [data-done]').forEach(function (b) {
      b.addEventListener('click', function () { toggleDone(Number(b.dataset.done)) })
    })
    $$('#main [data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () { toggleDone(Number(b.dataset.toggle)) })
    })

    if (state.view === 'todos') {
      var plan = $('#ai-plan')
      if (plan) plan.addEventListener('click', planTodos)
    }
    if (state.view === 'ask') {
      $('#ask-btn').addEventListener('click', ask)
      $('#ask-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') ask() })
    }
    if (state.view === 'reports') {
      $$('#main .chip[data-days]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.reportDays = Number(b.dataset.days)
          $$('#main .chip[data-days]').forEach(function (x) { x.classList.toggle('active', x === b) })
        })
      })
      $('#gen-report').addEventListener('click', genReport)
    }

    var gi = $('#goto-import')
    if (gi) gi.addEventListener('click', function () {
      syncImportText()
      state.view = 'import'
      render()
    })
  }

  function bindImport() {
    $$('#main .chip[data-src]').forEach(function (b) {
      b.addEventListener('click', function () {
        syncImportText()
        state.im.source = b.dataset.src
        render()
      })
    })
    $$('#main .chip[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        syncImportText()
        state.im.mode = b.dataset.mode
        render()
      })
    })

    var ta = $('#im-text')
    if (ta) ta.addEventListener('input', function () {
      state.im.text = ta.value
      var c = $('#im-count')
      if (c) c.textContent = ta.value.length + tr(' 字')
    })

    var clip = $('#im-clipboard')
    if (clip) clip.addEventListener('click', async function () {
      try {
        var txt = await navigator.clipboard.readText()
        if (!txt) { toast(tr('剪贴板里没有内容')); return }
        state.im.text = txt
        render()
        toast(tr('已读入 ') + txt.length + tr(' 字'))
      } catch (e) {
        toast(tr('浏览器拒绝了剪贴板读取，请直接在预览框里按 Ctrl+V 粘贴'))
      }
    })

    var file = $('#im-file')
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0]
      if (!f) return
      if (f.size > 2 * 1024 * 1024) { toast(tr('文件超过 2MB，请拆分后再试')); return }
      var fr = new FileReader()
      fr.onload = function () {
        var txt = String(fr.result || '')
        if (/\.(html?|xml)$/i.test(f.name)) txt = htmlToText(txt)
        state.im.text = txt
        render()
        toast(tr('已读取文件：') + f.name)
      }
      fr.onerror = function () { toast(tr('文件读取失败')) }
      fr.readAsText(f, 'utf-8')
    })

    var fetchBtn = $('#im-fetch')
    if (fetchBtn) fetchBtn.addEventListener('click', async function () {
      var url = $('#im-url').value
      state.im.url = url
      fetchBtn.disabled = true
      fetchBtn.textContent = tr('抓取中…')
      try {
        var txt = await fetchUrlText(url)
        if (!txt || txt.length < 20) throw new Error(tr('没有读到有效正文'))
        state.im.text = txt
        render()
        toast(tr('已抓取 ') + txt.length + tr(' 字'))
      } catch (e) {
        if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = tr('抓取正文') }
        toast(e && e.message === 'CORS_BLOCKED'
          ? tr('该网页不允许跨域读取，请复制正文后改用「粘贴」方式')
          : ((e && e.message) || tr('抓取失败')))
      }
    })

    $('#im-clear').addEventListener('click', function () {
      state.im.text = ''
      state.im.result = null
      state.im.selected = {}
      render()
    })
    $('#im-analyze').addEventListener('click', analyzeImport)

    var bm = $('#bm-copy')
    if (bm) bm.addEventListener('click', function () {
      var el = $('#bm-code')
      el.removeAttribute('readonly')
      el.select()
      try { document.execCommand('copy') } catch (e) {}
      el.setAttribute('readonly', 'readonly')
      toast(tr('小工具代码已复制，去浏览器新建书签粘贴即可'))
    })

    $$('#im-result-anchor .ri-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state.im.selected[cb.dataset.idx] = cb.checked
        updatePickCount()
      })
    })
    $$('#im-result-anchor .result-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.classList && e.target.classList.contains('ri-check')) return
        var cb = el.querySelector('.ri-check')
        if (!cb) return
        cb.checked = !cb.checked
        state.im.selected[cb.dataset.idx] = cb.checked
        updatePickCount()
      })
    })
    var all = $('#im-all')
    if (all) all.addEventListener('click', function () {
      state.im.result.items.forEach(function (_, i) { state.im.selected[i] = true })
      render()
    })
    var none = $('#im-none')
    if (none) none.addEventListener('click', function () {
      state.im.selected = {}
      render()
    })
    var imp = $('#im-import')
    if (imp) imp.addEventListener('click', doImport)
  }

  function updatePickCount() {
    var picked = Object.keys(state.im.selected).filter(function (k) { return state.im.selected[k] }).length
    var btn = $('#im-import')
    if (btn) btn.textContent = tr('导入选中的 ') + picked + tr(' 条')
    var label = document.querySelector('#im-result-anchor .section-head .time')
    if (label && state.im.result) {
      label.textContent = tr('共拆解出 ') + state.im.result.items.length + tr(' 条 · 已选 ') + picked + tr(' 条')
    }
  }

  /* ---------------- 记录：保存 + AI 整理 ---------------- */
  async function saveCapture() {
    if (!ensureSession()) return
    var text = $('#capture-input').value.trim()
    if (!text) { toast(tr('请先输入内容')); return }
    var btn = $('#capture-save')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>整理中…')
    try {
      var meta = await classifyText(text, state.captureCat)
      var row = {
        title: meta.title || text.slice(0, 24),
        content: text,
        category: meta.category || 'idea',
        tags: (meta.tags || []).slice(0, 6),
        summary: meta.summary || '',
        key_points: (meta.key_points || []).slice(0, 6),
        is_todo: !!meta.is_todo,
        todo_done: false,
        due_date: meta.due_date || null,
        priority: meta.priority || null
      }
      var created = unwrap(await cloud.database.from('items').insert(row).select())
      if (!created || !created.length) throw new Error(tr('保存失败，请确认已登录'))
      $('#capture-input').value = ''
      toast(tr('已保存并整理为「') + CATEGORY[row.category] + tr('」'))
      await refresh()
      linkNewItem(created[0])
    } catch (e) {
      toast(llmErrorText(e))
    } finally {
      btn.disabled = false
      btn.textContent = tr('保存并智能整理')
    }
  }

  async function classifyText(text, forced) {
    var prompt = tr('请整理下面这段用户输入，并按要求输出 JSON。\n') +
      tr('字段说明：\n') +
      tr('- title: 不超过 20 字的标题\n') +
      tr('- category: 只能是 idea（灵感/想法/随笔）、material（资料/知识/参考信息）、todo（待办/任务/提醒）之一\n') +
      tr('- tags: 2-4 个中文标签\n') +
      tr('- summary: 一句话摘要，不超过 60 字\n') +
      tr('- key_points: 2-4 条重点信息，每句不超过 30 字\n') +
      tr('- is_todo: 是否包含需要后续执行的动作（布尔值）\n') +
      tr('- due_date: 若原文提到明确日期，输出 YYYY-MM-DD，否则为 null\n') +
      '- priority: high / medium / low / null\n' +
      (forced && forced !== 'auto' ? tr('注意：用户已手动指定分类为 ') + forced + tr('，category 必须等于该值。\n') : '') +
      tr('\n用户输入：\n"""\n') + text.slice(0, 4000) + '\n"""'
    try {
      var raw = await callLLM([sys(sysBase() + tr('你同时是一个精确的结构化信息抽取器，只输出 JSON。')), { role: 'user', content: prompt }], { json: true })
      var obj = parseJSON(raw)
      if (CATEGORY[obj.category]) obj.category = String(obj.category)
      else obj.category = forced && forced !== 'auto' ? forced : 'idea'
      if (forced && forced !== 'auto') obj.category = forced
      if (!Array.isArray(obj.tags)) obj.tags = []
      if (!Array.isArray(obj.key_points)) obj.key_points = []
      if (!obj.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(obj.due_date)) obj.due_date = null
      if (['high', 'medium', 'low'].indexOf(obj.priority) < 0) obj.priority = null
      return obj
    } catch (e) {
      // AI 不可用时降级为纯本地保存，绝不丢用户内容
      return {
        title: text.slice(0, 20),
        category: forced && forced !== 'auto' ? forced : 'idea',
        tags: [], summary: '', key_points: [], is_todo: false, due_date: null, priority: null
      }
    }
  }

  async function linkNewItem(item) {
    if (!state.items.length) return
    try {
      var cands = state.items.filter(function (x) { return x.id !== item.id }).slice(0, 40)
      if (!cands.length) return
      var brief = cands.map(function (c) {
        return 'ID ' + c.id + ' | [' + (CATEGORY[c.category] || c.category) + '] ' + c.title +
          tr(' | 标签: ') + ((c.tags || []).join(',') || tr('无')) +
          tr(' | 摘要: ') + (c.summary || String(c.content || '').slice(0, 50))
      }).join('\n')
      var prompt = tr('新记录：\n标题：') + item.title + tr('\n摘要：') + (item.summary || String(item.content || '').slice(0, 120)) +
        tr('\n标签：') + ((item.tags || []).join(',') || tr('无')) +
        tr('\n\n已有记录列表：\n') + brief +
        tr('\n\n请从已有记录中挑选与新记录真正相关的 0-3 条，输出 JSON：{"related":[{"id":数字,"reason":"不超过 25 字的关联理由"}]}。没有任何相关记录时返回 {"related":[]}。')
      var raw = await callLLM([sys(sysBase() + tr('你负责发现个人知识库中内容之间的语义关联，只输出 JSON。')), { role: 'user', content: prompt }], { json: true })
      var obj = parseJSON(raw)
      var rel = (obj && obj.related) || []
      for (var i = 0; i < rel.length && i < 3; i++) {
        var id = Number(rel[i].id)
        if (!cands.some(function (c) { return c.id === id })) continue
        await cloud.database.from('item_links').insert({
          source_id: item.id,
          target_id: id,
          reason: String(rel[i].reason || '').slice(0, 60)
        })
      }
      await loadLinks()
      render()
    } catch (e) {
      // 关联是增强能力，失败不影响主流程
    }
  }

  /* ---------------- 条目操作 ---------------- */
  async function openDetail(id) {
    var it = itemById(id)
    if (!it) return
    var rels = relationsOf(id)
    $('#modal-body').innerHTML = '' +
      tr('<h3>编辑记录</h3>') +
      tr('<label>标题</label><input id="e-title" value="') + esc(it.title) + '" />' +
      tr('<label>分类</label>') +
      '<div class="row" id="e-cats">' +
        Object.keys(CATEGORY).map(function (c) {
          return '<button type="button" class="chip' + (it.category === c ? ' active' : '') + '" data-c="' + c + '">' + CATEGORY[c] + '</button>'
        }).join('') +
      '</div>' +
      tr('<label>正文</label><textarea id="e-content">') + esc(it.content) + '</textarea>' +
      tr('<label>标签（逗号分隔）</label><input id="e-tags" value="') + esc((it.tags || []).join(',')) + '" />' +
      tr('<label>摘要</label><input id="e-summary" value="') + esc(it.summary || '') + '" />' +
      '<div class="row">' +
        tr('<div style="flex:1"><label>截止日期</label><input id="e-due" type="date" value="') + esc(it.due_date || '') + '" /></div>' +
        tr('<div style="flex:1"><label>优先级</label><input id="e-prio" placeholder="high / medium / low" value="') + esc(it.priority || '') + '" /></div>' +
      '</div>' +
      ((it.key_points && it.key_points.length) ? tr('<label>重点信息</label><div>') +
        it.key_points.map(function (p) { return '<div class="rel-item">' + esc(p) + '</div>' }).join('') + '</div>' : '') +
      (rels.length ? tr('<label>相关内容</label><div>') + rels.map(function (r) {
        return '<div class="rel-item"><b>' + esc(r.item.title) + '</b><div class="rel-reason">' + esc(r.reason || tr('语义相近')) + '</div></div>'
      }).join('') + '</div>' : '') +
      '<div class="modal-foot">' +
        tr('<button type="button" class="btn btn-danger" id="e-del">删除</button>') +
        '<div class="spacer"></div>' +
        tr('<button type="button" class="btn" id="e-cancel">取消</button>') +
        tr('<button type="button" class="btn btn-solid" id="e-save">保存</button>') +
      '</div>'
    $('#modal').classList.remove('hidden')

    var picked = it.category
    $$('#e-cats .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        picked = b.dataset.c
        $$('#e-cats .chip').forEach(function (x) { x.classList.toggle('active', x === b) })
      })
    })
    $('#e-cancel').addEventListener('click', closeModal)
    $('#e-del').addEventListener('click', function () { closeModal(); removeItem(id) })
    $('#e-save').addEventListener('click', async function () {
      var patch = {
        title: $('#e-title').value.trim() || tr('（无标题）'),
        content: $('#e-content').value,
        category: picked,
        tags: $('#e-tags').value.split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
        summary: $('#e-summary').value.trim(),
        due_date: $('#e-due').value || null,
        priority: ['high', 'medium', 'low'].indexOf($('#e-prio').value.trim()) >= 0 ? $('#e-prio').value.trim() : null,
        updated_at: new Date().toISOString()
      }
      var res = await cloud.database.from('items').update(patch).eq('id', id).select()
      if (res.error) { toast(res.error.message || tr('保存失败')); return }
      if (!res.data || !res.data.length) { toast(tr('没有改动任何内容，该记录可能已不存在')); return }
      closeModal()
      await refresh()
      toast(tr('已保存'))
    })
  }

  function closeModal() { $('#modal').classList.add('hidden') }

  async function removeItem(id) {
    if (!confirm(tr('确定删除这条记录吗？删除后无法恢复。'))) return
    var res = await cloud.database.from('items').delete().eq('id', id).select()
    if (res.error) { toast(res.error.message || tr('删除失败')); return }
    if (!res.data || !res.data.length) { toast(tr('没有可删除的记录')); return }
    await cloud.database.from('item_links').delete().or('source_id.eq.' + id + ',target_id.eq.' + id)
    await refresh()
    toast(tr('已删除'))
  }

  async function toggleDone(id) {
    var it = itemById(id)
    if (!it) return
    var res = await cloud.database.from('items')
      .update({ todo_done: !it.todo_done, updated_at: new Date().toISOString() })
      .eq('id', id).select()
    if (res.error) { toast(res.error.message || tr('更新失败')); return }
    if (!res.data || !res.data.length) { toast(tr('没有改动任何内容')); return }
    await refresh()
  }

  async function extractPoints(id) {
    var it = itemById(id)
    if (!it) return
    toast(tr('正在提取重点…'))
    try {
      var prompt = tr('从下面这条记录中提取 3-5 条重点信息，每条不超过 30 字，输出 JSON：{"points":["..."]}\n\n记录：\n标题：') +
        it.title + tr('\n正文：') + String(it.content || '').slice(0, 4000)
      var raw = await callLLM([sys(sysBase() + tr('你负责从个人笔记中提炼关键要点，只输出 JSON。')), { role: 'user', content: prompt }], { json: true })
      var obj = parseJSON(raw)
      var points = (obj && obj.points) || []
      if (!points.length) { toast(tr('没有提取到重点')); return }
      var res = await cloud.database.from('items').update({ key_points: points.slice(0, 5) }).eq('id', id).select()
      if (res.error) { toast(res.error.message); return }
      await refresh()
      toast(tr('已提取 ') + points.length + tr(' 条重点'))
    } catch (e) {
      toast(llmErrorText(e))
    }
  }

  /* ---------------- 智能问答 ---------------- */
  function pickContext(question, limit) {
    var words = String(question).toLowerCase().replace(/[，。？！、\s]+/g, ' ').split(' ').filter(function (w) { return w.length > 1 })
    var scored = state.items.map(function (it) {
      var hay = [it.title, it.content, it.summary, (it.tags || []).join(' '), (it.key_points || []).join(' ')].join(' ').toLowerCase()
      var s = 0
      words.forEach(function (w) { if (hay.indexOf(w) >= 0) s += 1 })
      return { it: it, s: s }
    })
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s
      return new Date(b.it.created_at) - new Date(a.it.created_at)
    })
    return scored.slice(0, limit).filter(function (x) { return x.s > 0 }).map(function (x) { return x.it })
  }

  async function ask() {
    if (!ensureSession()) return
    if (state.asking) return
    var q = $('#ask-input').value.trim()
    if (!q) { toast(tr('请输入问题')); return }
    if (!state.items.length) { toast(tr('资料库还是空的，先记录一些内容吧')); return }
    var box = $('#answer-box')
    box.textContent = ''
    box.dataset.placeholder = ''
    state.asking = true
    var btn = $('#ask-btn')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>生成中')

    try {
      var ctx = pickContext(q, 12)
      var brief = ctx.map(function (c) {
        return 'ID ' + c.id + ' | [' + (CATEGORY[c.category] || c.category) + '] ' + c.title +
          tr('\n摘要：') + (c.summary || '') +
          tr('\n正文：') + String(c.content || '').slice(0, 600) +
          tr('\n要点：') + ((c.key_points || []).join(tr('；')) || tr('无'))
      }).join('\n---\n')
      var prompt = tr('以下是用户资料库中最相关的内容片段：\n\n') + (brief || tr('（没有检索到相关内容）')) +
        tr('\n\n请基于以上内容回答用户的问题。要求：\n') +
        tr('1. 只依据资料作答，资料中没有的信息不要编造，可以直接说明"资料中没有提到"。\n') +
        tr('2. 引用到某条内容时，在其后标注 [ID:数字]。\n') +
        tr('3. 回答控制在 300 字以内，条理清晰。\n\n用户问题：') + q

      var answer = await callLLM(
        [sys(sysBase() + tr('你基于用户私人资料库回答提问，必须标注引用来源。')), { role: 'user', content: prompt }],
        { onDelta: function (d) { box.textContent += d; box.scrollTop = box.scrollHeight } }
      )
      var refs = []
      var re = /\[ID:(\d+)\]/g
      var m
      while ((m = re.exec(answer)) !== null) {
        var id = Number(m[1])
        if (refs.indexOf(id) < 0) refs.push(id)
      }
      $('#refs-box').innerHTML = refs.length
        ? tr('<span class="time">引用来源：</span>') + refs.map(function (id) {
            var it = itemById(id)
            return it ? '<button type="button" class="chip" data-open="' + id + '">' + esc(it.title) + '</button>' : ''
          }).join('')
        : ''
      $$('#refs-box [data-open]').forEach(function (b) {
        b.addEventListener('click', function () { openDetail(Number(b.dataset.open)) })
      })

      await cloud.database.from('chats').insert({ question: q, answer: answer, refs: refs })
      await loadChats()
      render()
      var ab = $('#answer-box')
      if (ab) ab.textContent = answer
    } catch (e) {
      toast(llmErrorText(e))
    } finally {
      state.asking = false
      var b2 = $('#ask-btn')
      if (b2) { b2.disabled = false; b2.textContent = tr('提问') }
    }
  }

  /* ---------------- 待办 AI 整理 ---------------- */
  async function planTodos() {
    if (!ensureSession()) return
    var todos = state.items.filter(function (it) { return it.is_todo && !it.todo_done })
    if (!todos.length) { toast(tr('没有未完成的待办')); return }
    var box = $('#plan-box')
    box.classList.remove('hidden')
    box.textContent = ''
    var btn = $('#ai-plan')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>整理中')
    try {
      var brief = todos.map(function (t, i) {
        return (i + 1) + '. ' + t.title +
          (t.priority ? tr('（优先级：') + PRIORITY[t.priority] + tr('）') : '') +
          (t.due_date ? tr('（截止：') + fmtDay(t.due_date) + tr('）') : '') +
          (t.summary ? ' — ' + t.summary : '')
      }).join('\n')
      var prompt = tr('这些是用户当前未完成的待办：\n') + brief +
        tr('\n\n请把它们整理成一份可执行的推进计划：按紧急与重要程度排序，指出哪些可以合并或拆解，并给出接下来最值得先做的 3 件事。控制在 350 字以内。')
      await callLLM([sys(sysBase() + tr('你是一位高效的个人事务助理。')), { role: 'user', content: prompt }], {
        onDelta: function (d) { box.textContent += d }
      })
    } catch (e) {
      box.textContent = llmErrorText(e)
    } finally {
      btn.disabled = false
      btn.textContent = tr('AI 整理待办')
    }
  }

  /* ---------------- 阶段总结 ---------------- */
  async function genReport() {
    if (!ensureSession()) return
    var days = state.reportDays
    var since = new Date(Date.now() - days * 86400000).toISOString()
    var inRange = state.items.filter(function (it) { return new Date(it.created_at) >= new Date(since) })
    if (!inRange.length) { toast(tr('最近 ') + days + tr(' 天没有记录，换个时间段试试')); return }
    var box = $('#report-box')
    box.classList.remove('hidden')
    box.textContent = tr('正在汇总最近 ') + days + tr(' 天的 ') + inRange.length + tr(' 条记录…')
    var btn = $('#gen-report')
    btn.disabled = true
    btn.innerHTML = tr('<span class="spin"></span>生成中')
    try {
      var brief = inRange.slice(0, 80).map(function (c) {
        return '[' + (CATEGORY[c.category] || c.category) + '] ' + c.title + ' | ' + (c.summary || String(c.content || '').slice(0, 80)) +
          tr(' | 标签: ') + ((c.tags || []).join(',') || tr('无')) + ' | ' + fmtDay(c.created_at)
      }).join('\n')
      var prompt = tr('以下是用户在最近 ') + days + tr(' 天记录的 ') + inRange.length + tr(' 条内容：\n\n') + brief +
        tr('\n\n请生成阶段总结，输出 JSON：\n') +
        tr('{"summary":"200-300 字的阶段总结，说明这段时间关注了什么、推进到什么程度",') +
        tr('"highlights":["3-5 条重点进展，每条不超过 40 字"],') +
        tr('"actions":["3-5 条后续行动建议，具体可执行，每条不超过 40 字"]}')
      var raw = await callLLM([sys(sysBase() + tr('你负责为用户生成阶段复盘与行动建议，只输出 JSON。')), { role: 'user', content: prompt }], { json: true })
      var obj = parseJSON(raw)
      var row = {
        period_label: tr('最近 ') + days + tr(' 天'),
        range_days: days,
        summary: obj.summary || '',
        highlights: (obj.highlights || []).slice(0, 6),
        actions: (obj.actions || []).slice(0, 6),
        item_count: inRange.length
      }
      await cloud.database.from('reports').insert(row)
      await loadReports()
      render()
      var rb = $('#report-box')
      if (rb) {
        rb.classList.remove('hidden')
        rb.innerHTML = renderReport(row)
      }
      toast(tr('总结已生成并保存'))
    } catch (e) {
      box.textContent = llmErrorText(e)
    } finally {
      btn.disabled = false
      btn.textContent = tr('生成总结')
    }
  }

  /* ---------------- 启动 ---------------- */
  async function enterApp() {
    renderUser()
    showApp()
    try {
      await loadModels()
    } catch (e) {
      toast(tr('模型列表加载失败：') + llmErrorText(e))
    }
    try {
      await Promise.all([loadItems(), loadLinks(), loadChats(), loadReports()])
    } catch (e) {
      toast(tr('数据加载失败：') + ((e && e.message) || tr('请稍后重试')))
    }
    render()
  }

  function bindNav() {
    $$('#sidebar .nav-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.view = b.dataset.view
        render()
      })
    })
    $('#modal').addEventListener('click', function (e) { if (e.target === $('#modal')) closeModal() })
  }

  async function boot() {
    bindAuth()
    bindNav()
    var v = new URL(location.href).searchParams.get('view')
    if (v && ['capture', 'import', 'library', 'todos', 'ask', 'reports'].indexOf(v) >= 0) state.view = v
    await restoreAuth()
  }

  // 语言切换时重算常量标签并重绘当前视图（页面骨架由 i18n.js 自己处理）
  if (window.I18N && window.I18N.setRefresh) {
    window.I18N.setRefresh(function () {
      refreshLabels()
      try { render(true) } catch (e) {}
      try { renderUser() } catch (e) {}
    })
  }

  boot()
})()
