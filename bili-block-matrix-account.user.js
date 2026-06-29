// ==UserScript==
// @name         B站疑似矩阵号标记
// @namespace    https://github.com/user/bili-block-matrix-account
// @version      1.0.0
// @description  在B站全站标记疑似矩阵号：支持用户名替换和评论内容高亮，支持普通关键字和正则匹配
// @author       user
// @match        *://*.bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @run-at       document-end
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置管理模块 ====================
  const STORAGE_KEY = 'matrix_config';
  const DEFAULT_CONFIG = {
    username: {
      regexMode: false,
      rules: [],
      options: {
        highlightColor: '#fb7299',
        prefix: '',
        suffix: ''
      }
    },
    comment: {
      regexMode: false,
      rules: [],
      options: {
        highlightColor: '#fb7299',  // 高亮颜色（背景/边框/mark 底色）
        hideComment: false,         // 是否折叠隐藏
        prefix: '',                 // 评论前缀文本
        suffix: ''                  // 评论后缀文本
      }
    },
    uidRecord: {
      uids: [],                     // 已确认 UID 字符串数组
      label: '(有疑似矩阵记录)'     // 命中已记录 UID 时追加的标记文本
    },
    aiConfig: {
      apiKey: '',                   // 用户自定义 DeepSeek API Key，默认空
      model: 'deepseek-v4-flash'    // 模型名
    }
  };

  // 获取某 type 的默认 options 模板（新建规则继承用）
  function getDefaultOptions(type) {
    var src = DEFAULT_CONFIG[type] && DEFAULT_CONFIG[type].options;
    return src ? JSON.parse(JSON.stringify(src)) : {};
  }

  // 老配置迁移：rules 元素为字符串时转为 {keyword, options, isRegex} 对象
  function migrateRules(rules, type) {
    if (!Array.isArray(rules)) return [];
    var defOpts = getDefaultOptions(type);
    return rules.map(function (r) {
      if (typeof r === 'string') {
        return { keyword: r, options: JSON.parse(JSON.stringify(defOpts)), isRegex: false };
      }
      // 已是对象，确保 options 完整
      if (!r.options) r.options = JSON.parse(JSON.stringify(defOpts));
      else r.options = Object.assign({}, defOpts, r.options);
      // 确保 isRegex 字段存在
      if (typeof r.isRegex !== 'boolean') r.isRegex = false;
      return r;
    });
  }

  let currentConfig = null;
  let currentTab = 'username'; // 面板当前标签页
  let isMutating = false; // 标记脚本自身 DOM 操作进行中，避免 MutationObserver 自激

  function loadConfig() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (raw) {
        const parsed = JSON.parse(raw);
        const comment = Object.assign({}, DEFAULT_CONFIG.comment, parsed.comment || {});
        comment.options = Object.assign({}, DEFAULT_CONFIG.comment.options, (parsed.comment || {}).options || {});
        comment.rules = migrateRules(comment.rules || [], 'comment');
        const username = Object.assign({}, DEFAULT_CONFIG.username, parsed.username || {});
        username.options = Object.assign({}, DEFAULT_CONFIG.username.options, (parsed.username || {}).options || {});
        username.rules = migrateRules(username.rules || [], 'username');
        const uidRecord = Object.assign({}, DEFAULT_CONFIG.uidRecord, parsed.uidRecord || {});
        uidRecord.uids = Array.isArray(uidRecord.uids) ? uidRecord.uids : [];
        const aiConfig = Object.assign({}, DEFAULT_CONFIG.aiConfig, parsed.aiConfig || {});
        return { username: username, comment: comment, uidRecord: uidRecord, aiConfig: aiConfig };
      }
    } catch (e) {
      console.error('[矩阵号标记] 配置读取失败，使用默认配置', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  function saveConfig(config) {
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      console.error('[矩阵号标记] 配置保存失败', e);
    }
  }

  function addRule(type, rule, isRegex) {
    const trimmed = rule.trim();
    if (!trimmed) return false;
    const rules = currentConfig[type].rules;
    // 去重：按 keyword 检查
    if (rules.some(function (r) { return r.keyword === trimmed; })) return false;
    // 新建规则继承全局默认 options；isRegex 标记是否正则
    rules.push({ keyword: trimmed, options: getDefaultOptions(type), isRegex: !!isRegex });
    saveConfig(currentConfig);
    return true;
  }

  function removeRule(type, keyword) {
    const rules = currentConfig[type].rules;
    const idx = rules.findIndex(function (r) { return r.keyword === keyword; });
    if (idx === -1) return false;
    rules.splice(idx, 1);
    saveConfig(currentConfig);
    return true;
  }

  // 修改某条规则的 option
  function setRuleOption(type, keyword, key, value) {
    const rules = currentConfig[type].rules;
    const rule = rules.find(function (r) { return r.keyword === keyword; });
    if (!rule) return false;
    if (!rule.options) rule.options = getDefaultOptions(type);
    rule.options[key] = value;
    saveConfig(currentConfig);
    return true;
  }

  // 获取某规则的 options（不存在则返回全局默认）
  function getRuleOptions(type, keyword) {
    const rules = currentConfig[type].rules;
    const rule = rules.find(function (r) { return r.keyword === keyword; });
    if (rule && rule.options) return rule.options;
    return getDefaultOptions(type);
  }

  function setRegexMode(type, mode) {
    currentConfig[type].regexMode = !!mode;
    saveConfig(currentConfig);
  }

  // 设置全局默认选项（新建规则继承用）
  function setCommentOption(key, value) {
    if (!currentConfig.comment.options) {
      currentConfig.comment.options = Object.assign({}, DEFAULT_CONFIG.comment.options);
    }
    currentConfig.comment.options[key] = value;
    saveConfig(currentConfig);
  }

  // 跨标签页同步
  GM_addValueChangeListener(STORAGE_KEY, function (key, oldVal, newVal, remote) {
    if (remote && newVal) {
      try {
        currentConfig = JSON.parse(newVal);
        // 合并默认值（含 options 深层合并 + 规则迁移）
        var un = Object.assign({}, DEFAULT_CONFIG.username, currentConfig.username || {});
        un.options = Object.assign({}, DEFAULT_CONFIG.username.options, (currentConfig.username || {}).options || {});
        un.rules = migrateRules(un.rules || [], 'username');
        currentConfig.username = un;
        var cm = Object.assign({}, DEFAULT_CONFIG.comment, currentConfig.comment || {});
        cm.options = Object.assign({}, DEFAULT_CONFIG.comment.options, (currentConfig.comment || {}).options || {});
        cm.rules = migrateRules(cm.rules || [], 'comment');
        currentConfig.comment = cm;
        var ur = Object.assign({}, DEFAULT_CONFIG.uidRecord, currentConfig.uidRecord || {});
        ur.uids = Array.isArray(ur.uids) ? ur.uids : [];
        currentConfig.uidRecord = ur;
        currentConfig.aiConfig = Object.assign({}, DEFAULT_CONFIG.aiConfig, currentConfig.aiConfig || {});
        refreshUI();
        debouncedScanAll();
      } catch (e) { /* ignore */ }
    }
  });

  // ==================== 匹配引擎 ====================
  // 简单 ReDoS 防护：禁止嵌套量词等危险模式，限制长度
  function isRegexSafe(pattern) {
    if (typeof pattern !== 'string' || pattern.length > 200) return false;
    // 禁止嵌套量词（如 (a+)+, (a*)*）
    if (/\([^)]*[+*?][^)]*\)[+*?]/.test(pattern)) return false;
    // 禁止连续量词
    if (/[+*?]{2,}/.test(pattern)) return false;
    return true;
  }

  // 遍历规则列表，返回第一个匹配的规则对象（含 options），无匹配返回 null
  // 优先用 rule.isRegex 判断单条规则是否正则，否则回退到全局 regexMode
  function findMatchedRule(text, rules, regexMode) {
    if (!text || !rules || !rules.length) return null;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || !rule.keyword) continue;
      var kw = rule.keyword;
      var useRegex = (typeof rule.isRegex === 'boolean') ? rule.isRegex : !!regexMode;
      if (useRegex) {
        if (!isRegexSafe(kw)) continue;
        try {
          if (new RegExp(kw).test(text)) return rule;
        } catch (e) { /* 无效正则跳过 */ }
      } else {
        if (text.toLowerCase().indexOf(kw.toLowerCase()) !== -1) return rule;
      }
    }
    return null;
  }

  // 兼容旧调用：返回是否匹配（布尔）
  function matchesAnyRule(text, rules, regexMode) {
    return findMatchedRule(text, rules, regexMode) !== null;
  }

  // ==================== 选择器定义 ====================
  // B站新版评论区为 Web Components + 开放 Shadow DOM：
  //   bili-comments(ShadowRoot) > #feed > bili-comment-thread-renderer(ShadowRoot)
  //     > #comment > bili-comment-renderer(ShadowRoot)
  //       > #header > bili-comment-user-info(ShadowRoot) > #user-name > a  (用户名)
  //       > #content > #text                                              (评论正文)
  // document.querySelectorAll 无法穿透 Shadow 边界，需用 deepQueryAll 递归查找。
  const USERNAME_SELECTORS = [
    '#user-name',                                  // 新版评论区(Web Components)用户名容器
    '.root-reply-container .user-name a',          // 老版评论区
    '.sub-reply-container .user-name a',
    '.bili-video-card__info--author',              // 视频卡片作者
    '.bili-dyn-list__item .bili-dyn-title',        // 动态发布者
    '.bili-dyn-item__name',
    '.up-info-container .up-name',                 // 视频页UP主
    '.bili-live-card .live-info p'                 // 直播页主播
  ];

  const COMMENT_SELECTORS = [
    '#content',                                    // 新版评论区正文容器（主选，含 #text 子节点）
    '.reply-content',                              // 老版评论区
    '.root-reply-container .reply-content',
    '.sub-reply-container .reply-content'
  ];

  // 深度查询：穿透所有 open shadow root，返回匹配 selector 的全部元素
  function deepQueryAll(selector, root) {
    root = root || document;
    var result = [];
    try {
      if (root.matches && root.matches(selector)) result.push(root);
    } catch (e) {}
    try {
      var list = root.querySelectorAll(selector);
      for (var i = 0; i < list.length; i++) result.push(list[i]);
    } catch (e) {}
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot) {
          var sub = deepQueryAll(selector, el.shadowRoot);
          for (var j = 0; j < sub.length; j++) result.push(sub[j]);
        }
      }
    } catch (e) {}
    return result;
  }

  // 深度获取文本：穿透所有 open shadow root，递归收集元素及其后代的全部文本
  // 解决 el.textContent 无法读取 shadowRoot 内部文本的问题
  function deepTextContent(el) {
    if (!el) return '';
    var text = '';
    // 收集该元素自身的直接文本子节点
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        text += deepTextContent(node);
      }
    }
    // 如果该元素有 shadowRoot，也递归收集其内部文本
    if (el.shadowRoot) {
      text += deepTextContent(el.shadowRoot);
    }
    return text;
  }

  // 从用户名元素提取 UID：查找元素自身/祖先/子树（穿透 Shadow DOM）的 <a> href，
  // 用正则 /space\.bilibili\.com\/(\d+)/ 提取数字部分
  var UID_RE = /space\.bilibili\.com\/(\d+)/;
  function extractUid(el) {
    if (!el) return null;
    var hrefs = [];
    // 1. 元素自身 href（若为 <a>）
    if (el.tagName === 'A' && el.href) hrefs.push(el.href);
    // 2. 最近祖先 <a> 的 href（穿透 shadow，用 composedPath）
    try {
      var path = el.composedPath ? el.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        if (path[i] && path[i].tagName === 'A' && path[i].href) {
          hrefs.push(path[i].href);
          break;
        }
      }
    } catch (e) {}
    // 3. 元素子树（穿透 Shadow DOM）的 <a> href
    try {
      var anchors = deepQueryAll('a', el);
      for (var j = 0; j < anchors.length; j++) {
        if (anchors[j].href) {
          hrefs.push(anchors[j].href);
          break; // 取第一个即可
        }
      }
    } catch (e) {}
    // 对候选 href 逐个正则提取
    for (var k = 0; k < hrefs.length; k++) {
      var m = UID_RE.exec(hrefs[k]);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  // ==================== 标记模块 ====================
  function markUsername(el, options) {
    isMutating = true;
    try {
      el.dataset.originalName = el.textContent.trim();
      el.dataset.matrixMarked = 'username';
      var opts = options || {};
      var color = opts.highlightColor || '#fb7299';
      var prefix = opts.prefix || '';
      var suffix = opts.suffix || '';
      el.textContent = prefix + el.dataset.originalName + suffix;
      el.style.borderBottom = '1px dashed ' + color;
      el.title = '原始用户名: ' + el.dataset.originalName;
    } finally {
      isMutating = false;
    }
  }

  // 命中已记录 UID 时的标记：用户名 + 可配置标记文本，橙色虚线
  function markUsernameByUid(el, label) {
    isMutating = true;
    try {
      el.dataset.originalName = el.textContent.trim();
      el.dataset.matrixMarked = 'username';
      el.dataset.matrixUidMarked = 'true';
      var color = '#ffa502'; // 橙色，区别于关键字命中的粉色系
      el.textContent = el.dataset.originalName + (label || '(有疑似矩阵记录)');
      el.style.borderBottom = '1px dashed ' + color;
      el.style.borderBottomColor = color;
      el.title = '已记录的矩阵号 UID';
    } finally {
      isMutating = false;
    }
  }

  // 将 hex 颜色转为 rgba（带透明度）；非法输入返回默认粉色
  function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string' || !hex) return 'rgba(251,114,153,' + alpha + ')';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 'rgba(251,114,153,' + alpha + ')';
    var r = parseInt(hex.substring(0, 2), 16);
    var g = parseInt(hex.substring(2, 4), 16);
    var b = parseInt(hex.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // 收集元素子树内所有文本节点（穿透 shadowRoot）
  function collectTextNodes(root, list) {
    list = list || [];
    if (!root) return list;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim()) list.push(node);
    }
    // 穿透 shadowRoot
    try {
      var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) collectTextNodes(all[i].shadowRoot, list);
      }
    } catch (e) {}
    return list;
  }

  // 在文本节点中用 <mark> 包裹单个 keyword 的所有匹配片段
  function wrapMatchesInTextNode(textNode, keyword, regexMode, color) {
    var text = textNode.textContent;
    if (!text.trim() || !keyword) return;
    // 收集所有匹配区间 [start, end]
    var ranges = [];
    if (regexMode) {
      if (!isRegexSafe(keyword)) return;
      try {
        var re = new RegExp(keyword, 'g');
        var m;
        while ((m = re.exec(text)) !== null) {
          ranges.push([m.index, m.index + m[0].length]);
          if (m[0].length === 0) re.lastIndex++;
        }
      } catch (e) {}
    } else {
      var lower = text.toLowerCase();
      var kw = keyword.toLowerCase();
      var idx = 0;
      while ((idx = lower.indexOf(kw, idx)) !== -1) {
        ranges.push([idx, idx + kw.length]);
        idx += kw.length;
      }
    }
    if (!ranges.length) return;
    // 合并重叠区间
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    for (var i = 1; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (ranges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], ranges[i][1]);
      } else {
        merged.push(ranges[i]);
      }
    }
    // 拆分文本节点并插入 <mark>
    var parent = textNode.parentNode;
    if (!parent) return;
    var frag = document.createDocumentFragment();
    var cursor = 0;
    merged.forEach(function (r) {
      if (r[0] > cursor) frag.appendChild(document.createTextNode(text.substring(cursor, r[0])));
      var mark = document.createElement('mark');
      mark.className = 'matrix-hit';
      mark.style.cssText = 'background:' + color + '!important;color:#fff!important;border-radius:3px;padding:0 2px;';
      mark.textContent = text.substring(r[0], r[1]);
      frag.appendChild(mark);
      cursor = r[1];
    });
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.substring(cursor)));
    parent.replaceChild(frag, textNode);
  }

  // highlightComment 改为接收匹配到的规则对象（含 keyword + options）
  function highlightComment(el, matchedRule, regexMode) {
    isMutating = true;
    try {
      el.dataset.matrixMarked = 'comment';
      var options = (matchedRule && matchedRule.options) || {};
      var keyword = (matchedRule && matchedRule.keyword) || '';
      var color = options.highlightColor || '#fb7299';
      // 整条评论高亮（背景 + 左边框）
      el.style.cssText += ';background-color:' + hexToRgba(color, 0.1) + '!important;border-left:4px solid ' + color + '!important;padding-left:8px!important;border-radius:0 4px 4px 0!important;';

      // 匹配文字精准高亮：遍历文本节点（穿透 shadow）用 <mark> 包裹该规则的 keyword
      if (keyword) {
        var useRegex = matchedRule && (typeof matchedRule.isRegex === 'boolean') ? matchedRule.isRegex : !!regexMode;
        var textNodes = collectTextNodes(el);
        for (var i = 0; i < textNodes.length; i++) {
          wrapMatchesInTextNode(textNodes[i], keyword, useRegex, color);
        }
      }

      // 前后缀：在评论容器内最前/最后插入标签
      if (options.prefix) {
        var pre = document.createElement('span');
        pre.className = 'matrix-prefix';
        pre.style.cssText = 'color:' + color + '!important;font-weight:600;margin-right:6px;';
        pre.textContent = options.prefix;
        el.insertBefore(pre, el.firstChild);
      }
      if (options.suffix) {
        var suf = document.createElement('span');
        suf.className = 'matrix-suffix';
        suf.style.cssText = 'color:' + color + '!important;font-weight:600;margin-left:6px;';
        suf.textContent = options.suffix;
        el.appendChild(suf);
      }

      // 折叠隐藏
      if (options.hideComment) {
        el.dataset.matrixFolded = 'true';
        el.style.cssText += ';max-height:28px!important;overflow:hidden!important;cursor:pointer!important;';
        var foldBtn = document.createElement('div');
        foldBtn.className = 'matrix-fold-btn';
        foldBtn.style.cssText = 'font-size:11px;color:' + color + ';padding:2px 0;text-align:center;border-top:1px dashed ' + hexToRgba(color, 0.3) + ';margin-top:4px;';
        foldBtn.textContent = '已折叠 · 点击展开';
        el.appendChild(foldBtn);
        foldBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (el.dataset.matrixFolded === 'true') {
            el.dataset.matrixFolded = 'false';
            el.style.maxHeight = 'none';
            foldBtn.textContent = '点击折叠';
          } else {
            el.dataset.matrixFolded = 'true';
            el.style.maxHeight = '28px';
            foldBtn.textContent = '已折叠 · 点击展开';
          }
        });
      }

      el.title = '该评论匹配关键字: ' + keyword;
    } finally {
      isMutating = false;
    }
  }

  // ==================== 扫描模块 ====================
  // 计数口径统一为“页面中所有已标记元素的总数”，避免多次扫描后计数错乱

  function scanAll(config) {
    if (!config) config = currentConfig;
    if (!config) return;

    // 扫描用户名（穿透 Shadow DOM）— UID 命中优先于关键字命中
    var uidRecord = config.uidRecord || { uids: [], label: '(有疑似矩阵记录)' };
    for (var i = 0; i < USERNAME_SELECTORS.length; i++) {
      try {
        var els = deepQueryAll(USERNAME_SELECTORS[i], document);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (el.dataset.matrixMarked) continue;
          var text = el.textContent.trim();
          // 优先检查是否为已记录 UID
          var uid = extractUid(el);
          if (uid && uidRecord.uids.indexOf(uid) !== -1) {
            markUsernameByUid(el, uidRecord.label);
            continue;
          }
          // 未命中 UID，再走关键字匹配
          var matchedRule = findMatchedRule(text, config.username.rules, config.username.regexMode);
          if (text && matchedRule) {
            markUsername(el, matchedRule.options);
          }
        }
      } catch (e) { /* 选择器无效则跳过 */ }
    }

    // 扫描评论内容（穿透 Shadow DOM）— 使用 findMatchedRule 获取匹配规则
    for (var i = 0; i < COMMENT_SELECTORS.length; i++) {
      try {
        var commentEls = deepQueryAll(COMMENT_SELECTORS[i], document);
        for (var j = 0; j < commentEls.length; j++) {
          var commentEl = commentEls[j];
          if (commentEl.dataset.matrixMarked === 'comment') continue;
          var commentText = deepTextContent(commentEl).trim();
          var cMatchedRule = findMatchedRule(commentText, config.comment.rules, config.comment.regexMode);
          if (commentText && cMatchedRule) {
            highlightComment(commentEl, cMatchedRule, config.comment.regexMode);
          }
        }
      } catch (e) { /* 选择器无效则跳过 */ }
    }

    recountMarked();
  }

  // 清除所有已标记的评论，用于配置变更后重新处理
  function clearMarkedComments() {
    isMutating = true;
    try {
      var marked = deepQueryAll('[data-matrix-marked="comment"]', document);
      for (var i = 0; i < marked.length; i++) {
        var el = marked[i];
        // 移除脚本插入的 mark/span/fold-btn 子元素
        var inserts = el.querySelectorAll('mark.matrix-hit, .matrix-prefix, .matrix-suffix, .matrix-fold-btn');
        for (var k = 0; k < inserts.length; k++) inserts[k].remove();
        // 清除样式与标记
        el.removeAttribute('data-matrix-marked');
        el.removeAttribute('data-matrix-folded');
        el.removeAttribute('style');
        el.removeAttribute('title');
      }
    } finally {
      isMutating = false;
    }
  }

  // 清除所有已标记的用户名，用于配置变更后重新处理
  function clearMarkedUsernames() {
    isMutating = true;
    try {
      var marked = deepQueryAll('[data-matrix-marked="username"]', document);
      for (var i = 0; i < marked.length; i++) {
        var el = marked[i];
        // 恢复原始用户名
        if (el.dataset.originalName) {
          el.textContent = el.dataset.originalName;
        }
        el.removeAttribute('data-matrix-marked');
        el.removeAttribute('data-original-name');
        el.removeAttribute('style');
        el.removeAttribute('title');
      }
    } finally {
      isMutating = false;
    }
  }

  // 清除所有标记（用户名+评论），配置变更时统一调用
  function clearAllMarks() {
    clearMarkedUsernames();
    clearMarkedComments();
  }

  // 统计当前 DOM 中已标记元素总数并刷新面板显示（穿透 Shadow DOM）
  function recountMarked() {
    var nameCount = deepQueryAll('[data-matrix-marked="username"]', document).length;
    var commentCount = deepQueryAll('[data-matrix-marked="comment"]', document).length;
    var nameEl = document.getElementById('matrix-username-count');
    var commentEl = document.getElementById('matrix-comment-count');
    if (nameEl) nameEl.textContent = nameCount;
    if (commentEl) commentEl.textContent = commentCount;
  }

  // 200ms 防抖的全量扫描，合并短时间内的多次调用（P2 节流）
  let scanAllTimer = null;
  function debouncedScanAll(config) {
    if (scanAllTimer) clearTimeout(scanAllTimer);
    scanAllTimer = setTimeout(function () {
      scanAllTimer = null;
      scanAll(config);
    }, 200);
  }

  // 对新增节点集合进行增量扫描：穿透 Shadow DOM 查找命中选择器的元素
  function scanNodes(nodeSet, config) {
    if (!config) config = currentConfig;
    if (!config || nodeSet.size === 0) return;

    nodeSet.forEach(function (node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      // 忽略脚本自身面板
      if (node.id === 'matrix-keyword-panel' || node.id === 'matrix-panel-toggle') return;
      if (node.closest && node.closest('#matrix-keyword-panel')) return;

      try {
        // 用 deepQueryAll 在该节点子树内（含 Shadow DOM）查找目标元素
        for (var i = 0; i < USERNAME_SELECTORS.length; i++) {
          var hits = deepQueryAll(USERNAME_SELECTORS[i], node);
          for (var j = 0; j < hits.length; j++) {
            checkUsernameElement(hits[j], config);
          }
        }
        for (var i = 0; i < COMMENT_SELECTORS.length; i++) {
          var cHits = deepQueryAll(COMMENT_SELECTORS[i], node);
          for (var j = 0; j < cHits.length; j++) {
            checkCommentElement(cHits[j], config);
          }
        }
      } catch (e) { /* ignore */ }
    });

    recountMarked();
  }

  function checkUsernameElement(el, config) {
    if (!el || el.dataset.matrixMarked === 'username') return;
    var text = el.textContent.trim();
    if (!text) return;
    // 优先检查是否为已记录 UID
    var uidRecord = config.uidRecord || { uids: [], label: '(有疑似矩阵记录)' };
    var uid = extractUid(el);
    if (uid && uidRecord.uids.indexOf(uid) !== -1) {
      markUsernameByUid(el, uidRecord.label);
      return;
    }
    // 未命中 UID，再走关键字匹配
    var matchedRule = findMatchedRule(text, config.username.rules, config.username.regexMode);
    if (matchedRule) {
      markUsername(el, matchedRule.options);
    }
  }

  function checkCommentElement(el, config) {
    if (!el || el.dataset.matrixMarked === 'comment') return;
    var text = deepTextContent(el).trim();
    if (!text || text.length < 2) return; // 评论至少有2个字
    var matchedRule = findMatchedRule(text, config.comment.rules, config.comment.regexMode);
    if (matchedRule) {
      highlightComment(el, matchedRule, config.comment.regexMode);
    }
  }

  // ==================== DOM 监听模块 ====================
  let pendingNodes = new Set();
  let rafId = null;

  function setupMutationObserver() {
    var observer = new MutationObserver(function (mutations) {
      // 脚本自身 DOM 操作进行中时跳过，避免自激
      if (isMutating) return;
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        // 忽略脚本自身面板内部的变更
        if (mutation.target && mutation.target.closest && mutation.target.closest('#matrix-keyword-panel')) continue;
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j];
          if (node.nodeType === Node.ELEMENT_NODE) {
            // 忽略面板自身元素
            if (node.id === 'matrix-keyword-panel' || node.id === 'matrix-panel-toggle') continue;
            if (node.closest && node.closest('#matrix-keyword-panel')) continue;
            pendingNodes.add(node);
          }
        }
      }
      if (pendingNodes.size > 0 && !rafId) {
        rafId = requestAnimationFrame(function () {
          var nodes = new Set(pendingNodes);
          pendingNodes.clear();
          rafId = null;
          scanNodes(nodes, currentConfig);
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return observer;
  }

  // SPA 路由变化检测
  function setupRouteWatcher() {
    var lastUrl = location.href;

    // 包装 history.pushState
    var origPushState = history.pushState;
    history.pushState = function () {
      origPushState.apply(this, arguments);
      onRouteChange();
    };

    // 包装 history.replaceState
    var origReplaceState = history.replaceState;
    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      onRouteChange();
    };

    // popstate 监听（浏览器前进后退）
    window.addEventListener('popstate', function () {
      onRouteChange();
    });

    function onRouteChange() {
      var url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        // 路由变化后延时扫描，等待新页面 DOM 渲染
        setTimeout(function () {
          debouncedScanAll(currentConfig);
        }, 600);
      }
    }
  }

  // ==================== UI 面板模块 ====================
  function injectStyles() {
    GM_addStyle([
      '#matrix-keyword-panel {',
      '  position: fixed;',
      '  top: 80px;',
      '  right: 20px;',
      '  z-index: 99999;',
      '  width: 300px;',
      '  background: #fff;',
      '  border: none;',
      '  border-radius: 12px;',
      '  box-shadow: 0 8px 32px rgba(251,114,153,0.18), 0 2px 8px rgba(0,0,0,0.06);',
      '  font-family: -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;',
      '  font-size: 13px;',
      '  color: #333;',
      '  transition: transform 0.3s ease;',
      '  overflow: hidden;',
      '}',
      '#matrix-keyword-panel.collapsed {',
      '  transform: translateX(340px);',
      '  pointer-events: none;',
      '}',
      '#matrix-keyword-panel .panel-header {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '  padding: 13px 16px;',
      '  background: linear-gradient(135deg, #fb7299, #ff8fab);',
      '  color: #fff;',
      '  font-weight: 600;',
      '  font-size: 14px;',
      '  border-radius: 12px 12px 0 0;',
      '}',
      '#matrix-keyword-panel .panel-header .close-btn {',
      '  cursor: pointer;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '  opacity: 0.7;',
      '}',
      '#matrix-keyword-panel .panel-header .close-btn:hover {',
      '  opacity: 1;',
      '}',
      '#matrix-keyword-panel .panel-tabs {',
      '  display: flex;',
      '  border-bottom: 1px solid #e3e5e7;',
      '}',
      '#matrix-keyword-panel .panel-tab {',
      '  flex: 1;',
      '  text-align: center;',
      '  padding: 10px 0;',
      '  cursor: pointer;',
      '  font-size: 13px;',
      '  color: #666;',
      '  border-bottom: 2px solid transparent;',
      '  transition: all 0.2s;',
      '  background: #fafafa;',
      '}',
      '#matrix-keyword-panel .panel-tab.active {',
      '  color: #fb7299;',
      '  border-bottom-color: #fb7299;',
      '  background: #fff;',
      '  font-weight: 600;',
      '}',
      '#matrix-keyword-panel .panel-body {',
      '  padding: 12px 14px;',
      '}',
      '#matrix-keyword-panel .mode-switch-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  margin-bottom: 10px;',
      '  gap: 8px;',
      '}',
      '#matrix-keyword-panel .mode-switch-row span {',
      '  font-size: 12px;',
      '  color: #666;',
      '  cursor: pointer;',
      '}',
      '#matrix-keyword-panel .mode-switch-row span.active-mode {',
      '  color: #fb7299;',
      '  font-weight: 600;',
      '}',
      '#matrix-keyword-panel .mode-switch {',
      '  position: relative;',
      '  width: 44px;',
      '  height: 22px;',
      '  background: #fb7299;',
      '  border-radius: 11px;',
      '  cursor: pointer;',
      '  transition: background 0.2s;',
      '  flex-shrink: 0;',
      '}',
      '#matrix-keyword-panel .mode-switch.off {',
      '  background: #ccc;',
      '}',
      '#matrix-keyword-panel .mode-switch::after {',
      '  content: "";',
      '  position: absolute;',
      '  top: 2px;',
      '  left: 24px;',
      '  width: 18px;',
      '  height: 18px;',
      '  background: #fff;',
      '  border-radius: 50%;',
      '  transition: left 0.2s;',
      '}',
      '#matrix-keyword-panel .mode-switch.off::after {',
      '  left: 2px;',
      '}',
      '#matrix-keyword-panel .rule-list {',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 4px;',
      '  margin-bottom: 8px;',
      '  min-height: 24px;',
      '}',
      '#matrix-keyword-panel .rule-list .empty-hint {',
      '  width: 100%;',
      '  text-align: center;',
      '  color: #bbb;',
      '  font-size: 12px;',
      '  padding: 8px 0;',
      '}',
      '#matrix-keyword-panel .rule-tag {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  background: rgba(251,114,153,0.1);',
      '  color: #fb7299;',
      '  border: 1px solid rgba(251,114,153,0.2);',
      '  border-radius: 12px;',
      '  padding: 3px 8px;',
      '  font-size: 12px;',
      '  max-width: 180px;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '#matrix-keyword-panel .rule-tag .remove-btn {',
      '  margin-left: 4px;',
      '  cursor: pointer;',
      '  color: #999;',
      '  font-weight: bold;',
      '  flex-shrink: 0;',
      '}',
      '#matrix-keyword-panel .rule-tag .remove-btn:hover {',
      '  color: #fb7299;',
      '}',
      '#matrix-keyword-panel .rule-tag .color-dot {',
      '  width: 8px;',
      '  height: 8px;',
      '  border-radius: 50%;',
      '  margin-right: 5px;',
      '  flex-shrink: 0;',
      '  border: 1px solid rgba(0,0,0,0.1);',
      '}',
      '#matrix-keyword-panel .rule-tag .tag-text {',
      '  cursor: pointer;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings {',
      '  width: 100%;',
      '  background: #fafafa;',
      '  border: 1px solid #eee;',
      '  border-radius: 8px;',
      '  padding: 10px;',
      '  margin: 4px 0;',
      '  font-size: 12px;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings .settings-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 8px;',
      '  color: #666;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings .settings-row:last-child {',
      '  margin-bottom: 0;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings label { flex-shrink: 0; }',
      '#matrix-keyword-panel .rule-inline-settings .color-presets { display: flex; flex-wrap: wrap; gap: 4px; }',
      '#matrix-keyword-panel .rule-inline-settings .color-preset {',
      '  width: 16px;',
      '  height: 16px;',
      '  border-radius: 50%;',
      '  cursor: pointer;',
      '  border: 2px solid #fff;',
      '  box-shadow: 0 0 0 1px #ddd;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings .color-preset.selected {',
      '  box-shadow: 0 0 0 2px #fb7299;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings .text-input {',
      '  flex: 1;',
      '  padding: 4px 8px;',
      '  border: 1px solid #ddd;',
      '  border-radius: 4px;',
      '  font-size: 12px;',
      '  outline: none;',
      '  margin-left: 8px;',
      '}',
      '#matrix-keyword-panel .rule-inline-settings .text-input:focus { border-color: #fb7299; }',
      '#matrix-keyword-panel .rule-input-row {',
      '  display: flex;',
      '  gap: 6px;',
      '}',
      '#matrix-keyword-panel .rule-input {',
      '  flex: 1;',
      '  padding: 7px 10px;',
      '  border: 1px solid #d3d7db;',
      '  border-radius: 6px;',
      '  outline: none;',
      '  font-size: 12px;',
      '  box-sizing: border-box;',
      '  transition: border-color 0.2s;',
      '}',
      '#matrix-keyword-panel .rule-input:focus {',
      '  border-color: #fb7299;',
      '}',
      '#matrix-keyword-panel .add-btn {',
      '  padding: 7px 14px;',
      '  background: #fb7299;',
      '  color: #fff;',
      '  border: none;',
      '  border-radius: 6px;',
      '  cursor: pointer;',
      '  font-size: 12px;',
      '  white-space: nowrap;',
      '  transition: background 0.2s;',
      '}',
      '#matrix-keyword-panel .add-btn:hover {',
      '  background: #fc8bab;',
      '}',
      '#matrix-keyword-panel .panel-footer {',
      '  padding: 10px 14px 12px;',
      '  border-top: 1px solid #f5f5f7;',
      '  font-size: 11px;',
      '  color: #999;',
      '  text-align: center;',
      '  line-height: 1.9;',
      '  background: #fafafa;',
      '  border-radius: 0 0 12px 12px;',
      '}',
      '#matrix-keyword-panel .panel-footer .count-val {',
      '  color: #fb7299;',
      '  font-weight: 700;',
      '}',
      '#matrix-panel-toggle {',
      '  position: fixed;',
      '  top: 80px;',
      '  right: 0;',
      '  z-index: 99998;',
      '  width: 28px;',
      '  height: 72px;',
      '  background: linear-gradient(135deg, #fb7299, #ff8fab);',
      '  color: #fff;',
      '  border: none;',
      '  border-radius: 10px 0 0 10px;',
      '  cursor: pointer;',
      '  font-size: 12px;',
      '  writing-mode: vertical-rl;',
      '  letter-spacing: 3px;',
      '  display: block;',
      '  box-shadow: -2px 2px 10px rgba(251,114,153,0.35);',
      '  transition: width 0.2s, background 0.2s;',
      '  font-weight: 600;',
      '}',
      '#matrix-panel-toggle:hover {',
      '  width: 34px;',
      '  background: linear-gradient(135deg, #fc8bab, #ff9fbb);',
      '}',
      // ===== 设置区样式 =====
      '#matrix-keyword-panel .settings-section {',
      '  border-top: 1px dashed #eee;',
      '  margin-top: 10px;',
      '  padding-top: 10px;',
      '}',
      '#matrix-keyword-panel .settings-title {',
      '  font-size: 12px;',
      '  color: #999;',
      '  margin-bottom: 8px;',
      '  cursor: pointer;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '}',
      '#matrix-keyword-panel .settings-title:hover { color: #fb7299; }',
      '#matrix-keyword-panel .settings-body { display: none; }',
      '#matrix-keyword-panel .settings-body.open { display: block; }',
      '#matrix-keyword-panel .settings-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 8px;',
      '  font-size: 12px;',
      '  color: #666;',
      '}',
      '#matrix-keyword-panel .settings-row label { flex-shrink: 0; }',
      '#matrix-keyword-panel .color-input {',
      '  width: 32px;',
      '  height: 24px;',
      '  border: 1px solid #ddd;',
      '  border-radius: 4px;',
      '  cursor: pointer;',
      '  padding: 0;',
      '}',
      '#matrix-keyword-panel .color-presets { display: flex; gap: 4px; margin-left: 6px; }',
      '#matrix-keyword-panel .color-preset {',
      '  width: 16px;',
      '  height: 16px;',
      '  border-radius: 50%;',
      '  cursor: pointer;',
      '  border: 2px solid #fff;',
      '  box-shadow: 0 0 0 1px #ddd;',
      '}',
      '#matrix-keyword-panel .text-input {',
      '  flex: 1;',
      '  padding: 4px 8px;',
      '  border: 1px solid #ddd;',
      '  border-radius: 4px;',
      '  font-size: 12px;',
      '  outline: none;',
      '  margin-left: 8px;',
      '}',
      '#matrix-keyword-panel .text-input:focus { border-color: #fb7299; }',
      '#matrix-keyword-panel .toggle-switch {',
      '  position: relative;',
      '  width: 36px;',
      '  height: 20px;',
      '  background: #ccc;',
      '  border-radius: 10px;',
      '  cursor: pointer;',
      '  transition: background 0.2s;',
      '}',
      '#matrix-keyword-panel .toggle-switch.on { background: #fb7299; }',
      '#matrix-keyword-panel .toggle-switch::after {',
      '  content: "";',
      '  position: absolute;',
      '  top: 2px;',
      '  left: 2px;',
      '  width: 16px;',
      '  height: 16px;',
      '  background: #fff;',
      '  border-radius: 50%;',
      '  transition: left 0.2s;',
      '}',
      '#matrix-keyword-panel .toggle-switch.on::after { left: 18px; }',
      // ===== UID 记录区样式 =====
      '#matrix-keyword-panel .uid-section {',
      '  border-top: 1px dashed #eee;',
      '  margin-top: 10px;',
      '  padding-top: 10px;',
      '}',
      '#matrix-keyword-panel .uid-title {',
      '  font-size: 12px;',
      '  color: #999;',
      '  margin-bottom: 8px;',
      '  cursor: pointer;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '}',
      '#matrix-keyword-panel .uid-title:hover { color: #ffa502; }',
      '#matrix-keyword-panel .uid-body { display: none; }',
      '#matrix-keyword-panel .uid-body.open { display: block; }',
      '#matrix-keyword-panel .uid-list {',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 4px;',
      '  margin-bottom: 8px;',
      '  min-height: 20px;',
      '}',
      '#matrix-keyword-panel .uid-tag {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  background: rgba(255,165,2,0.1);',
      '  color: #ffa502;',
      '  border: 1px solid rgba(255,165,2,0.2);',
      '  border-radius: 12px;',
      '  padding: 3px 8px;',
      '  font-size: 12px;',
      '}',
      '#matrix-keyword-panel .uid-tag .remove-btn {',
      '  margin-left: 4px;',
      '  cursor: pointer;',
      '  color: #999;',
      '  font-weight: bold;',
      '}',
      '#matrix-keyword-panel .uid-tag .remove-btn:hover { color: #ffa502; }',
      '#matrix-keyword-panel .uid-hint {',
      '  font-size: 11px;',
      '  color: #bbb;',
      '  margin-top: 6px;',
      '}',
      // ===== 右键菜单样式 =====
      '#matrix-context-menu {',
      '  position: fixed;',
      '  z-index: 100000;',
      '  background: #fff;',
      '  border: 1px solid #e3e5e7;',
      '  border-radius: 8px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.15);',
      '  padding: 4px 0;',
      '  min-width: 140px;',
      '  font-family: -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;',
      '}',
      '#matrix-context-menu .matrix-menu-item {',
      '  padding: 8px 16px;',
      '  cursor: pointer;',
      '  font-size: 13px;',
      '  color: #333;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '}',
      '#matrix-context-menu .matrix-menu-item:hover {',
      '  background: #fff5f7;',
      '  color: #fb7299;',
      '}',
      // ===== Toast 提示样式 =====
      '.matrix-toast {',
      '  position: fixed;',
      '  bottom: 40px;',
      '  left: 50%;',
      '  transform: translateX(-50%) translateY(20px);',
      '  z-index: 100001;',
      '  background: rgba(45,52,54,0.92);',
      '  color: #fff;',
      '  padding: 10px 20px;',
      '  border-radius: 8px;',
      '  font-size: 13px;',
      '  opacity: 0;',
      '  transition: opacity 0.3s, transform 0.3s;',
      '  pointer-events: none;',
      '  font-family: -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;',
      '}',
      '.matrix-toast.show {',
      '  opacity: 1;',
      '  transform: translateX(-50%) translateY(0);',
      '}',
      // ===== AI 设置区样式 =====
      '#matrix-keyword-panel .ai-section {',
      '  border-top: 1px dashed #eee;',
      '  margin-top: 10px;',
      '  padding-top: 10px;',
      '}',
      '#matrix-keyword-panel .ai-title {',
      '  font-size: 12px;',
      '  color: #999;',
      '  margin-bottom: 8px;',
      '  cursor: pointer;',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: center;',
      '}',
      '#matrix-keyword-panel .ai-title:hover { color: #5352ed; }',
      '#matrix-keyword-panel .ai-body { display: none; }',
      '#matrix-keyword-panel .ai-body.open { display: block; }',
      '#matrix-keyword-panel .ai-body .settings-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 8px;',
      '  font-size: 12px;',
      '  color: #666;',
      '}',
      '#matrix-keyword-panel .ai-body .text-input {',
      '  flex: 1;',
      '  padding: 4px 8px;',
      '  border: 1px solid #ddd;',
      '  border-radius: 4px;',
      '  font-size: 12px;',
      '  outline: none;',
      '  margin-left: 8px;',
      '}',
      '#matrix-keyword-panel .ai-body .text-input:focus { border-color: #5352ed; }',
      '#matrix-keyword-panel .ai-body .toggle-vis-btn {',
      '  margin-left: 4px;',
      '  cursor: pointer;',
      '  color: #999;',
      '  font-size: 11px;',
      '  flex-shrink: 0;',
      '}',
      '#matrix-keyword-panel .ai-body .toggle-vis-btn:hover { color: #5352ed; }',
      '#matrix-keyword-panel .ai-hint {',
      '  font-size: 11px;',
      '  color: #bbb;',
      '  margin-top: 6px;',
      '}',
      // ===== 模态框样式 =====
      '.matrix-modal-overlay {',
      '  position: fixed;',
      '  top: 0;',
      '  left: 0;',
      '  width: 100%;',
      '  height: 100%;',
      '  background: rgba(0,0,0,0.45);',
      '  z-index: 100002;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '}',
      '.matrix-modal {',
      '  background: #fff;',
      '  border-radius: 12px;',
      '  box-shadow: 0 8px 32px rgba(0,0,0,0.2);',
      '  padding: 20px 24px;',
      '  max-width: 460px;',
      '  width: 90%;',
      '  max-height: 80vh;',
      '  overflow-y: auto;',
      '  font-family: -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;',
      '}',
      '.matrix-modal-title {',
      '  font-size: 16px;',
      '  font-weight: 600;',
      '  color: #333;',
      '  margin-bottom: 8px;',
      '}',
      '.matrix-modal-hint {',
      '  font-size: 12px;',
      '  color: #999;',
      '  margin-bottom: 12px;',
      '}',
      '.matrix-modal-group-title {',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  color: #5352ed;',
      '  margin: 10px 0 6px;',
      '}',
      '.matrix-modal-item {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 6px 8px;',
      '  font-size: 13px;',
      '  color: #333;',
      '  cursor: pointer;',
      '  border-radius: 6px;',
      '}',
      '.matrix-modal-item:hover { background: #f5f5f7; }',
      '.matrix-modal-item input[type=checkbox] { flex-shrink: 0; }',
      '.matrix-modal-btn-row {',
      '  display: flex;',
      '  justify-content: flex-end;',
      '  gap: 10px;',
      '  margin-top: 16px;',
      '}',
      '.matrix-modal-btn {',
      '  padding: 8px 18px;',
      '  border: none;',
      '  border-radius: 8px;',
      '  font-size: 13px;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '}',
      '.matrix-modal-btn.cancel { background: #f0f0f0; color: #666; }',
      '.matrix-modal-btn.cancel:hover { background: #e0e0e0; }',
      '.matrix-modal-btn.confirm { background: #5352ed; color: #fff; }',
      '.matrix-modal-btn.confirm:hover { background: #4342d8; }',
      '.matrix-modal-btn.confirm:disabled { background: #ccc; cursor: not-allowed; }',
    ].join('\n'));
  }

  function createPanel() {
    // 折叠按钮（默认显示）
    var toggle = document.createElement('button');
    toggle.id = 'matrix-panel-toggle';
    toggle.textContent = '矩阵标记';
    document.body.appendChild(toggle);

    // 面板主体（默认折叠）
    var panel = document.createElement('div');
    panel.id = 'matrix-keyword-panel';
    panel.classList.add('collapsed');
    panel.innerHTML = [
      '<div class="panel-header">',
      '  <span>疑似矩阵号标记</span>',
      '  <span class="close-btn" id="matrix-panel-close" title="收起面板">×</span>',
      '</div>',
      '<div class="panel-tabs">',
      '  <div class="panel-tab active" data-tab="username">用户名规则</div>',
      '  <div class="panel-tab" data-tab="comment">评论内容规则</div>',
      '</div>',
      '<div class="panel-body">',
      '  <div class="mode-switch-row">',
      '    <span id="matrix-mode-normal" class="active-mode">普通</span>',
      '    <div class="mode-switch" id="matrix-mode-switch"></div>',
      '    <span id="matrix-mode-regex">正则</span>',
      '  </div>',
      '  <div class="rule-list" id="matrix-rule-list"></div>',
      '  <div class="rule-input-row">',
      '    <input class="rule-input" id="matrix-rule-input" placeholder="输入关键字，回车添加" />',
      '    <button class="add-btn" id="matrix-add-btn">添加</button>',
      '  </div>',
      '  <div class="settings-section" id="matrix-settings-section" style="display:none;">',
      '    <div class="settings-title" id="matrix-settings-toggle">评论处理设置 <span>▾</span></div>',
      '    <div class="settings-body" id="matrix-settings-body">',
      '      <div class="settings-row">',
      '        <label>高亮颜色</label>',
      '        <input type="color" class="color-input" id="matrix-color-input" value="#fb7299" />',
      '        <div class="color-presets">',
      '          <span class="color-preset" style="background:#fb7299" data-color="#fb7299"></span>',
      '          <span class="color-preset" style="background:#ff6b6b" data-color="#ff6b6b"></span>',
      '          <span class="color-preset" style="background:#ffa502" data-color="#ffa502"></span>',
      '          <span class="color-preset" style="background:#2ed573" data-color="#2ed573"></span>',
      '          <span class="color-preset" style="background:#5352ed" data-color="#5352ed"></span>',
      '        </div>',
      '      </div>',
      '      <div class="settings-row">',
      '        <label>折叠隐藏</label>',
      '        <div class="toggle-switch" id="matrix-hide-toggle"></div>',
      '      </div>',
      '      <div class="settings-row">',
      '        <label>前缀文本</label>',
      '        <input type="text" class="text-input" id="matrix-prefix-input" placeholder="如 [广告]" />',
      '      </div>',
      '      <div class="settings-row">',
      '        <label>后缀文本</label>',
      '        <input type="text" class="text-input" id="matrix-suffix-input" placeholder="如 [已标记]" />',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="uid-section" id="matrix-uid-section">',
      '    <div class="uid-title" id="matrix-uid-toggle">UID 记录 <span>▾</span></div>',
      '    <div class="uid-body" id="matrix-uid-body">',
      '      <div class="uid-list" id="matrix-uid-list"></div>',
      '      <div class="settings-row">',
      '        <label>标记文本</label>',
      '        <input type="text" class="text-input" id="matrix-uid-label-input" placeholder="(有疑似矩阵记录)" />',
      '      </div>',
      '      <div class="uid-hint">右键任意用户名可记录为矩阵号</div>',
      '    </div>',
      '  </div>',
      '  <div class="ai-section" id="matrix-ai-section">',
      '    <div class="ai-title" id="matrix-ai-toggle">AI 设置 <span>▾</span></div>',
      '    <div class="ai-body" id="matrix-ai-body">',
      '      <div class="settings-row">',
      '        <label>API Key</label>',
      '        <input type="password" class="text-input" id="matrix-ai-key-input" placeholder="未配置，请输入 sk-..." />',
      '        <span class="toggle-vis-btn" id="matrix-ai-key-vis">清除</span>',
      '      </div>',
      '      <div class="settings-row">',
      '        <label>模型</label>',
      '        <input type="text" class="text-input" id="matrix-ai-model-input" placeholder="deepseek-v4-flash" />',
      '      </div>',
      '      <div class="ai-hint">右键评论可调用 AI 分析提取关键字（需配置 Key）</div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="panel-footer">',
      '  已替换 <span class="count-val" id="matrix-username-count">0</span> 个用户名<br>',
      '  已标记 <span class="count-val" id="matrix-comment-count">0</span> 条评论',
      '</div>'
    ].join('');
    document.body.appendChild(panel);

    // 绑定事件
    bindPanelEvents(panel, toggle);
  }

  function bindPanelEvents(panel, toggle) {
    // 折叠/展开
    document.getElementById('matrix-panel-close').addEventListener('click', function () {
      panel.classList.add('collapsed');
      toggle.style.display = 'block';
    });

    toggle.addEventListener('click', function () {
      panel.classList.remove('collapsed');
      toggle.style.display = 'none';
    });

    // 标签页切换
    panel.querySelectorAll('.panel-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        currentTab = this.dataset.tab;
        refreshUI();
      });
    });

    // 模式切换
    document.getElementById('matrix-mode-switch').addEventListener('click', function () {
      var currentMode = currentConfig[currentTab].regexMode;
      setRegexMode(currentTab, !currentMode);
      refreshUI();
      debouncedScanAll(currentConfig);
    });

    // 普通/正则文字点击切换
    document.getElementById('matrix-mode-normal').addEventListener('click', function () {
      if (currentConfig[currentTab].regexMode) {
        setRegexMode(currentTab, false);
        refreshUI();
        debouncedScanAll(currentConfig);
      }
    });
    document.getElementById('matrix-mode-regex').addEventListener('click', function () {
      if (!currentConfig[currentTab].regexMode) {
        setRegexMode(currentTab, true);
        refreshUI();
        debouncedScanAll(currentConfig);
      }
    });

    // 添加规则
    var addBtn = document.getElementById('matrix-add-btn');
    var input = document.getElementById('matrix-rule-input');

    function doAdd() {
      var val = input.value.trim();
      if (!val) return;
      if (addRule(currentTab, val)) {
        input.value = '';
        refreshUI();
        debouncedScanAll(currentConfig);
      } else {
        // 已存在，清空输入框提示
        input.value = '';
        input.placeholder = '已存在相同规则';
        setTimeout(function () { updatePlaceholder(); }, 1500);
      }
    }

    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doAdd();
    });

    // ===== 设置区事件 =====
    // 设置区折叠/展开
    document.getElementById('matrix-settings-toggle').addEventListener('click', function () {
      var body = document.getElementById('matrix-settings-body');
      body.classList.toggle('open');
      var arrow = this.querySelector('span');
      if (arrow) arrow.textContent = body.classList.contains('open') ? '▴' : '▾';
    });

    // 高亮颜色选择
    document.getElementById('matrix-color-input').addEventListener('change', function () {
      setCommentOption('highlightColor', this.value);
      clearMarkedComments();
      debouncedScanAll(currentConfig);
    });

    // 预设色块
    document.querySelectorAll('.color-preset').forEach(function (preset) {
      preset.addEventListener('click', function () {
        var c = this.dataset.color;
        document.getElementById('matrix-color-input').value = c;
        setCommentOption('highlightColor', c);
        clearMarkedComments();
        debouncedScanAll(currentConfig);
      });
    });

    // 折叠隐藏开关
    document.getElementById('matrix-hide-toggle').addEventListener('click', function () {
      var opts = currentConfig.comment.options || {};
      var newVal = !opts.hideComment;
      setCommentOption('hideComment', newVal);
      this.classList.toggle('on', newVal);
      clearMarkedComments();
      debouncedScanAll(currentConfig);
    });

    // 前缀文本
    document.getElementById('matrix-prefix-input').addEventListener('change', function () {
      setCommentOption('prefix', this.value);
      clearMarkedComments();
      debouncedScanAll(currentConfig);
    });

    // 后缀文本
    document.getElementById('matrix-suffix-input').addEventListener('change', function () {
      setCommentOption('suffix', this.value);
      clearMarkedComments();
      debouncedScanAll(currentConfig);
    });

    // ===== UID 记录区事件 =====
    // 折叠/展开
    document.getElementById('matrix-uid-toggle').addEventListener('click', function () {
      var body = document.getElementById('matrix-uid-body');
      body.classList.toggle('open');
      var arrow = this.querySelector('span');
      if (arrow) arrow.textContent = body.classList.contains('open') ? '▴' : '▾';
    });

    // 标记文本
    document.getElementById('matrix-uid-label-input').addEventListener('change', function () {
      currentConfig.uidRecord.label = this.value || '(有疑似矩阵记录)';
      saveConfig(currentConfig);
      clearMarkedUsernames();
      debouncedScanAll(currentConfig);
    });

    // ===== AI 设置区事件 =====
    // 折叠/展开
    document.getElementById('matrix-ai-toggle').addEventListener('click', function () {
      var body = document.getElementById('matrix-ai-body');
      body.classList.toggle('open');
      var arrow = this.querySelector('span');
      if (arrow) arrow.textContent = body.classList.contains('open') ? '▴' : '▾';
    });

    // API Key：保存后立即清空 input，不保留明文在 DOM
    document.getElementById('matrix-ai-key-input').addEventListener('change', function () {
      if (!currentConfig.aiConfig) currentConfig.aiConfig = { apiKey: '', model: 'deepseek-v4-flash' };
      var val = this.value.trim();
      if (val) {
        currentConfig.aiConfig.apiKey = val;
        saveConfig(currentConfig);
        this.value = ''; // 立即清空，防 DOM 泄露
        this.placeholder = '已配置（输入新值可覆盖）';
        showToast('API Key 已保存');
      }
    });

    // 清除已保存的 Key
    document.getElementById('matrix-ai-key-vis').addEventListener('click', function () {
      if (!currentConfig.aiConfig) return;
      if (!currentConfig.aiConfig.apiKey) { showToast('当前未配置 Key'); return; }
      currentConfig.aiConfig.apiKey = '';
      saveConfig(currentConfig);
      var input = document.getElementById('matrix-ai-key-input');
      if (input) { input.value = ''; input.placeholder = '未配置，请输入 sk-...'; }
      this.textContent = '清除';
      showToast('API Key 已清除');
    });

    // 模型
    document.getElementById('matrix-ai-model-input').addEventListener('change', function () {
      if (!currentConfig.aiConfig) currentConfig.aiConfig = { apiKey: '', model: 'deepseek-v4-flash' };
      currentConfig.aiConfig.model = this.value.trim() || 'deepseek-v4-flash';
      saveConfig(currentConfig);
    });

    // 初始渲染
    refreshUI();
  }

  function updatePlaceholder() {
    var input = document.getElementById('matrix-rule-input');
    if (!input) return;
    if (currentConfig[currentTab].regexMode) {
      input.placeholder = '输入正则表达式，如 \\d+号';
    } else {
      input.placeholder = '输入关键字，回车添加';
    }
  }

  function refreshUI() {
    // 更新标签页
    var tabs = document.querySelectorAll('#matrix-keyword-panel .panel-tab');
    tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === currentTab);
    });

    // 更新模式开关
    var switchEl = document.getElementById('matrix-mode-switch');
    var isRegex = currentConfig[currentTab].regexMode;
    if (switchEl) {
      switchEl.classList.toggle('off', !isRegex);
    }

    // 更新模式文字
    var normalSpan = document.getElementById('matrix-mode-normal');
    var regexSpan = document.getElementById('matrix-mode-regex');
    if (normalSpan) normalSpan.classList.toggle('active-mode', !isRegex);
    if (regexSpan) regexSpan.classList.toggle('active-mode', isRegex);

    // 更新输入框 placeholder
    updatePlaceholder();

    // 更新规则列表
    var ruleList = document.getElementById('matrix-rule-list');
    if (!ruleList) return;
    var rules = currentConfig[currentTab].rules;

    ruleList.innerHTML = '';
    if (rules.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '暂无规则，请添加';
      ruleList.appendChild(hint);
    } else {
      rules.forEach(function (rule, idx) {
        var keyword = rule.keyword;
        var opts = rule.options || {};
        var color = opts.highlightColor || '#fb7299';

        // 规则标签容器（含颜色圆点 + 文本 + 删除按钮）
        var tag = document.createElement('span');
        tag.className = 'rule-tag';
        tag.style.borderColor = hexToRgba(color, 0.3);
        tag.style.background = hexToRgba(color, 0.08);
        tag.style.color = color;
        tag.title = keyword;

        var dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = color;
        tag.appendChild(dot);

        var text = document.createElement('span');
        text.className = 'tag-text';
        text.textContent = keyword;
        tag.appendChild(text);

        var remove = document.createElement('span');
        remove.className = 'remove-btn';
        remove.textContent = '×';
        remove.addEventListener('click', function (e) {
          e.stopPropagation();
          if (removeRule(currentTab, keyword)) {
            clearAllMarks();
            refreshUI();
            debouncedScanAll(currentConfig);
          }
        });
        tag.appendChild(remove);

        ruleList.appendChild(tag);

        // 内联展开设置行（点击标签文本展开/收起）
        var inlineSettings = document.createElement('div');
        inlineSettings.className = 'rule-inline-settings';
        inlineSettings.dataset.ruleKeyword = keyword;
        inlineSettings.style.display = 'none';

        // 颜色行：12 预设 + 原生取色器
        var colorRow = document.createElement('div');
        colorRow.className = 'settings-row';
        var colorLabel = document.createElement('label');
        colorLabel.textContent = '颜色';
        colorRow.appendChild(colorLabel);
        var presetsWrap = document.createElement('div');
        presetsWrap.className = 'color-presets';
        var PRESET_COLORS = ['#fb7299','#ff6b6b','#ffa502','#feca57','#2ed573','#1dd1a1','#54a0ff','#5352ed','#a55eea','#778ca3','#cd853f','#2d3436'];
        PRESET_COLORS.forEach(function (c) {
          var preset = document.createElement('span');
          preset.className = 'color-preset';
          if (c === color) preset.classList.add('selected');
          preset.style.background = c;
          preset.addEventListener('click', function () {
            setRuleOption(currentTab, keyword, 'highlightColor', c);
            clearAllMarks();
            refreshUI();
            debouncedScanAll(currentConfig);
          });
          presetsWrap.appendChild(preset);
        });
        var colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'color-input';
        colorInput.value = color;
        colorInput.addEventListener('change', function () {
          setRuleOption(currentTab, keyword, 'highlightColor', this.value);
          clearAllMarks();
          refreshUI();
          debouncedScanAll(currentConfig);
        });
        presetsWrap.appendChild(colorInput);
        colorRow.appendChild(presetsWrap);
        inlineSettings.appendChild(colorRow);

        // 折叠开关（仅评论标签页）
        if (currentTab === 'comment') {
          var foldRow = document.createElement('div');
          foldRow.className = 'settings-row';
          var foldLabel = document.createElement('label');
          foldLabel.textContent = '折叠隐藏';
          foldRow.appendChild(foldLabel);
          var foldToggle = document.createElement('div');
          foldToggle.className = 'toggle-switch';
          if (opts.hideComment) foldToggle.classList.add('on');
          foldToggle.addEventListener('click', function () {
            var newVal = !getRuleOptions(currentTab, keyword).hideComment;
            setRuleOption(currentTab, keyword, 'hideComment', newVal);
            foldToggle.classList.toggle('on', newVal);
            clearAllMarks();
            debouncedScanAll(currentConfig);
          });
          foldRow.appendChild(foldToggle);
          inlineSettings.appendChild(foldRow);
        }

        // 前缀文本
        var prefixRow = document.createElement('div');
        prefixRow.className = 'settings-row';
        var prefixLabel = document.createElement('label');
        prefixLabel.textContent = '前缀';
        prefixRow.appendChild(prefixLabel);
        var prefixInput = document.createElement('input');
        prefixInput.type = 'text';
        prefixInput.className = 'text-input';
        prefixInput.value = opts.prefix || '';
        prefixInput.placeholder = '如 [广告]';
        prefixInput.addEventListener('change', function () {
          setRuleOption(currentTab, keyword, 'prefix', this.value);
          clearAllMarks();
          debouncedScanAll(currentConfig);
        });
        prefixRow.appendChild(prefixInput);
        inlineSettings.appendChild(prefixRow);

        // 后缀文本
        var suffixRow = document.createElement('div');
        suffixRow.className = 'settings-row';
        var suffixLabel = document.createElement('label');
        suffixLabel.textContent = '后缀';
        suffixRow.appendChild(suffixLabel);
        var suffixInput = document.createElement('input');
        suffixInput.type = 'text';
        suffixInput.className = 'text-input';
        suffixInput.value = opts.suffix || '';
        suffixInput.placeholder = '如 [已标记]';
        suffixInput.addEventListener('change', function () {
          setRuleOption(currentTab, keyword, 'suffix', this.value);
          clearAllMarks();
          debouncedScanAll(currentConfig);
        });
        suffixRow.appendChild(suffixInput);
        inlineSettings.appendChild(suffixRow);

        ruleList.appendChild(inlineSettings);

        // 点击标签文本展开/收起内联设置
        text.addEventListener('click', function (e) {
          e.stopPropagation();
          // 收起其他展开项
          var allInline = ruleList.querySelectorAll('.rule-inline-settings');
          allInline.forEach(function (s) {
            if (s !== inlineSettings) s.style.display = 'none';
          });
          inlineSettings.style.display = (inlineSettings.style.display === 'none') ? 'block' : 'none';
        });
      });
    }

    // 设置区：标题改为「默认设置（新建规则继承）」，仅在评论标签页显示
    var settingsSection = document.getElementById('matrix-settings-section');
    if (settingsSection) {
      settingsSection.style.display = (currentTab === 'comment') ? 'block' : 'none';
      var settingsTitle = settingsSection.querySelector('.settings-title');
      if (settingsTitle) {
        var titleText = settingsTitle.childNodes[0];
        if (titleText) titleText.nodeValue = '默认设置（新建规则继承） ';
      }
    }
    if (currentTab === 'comment') {
      var gOpts = currentConfig.comment.options || {};
      var gColorInput = document.getElementById('matrix-color-input');
      if (gColorInput) gColorInput.value = gOpts.highlightColor || '#fb7299';
      var gHideToggle = document.getElementById('matrix-hide-toggle');
      if (gHideToggle) gHideToggle.classList.toggle('on', !!gOpts.hideComment);
      var gPrefixInput = document.getElementById('matrix-prefix-input');
      if (gPrefixInput) gPrefixInput.value = gOpts.prefix || '';
      var gSuffixInput = document.getElementById('matrix-suffix-input');
      if (gSuffixInput) gSuffixInput.value = gOpts.suffix || '';
    }

    // UID 记录区：仅在用户名标签页显示，并渲染 UID 列表
    var uidSection = document.getElementById('matrix-uid-section');
    if (uidSection) {
      uidSection.style.display = (currentTab === 'username') ? 'block' : 'none';
    }
    if (currentTab === 'username') {
      var uidRec = currentConfig.uidRecord || { uids: [], label: '(有疑似矩阵记录)' };
      // 渲染 UID 列表
      var uidList = document.getElementById('matrix-uid-list');
      if (uidList) {
        uidList.innerHTML = '';
        if (!uidRec.uids.length) {
          var emptyHint = document.createElement('div');
          emptyHint.className = 'uid-hint';
          emptyHint.textContent = '暂无记录';
          uidList.appendChild(emptyHint);
        } else {
          uidRec.uids.forEach(function (uid) {
            var tag = document.createElement('span');
            tag.className = 'uid-tag';
            tag.textContent = uid;
            var rm = document.createElement('span');
            rm.className = 'remove-btn';
            rm.textContent = '×';
            rm.addEventListener('click', function () {
              var idx = currentConfig.uidRecord.uids.indexOf(uid);
              if (idx !== -1) {
                currentConfig.uidRecord.uids.splice(idx, 1);
                saveConfig(currentConfig);
                clearMarkedUsernames();
                refreshUI();
                debouncedScanAll(currentConfig);
              }
            });
            tag.appendChild(rm);
            uidList.appendChild(tag);
          });
        }
      }
      // 同步标记文本
      var labelInput = document.getElementById('matrix-uid-label-input');
      if (labelInput) labelInput.value = uidRec.label || '(有疑似矩阵记录)';
    }

    // 同步 AI 设置区值：Key 不回填明文（防 DOM 泄露），仅显示配置状态
    var aiCfg = currentConfig.aiConfig || { apiKey: '', model: 'deepseek-v4-flash' };
    var aiKeyInput = document.getElementById('matrix-ai-key-input');
    if (aiKeyInput) {
      aiKeyInput.value = ''; // 始终清空，不回填明文
      aiKeyInput.placeholder = aiCfg.apiKey ? '已配置（输入新值可覆盖）' : '未配置，请输入 sk-...';
    }
    var aiModelInput = document.getElementById('matrix-ai-model-input');
    if (aiModelInput) aiModelInput.value = aiCfg.model || 'deepseek-v4-flash';
  }

  // ==================== 右键菜单：记录为矩阵号 ====================
  function setupContextMenu() {
    document.addEventListener('contextmenu', function (e) {
      // 穿透 Shadow DOM 查找目标
      var target = e.target;
      if (e.composedPath) {
        var path = e.composedPath();
        target = path[0] || e.target;
      }
      // 检查目标或其祖先是否为用户名元素
      var usernameEl = null;
      // 用 composedPath 向上查找命中用户名选择器的元素
      for (var p = 0; p < (path ? path.length : 0); p++) {
        var node = path[p];
        if (node && node.nodeType === Node.ELEMENT_NODE && node.matches) {
          for (var s = 0; s < USERNAME_SELECTORS.length; s++) {
            try {
              if (node.matches(USERNAME_SELECTORS[s])) {
                usernameEl = node;
                break;
              }
            } catch (err) {}
          }
          if (usernameEl) break;
        }
      }

      // 若非用户名元素，检查是否为评论元素
      if (!usernameEl) {
        var commentEl = null;
        for (var p2 = 0; p2 < (path ? path.length : 0); p2++) {
          var node2 = path[p2];
          if (node2 && node2.nodeType === Node.ELEMENT_NODE && node2.matches) {
            for (var s2 = 0; s2 < COMMENT_SELECTORS.length; s2++) {
              try {
                if (node2.matches(COMMENT_SELECTORS[s2])) {
                  commentEl = node2;
                  break;
                }
              } catch (err2) {}
            }
            if (commentEl) break;
          }
        }
        if (commentEl) {
          // 是评论元素，显示 AI 分析菜单
          e.preventDefault();
          isMutating = true;
          var existingMenu2 = document.getElementById('matrix-context-menu');
          if (existingMenu2) existingMenu2.remove();

          var menu2 = document.createElement('div');
          menu2.id = 'matrix-context-menu';
          var analyses = [
            { mode: 'comment+user', label: 'AI分析（评论+用户名）' },
            { mode: 'user-all', label: 'AI分析此用户所有评论' },
            { mode: 'all', label: 'AI分析整个评论区' }
          ];
          analyses.forEach(function (a) {
            var mi = document.createElement('div');
            mi.className = 'matrix-menu-item';
            mi.textContent = a.label;
            mi.addEventListener('click', function (ev) {
              ev.stopPropagation();
              menu2.remove();
              isMutating = false;
              triggerAnalysis(a.mode, commentEl);
            });
            menu2.appendChild(mi);
          });

          positionMenu(menu2, e.clientX, e.clientY);
          isMutating = false;

          var closeHandler2 = function (ev2) {
            if (!menu2.contains(ev2.target)) {
              menu2.remove();
              document.removeEventListener('click', closeHandler2, true);
            }
          };
          setTimeout(function () {
            document.addEventListener('click', closeHandler2, true);
          }, 0);
          return;
        }
        return; // 非用户名也非评论，放行默认右键菜单
      }

      // 以下是用户名元素的处理
      // 阻止默认菜单
      e.preventDefault();

      // 创建自定义菜单
      isMutating = true;
      var existing = document.getElementById('matrix-context-menu');
      if (existing) existing.remove();

      var menu = document.createElement('div');
      menu.id = 'matrix-context-menu';
      var item = document.createElement('div');
      item.className = 'matrix-menu-item';
      item.textContent = '记录为矩阵号';
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        menu.remove();
        isMutating = false;
        var uid = extractUid(usernameEl);
        if (uid) {
          if (currentConfig.uidRecord.uids.indexOf(uid) === -1) {
            currentConfig.uidRecord.uids.push(uid);
            saveConfig(currentConfig);
          }
          // 立即标记该元素
          clearMarkedUsernames();
          debouncedScanAll(currentConfig);
          showToast('已记录 UID: ' + uid);
        } else {
          showToast('未找到 UID，请确认该用户名含 space.bilibili.com 链接');
        }
      });
      menu.appendChild(item);

      // 定位到鼠标位置（考虑视口边界）
      positionMenu(menu, e.clientX, e.clientY);
      isMutating = false;

      // 点击其他位置关闭菜单
      var closeHandler = function (ev2) {
        if (!menu.contains(ev2.target)) {
          menu.remove();
          document.removeEventListener('click', closeHandler, true);
        }
      };
      setTimeout(function () {
        document.addEventListener('click', closeHandler, true);
      }, 0);
    });
  }

  // 右键菜单定位：考虑视口边界，防止超出可视区域
  function positionMenu(menu, clientX, clientY) {
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    var x = clientX;
    var y = clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.visibility = 'visible';
  }

  // 轻量提示 toast
  function showToast(msg) {
    isMutating = true;
    var t = document.createElement('div');
    t.className = 'matrix-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    isMutating = false;
    setTimeout(function () {
      t.classList.add('show');
    }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2000);
  }

  // ==================== AI 分析模块 ====================
  // 调用 DeepSeek API 分析文本，提取关键字和正则表达式
  function analyzeWithDeepSeek(prompt, onResult, onError) {
    var aiConfig = currentConfig.aiConfig || {};
    var apiKey = aiConfig.apiKey;
    var model = aiConfig.model || 'deepseek-v4-flash';
    if (!apiKey) {
      if (onError) onError('请先在面板「AI 设置」中配置 API Key');
      return;
    }
    var systemPrompt = '你是B站矩阵号识别专家。分析给定的评论文本，提取能识别此类营销/引流/矩阵号评论的关键字和正则表达式。'
      + '关键字应是具体的词语片段（如"加群"、"兼职"），正则表达式用于匹配更复杂的模式（如"\\d+位"匹配"3位"）。'
      + '只返回JSON，格式：{"keywords":["关键字1","关键字2"],"regex":["正则1"]}'
      + '。如果无法提取则返回空数组。';
    if (typeof GM_xmlhttpRequest !== 'function') {
      if (onError) onError('当前环境不支持 GM_xmlhttpRequest，请检查油猴脚本管理器设置');
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      data: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        stream: false
      }),
      onload: function (response) {
        try {
          var data = JSON.parse(response.responseText);
          var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          var parsed = JSON.parse(content);
          if (onResult) onResult({
            keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : [])
              .filter(function (k) { return typeof k === 'string' && k.trim().length > 0 && k.length <= 100; })
              .filter(function (k, i, arr) { return arr.indexOf(k) === i; }),
            regex: (Array.isArray(parsed.regex) ? parsed.regex : [])
              .filter(function (r) { return typeof r === 'string' && r.trim().length > 0 && r.length <= 200; })
              .filter(function (r, i, arr) { return arr.indexOf(r) === i; })
          });
        } catch (e) {
          if (onError) onError('解析 AI 返回失败: ' + e.message);
        }
      },
      onerror: function () {
        if (onError) onError('网络请求失败，请检查 API Key 和网络');
      },
      ontimeout: function () {
        if (onError) onError('请求超时');
      },
      timeout: 30000
    });
  }

  // 结果确认弹窗
  function showAnalysisResultDialog(result) {
    isMutating = true;
    // 移除已有弹窗
    var existing = document.getElementById('matrix-analysis-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'matrix-analysis-modal-overlay';
    overlay.className = 'matrix-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'matrix-modal';

    var title = document.createElement('div');
    title.className = 'matrix-modal-title';
    title.textContent = 'AI 分析结果';
    modal.appendChild(title);

    var hint = document.createElement('div');
    hint.className = 'matrix-modal-hint';
    hint.textContent = '勾选要添加为评论规则的项目：';
    modal.appendChild(hint);

    var hasAny = false;

    // 关键字组
    if (result.keywords && result.keywords.length) {
      var kwTitle = document.createElement('div');
      kwTitle.className = 'matrix-modal-group-title';
      kwTitle.textContent = '关键字（普通匹配）';
      modal.appendChild(kwTitle);
      result.keywords.forEach(function (kw) {
        hasAny = true;
        var item = document.createElement('label');
        item.className = 'matrix-modal-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.type = 'keyword';
        cb.dataset.value = kw;
        item.appendChild(cb);
        var span = document.createElement('span');
        span.textContent = kw;
        item.appendChild(span);
        modal.appendChild(item);
      });
    }

    // 正则组
    if (result.regex && result.regex.length) {
      var reTitle = document.createElement('div');
      reTitle.className = 'matrix-modal-group-title';
      reTitle.textContent = '正则表达式';
      modal.appendChild(reTitle);
      result.regex.forEach(function (re) {
        hasAny = true;
        var item = document.createElement('label');
        item.className = 'matrix-modal-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.type = 'regex';
        cb.dataset.value = re;
        item.appendChild(cb);
        var span = document.createElement('span');
        span.textContent = re;
        span.style.fontFamily = 'monospace';
        item.appendChild(span);
        modal.appendChild(item);
      });
    }

    if (!hasAny) {
      var empty = document.createElement('div');
      empty.className = 'matrix-modal-hint';
      empty.textContent = 'AI 未提取到可用的关键字或正则';
      modal.appendChild(empty);
    }

    // 按钮行
    var btnRow = document.createElement('div');
    btnRow.className = 'matrix-modal-btn-row';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'matrix-modal-btn cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', function () {
      overlay.remove();
      isMutating = false;
    });
    btnRow.appendChild(cancelBtn);
    var addBtn = document.createElement('button');
    addBtn.className = 'matrix-modal-btn confirm';
    addBtn.textContent = '添加为规则';
    addBtn.disabled = !hasAny;
    addBtn.addEventListener('click', function () {
      var checkboxes = modal.querySelectorAll('input[type=checkbox]:checked');
      var added = 0;
      checkboxes.forEach(function (cb) {
        if (cb.dataset.type === 'keyword') {
          if (addRule('comment', cb.dataset.value, false)) added++;
        } else if (cb.dataset.type === 'regex') {
          if (addRule('comment', cb.dataset.value, true)) added++;
        }
      });
      overlay.remove();
      isMutating = false;
      if (added > 0) {
        clearMarkedComments();
        refreshUI();
        debouncedScanAll(currentConfig);
        showToast('已添加 ' + added + ' 条规则');
      } else {
        showToast('未添加新规则（可能已存在）');
      }
    });
    btnRow.appendChild(addBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
        isMutating = false;
      }
    });
    document.body.appendChild(overlay);
    isMutating = false;
  }

  // 收集当前页所有评论文本
  function collectAllCommentTexts() {
    var texts = [];
    for (var i = 0; i < COMMENT_SELECTORS.length; i++) {
      try {
        var els = deepQueryAll(COMMENT_SELECTORS[i], document);
        for (var j = 0; j < els.length; j++) {
          var t = deepTextContent(els[j]).trim();
          if (t) texts.push(t);
        }
      } catch (e) {}
    }
    return texts;
  }

  // 收集指定 UID 在当前页的所有评论
  function collectCommentsByUid(uid) {
    if (!uid) return [];
    var texts = [];
    var commentEls = deepQueryAll(COMMENT_SELECTORS[0], document); // 主选择器
    for (var i = 0; i < commentEls.length; i++) {
      var el = commentEls[i];
      // 向上找 bili-comment-renderer 容器，再找其内 user-name 提取 UID
      var renderer = el.closest ? el.closest('bili-comment-renderer') : null;
      if (!renderer) continue;
      var nameEl = deepQueryAll('#user-name', renderer)[0];
      if (!nameEl) continue;
      var elUid = extractUid(nameEl);
      if (elUid === uid) {
        var t = deepTextContent(el).trim();
        if (t) texts.push(t);
      }
    }
    return texts;
  }

  // 触发 AI 分析（统一入口）
  function triggerAnalysis(mode, commentEl) {
    var prompt = '';
    if (mode === 'comment+user') {
      var commentText = deepTextContent(commentEl).trim();
      var renderer = commentEl.closest ? commentEl.closest('bili-comment-renderer') : null;
      var nameEl = renderer ? deepQueryAll('#user-name', renderer)[0] : null;
      var username = nameEl ? nameEl.textContent.trim() : '';
      prompt = '用户名: ' + username + '\n评论: ' + commentText;
    } else if (mode === 'user-all') {
      var renderer2 = commentEl.closest ? commentEl.closest('bili-comment-renderer') : null;
      var nameEl2 = renderer2 ? deepQueryAll('#user-name', renderer2)[0] : null;
      var uid = nameEl2 ? extractUid(nameEl2) : null;
      if (!uid) { showToast('未找到该用户 UID'); return; }
      var userComments = collectCommentsByUid(uid);
      var userText = userComments.join('\n---\n');
      if (userText.length > 8000) userText = userText.substring(0, 8000) + '\n...(已截断)';
      prompt = '该用户（UID:' + uid + '）的所有评论:\n' + userText;
    } else if (mode === 'all') {
      var all = collectAllCommentTexts();
      var allText = all.join('\n---\n');
      if (allText.length > 8000) allText = allText.substring(0, 8000) + '\n...(已截断)';
      prompt = '以下是整个评论区的评论，请分析哪些可能是矩阵号/营销评论，提取识别关键字:\n' + allText;
    }
    if (!prompt) { showToast('无法获取分析内容'); return; }

    showToast('分析中...');
    analyzeWithDeepSeek(prompt, function (result) {
      showAnalysisResultDialog(result);
    }, function (err) {
      showToast(err);
    });
  }

  // ==================== 初始化 ====================
  function init() {
    // 加载配置
    currentConfig = loadConfig();

    // 注入样式
    injectStyles();

    // 创建面板
    createPanel();

    // 设置 DOM 变化监听
    setupMutationObserver();

    // 设置 SPA 路由监听
    setupRouteWatcher();

    // 设置右键菜单（记录为矩阵号）
    setupContextMenu();

    // 首次全量扫描（等待 Vue 渲染）
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(function () { scanAll(currentConfig); }, 500);
      });
    } else {
      setTimeout(function () { scanAll(currentConfig); }, 500);
    }

    // 定时器兜底：Shadow DOM 内部加载的新评论不会被 document 级
    // MutationObserver 捕获，需定期深度扫描。仅在配置了规则或已记录 UID 时执行。
    setInterval(function () {
      if (!currentConfig) return;
      if (currentConfig.username.rules.length || currentConfig.comment.rules.length || (currentConfig.uidRecord && currentConfig.uidRecord.uids.length)) {
        debouncedScanAll(currentConfig);
      }
    }, 2000);

    console.log('[矩阵号标记] 脚本已启动');
  }

  init();

})();
