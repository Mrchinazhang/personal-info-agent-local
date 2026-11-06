/* i18n.js —— 零依赖中英双语层
 * 设计要点：
 *  1. 中文原文作字典 key，中文模式零开销；英文字典由 i18n-dict.js 提供 window.I18N_EN。
 *  2. 动态文案（app.js 渲染出来的）走 t()，用户数据是变量，永不经过 t()。
 *  3. 静态文案只扫描 [data-i18n-static] 区域（文本 / placeholder / aria-label / title），
 *     不碰 #main（那里全是用户内容）。
 *  4. 语言偏好只存 localStorage，不上传、不随账号走。
 */
(function () {
  'use strict';

  var KEY = 'pia_lang';
  var EN = window.I18N_EN || {};
  var lang;
  var zhHint = true;
  var refreshFn = null;
  var textOrig = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var attrOrig = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var TOGGLE_IDS = ['lang-toggle', 'lang-toggle-app'];

  function readStore(k) {
    try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function writeStore(k, v) {
    try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) {}
  }
  function detect() {
    var saved = readStore(KEY);
    if (saved === 'zh' || saved === 'en') return saved;
    var n = String((window.navigator && (window.navigator.language || window.navigator.userLanguage)) || 'zh').toLowerCase();
    return n.indexOf('zh') === 0 ? 'zh' : 'en';
  }
  lang = detect();

  function t(s) {
    if (lang !== 'en' || typeof s !== 'string') return s;
    return Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s;
  }
  function currentLang() { return lang; }
  function setZhHint(on) { zhHint = !!on; }
  function setRefresh(fn) { if (typeof fn === 'function') refreshFn = fn; }

  function findEl(id) {
    return (document.getElementById ? document.getElementById(id) : null);
  }
  function syncToggles() {
    TOGGLE_IDS.forEach(function (id) {
      var el = findEl(id);
      if (!el) return;
      el.textContent = lang === 'en' ? '中文' : 'EN';
      el.setAttribute('aria-label', lang === 'en' ? '切换到中文界面' : 'Switch to English');
      el.setAttribute('title', lang === 'en' ? '切换到中文界面' : 'Switch to English');
    });
    var zhTitle = '个人信息管家 Agent';
    if (typeof document.title === 'string') {
      document.title = lang === 'en' ? (EN[zhTitle] || 'Personal Info Agent') : zhTitle;
    }
  }

  function savedText(node, value) {
    if (textOrig) {
      var old = textOrig.get(node);
      if (old === undefined) { textOrig.set(node, value); return value; }
      return old;
    }
    return value;
  }
  function savedAttrs(el) {
    if (attrOrig) {
      var old = attrOrig.get(el);
      if (old) return old;
    }
    var out = {};
    ['placeholder', 'aria-label', 'title'].forEach(function (a) {
      if (el.hasAttribute && el.hasAttribute(a)) out[a] = el.getAttribute(a);
    });
    if (attrOrig) attrOrig.set(el, out);
    return out;
  }

  function translateZone(zone) {
    if (!zone) return;
    // 文本节点：只做「整段 trim 后精确匹配」，不做子串替换，避免误伤
    if (typeof document.createTreeWalker === 'function') {
      var walker = document.createTreeWalker(zone, 4 /* SHOW_TEXT */, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var p = node.parentNode;
        if (!p || p.nodeType !== 1) continue;
        var tag = (p.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'OPTION') continue;
        if (p.hasAttribute && (p.hasAttribute('data-i18n-skip') || p.closest && p.closest('[data-i18n-skip]'))) continue;
        var orig = savedText(node, node.nodeValue);
        var key = String(orig).trim();
        if (!key || key.length > 160 || !/[\u4e00-\u9fff]/.test(key)) continue;
        var en = lang === 'en' ? t(key) : null;
        var translated = !!(en && en !== key);
        node.nodeValue = translated ? String(orig).replace(key, en) : orig;
        // 英文界面下给个中文原文对照（不覆盖元素自带的 title）
        if (translated && zhHint) {
          if (!p.hasAttribute('title') || p.getAttribute('data-i18n-hint')) {
            p.setAttribute('title', key);
            p.setAttribute('data-i18n-hint', '1');
          }
        } else if (p.getAttribute && p.getAttribute('data-i18n-hint')) {
          p.removeAttribute('title');
          p.removeAttribute('data-i18n-hint');
        }
      }
    }
    // 表单 placeholder / aria-label
    if (zone.querySelectorAll) {
      var els = zone.querySelectorAll('[placeholder], [aria-label], [title]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // data-i18n-hint 的 title 是「中文原文对照」，绝不能被翻译成英文
        if (el.hasAttribute && (el.hasAttribute('data-i18n-skip') || el.hasAttribute('data-i18n-hint'))) continue;
        var attrs = savedAttrs(el);
        ['placeholder', 'aria-label', 'title'].forEach(function (a) {
          if (!Object.prototype.hasOwnProperty.call(attrs, a)) return;
          var o = attrs[a];
          el.setAttribute(a, lang === 'en' ? t(o) : o);
        });
      }
    }
  }

  function applyStatic(root) {
    root = root || document;
    var zones = [];
    if (root.nodeType === 1 && root.getAttribute && root.getAttribute('data-i18n-static') !== null) zones.push(root);
    if (root.querySelectorAll) {
      var found = root.querySelectorAll('[data-i18n-static]');
      for (var i = 0; i < found.length; i++) zones.push(found[i]);
    }
    for (var j = 0; j < zones.length; j++) translateZone(zones[j]);
    syncToggles();
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    writeStore(KEY, lang);
    if (document.documentElement) document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyStatic(document);
    if (refreshFn) { try { refreshFn(); } catch (e) {} }
    return lang;
  }
  function toggle() { return setLang(lang === 'en' ? 'zh' : 'en'); }

  function init() {
    if (document.documentElement) document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyStatic(document);
    TOGGLE_IDS.forEach(function (id) {
      var el = findEl(id);
      if (el && !el.getAttribute('data-i18n-bound')) {
        el.setAttribute('data-i18n-bound', '1');
        if (el.addEventListener) el.addEventListener('click', toggle);
      }
    });
  }

  window.I18N = {
    t: t,
    EN: EN,
    currentLang: currentLang,
    setLang: setLang,
    toggle: toggle,
    setZhHint: setZhHint,
    setRefresh: setRefresh,
    applyStatic: applyStatic,
    init: init
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' && document.addEventListener) {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
