/* =========================================================
   共享数据的客户端
   ---------------------------------------------------------
   页面本身是静态的，要和「大家的共同记忆」打交道就得调后端。
   设计原则：**后端不可用时，一切照旧能用**；但**一旦连上，就绝不再掉队**。
     · 连得上 → 数据存到服务端，所有人共享
     · 连不上 → 退回本机模式，并且**退避重试**，一恢复立刻把数据补上

   ⚠️ 「手机上一直是本机模式」的教训（2026-10-09）：
     旧版一次请求失败就把 online 置 false、并**短路 45 秒**，
     而且**失败后没有任何自动重试**（页面只在初始化时拉一次数据）。
     手机网络比桌面慢得多（这个接口桌面实测都要 3.3 秒），
     12 秒的超时很容易撞上 —— 一旦撞上就永久卡在「本机模式」，只能刷新。
     现在：超时放宽到 20 秒 + 失败后退避重试（3s → 5s → 9s … 封顶 30s）
     + 页面回到前台 / 网络恢复时立即重试。

   对外暴露 window.LZX_API
   ========================================================= */
(function () {
  'use strict';

  /* =========================================================
     ⚠️ 数据服务地址：部署后填这里（末尾不要带斜杠）。
        留空 = 和页面同源（把页面也交给同一个服务托管时用这个）。
     例：var BASE = 'https://xxxx.example.com';
     ========================================================= */
  var BASE = 'https://ca12338c22de4407b71d76f95b84c697.app.workbuddy.host';

  var VISITOR_KEY = 'lzx_visitor';

  var online = null;          /* null 未知 / true / false */
  var gate = false;           /* true = 暂停发新请求，等退避重试放行 */
  /* ⚠️ 退避从 1 秒起步（原来 3 秒）、倍率用 ×2：1→2→4→8→16→30 封顶。
     原因：用户「另一台设备打开看到 0」多半是**打开那一瞬间请求失败**，
     起步太慢会让「本机模式」白挂好几秒。快速重试能自己爬出来。 */
  var backoff = 1000;
  var MAX_BACKOFF = 30000;
  var BACKOFF_MUL = 2;
  var retryTimer = null;
  var statusFns = [];         /* 状态变化通知（app.js 靠它在恢复的一刻补数据） */
  var latestState = null;     /* 拒绝迟到的旧版本状态，避免刚保存的内容被旧响应覆盖 */
  var inflightState = null;   /* 同一时刻的多处 state() 合并成一次请求 */

  /* 超时：读宽松、写适中、上传很宽松（手机流量下大图要慢得多） */
  var T_GET = 30000;          /* 手机弱网保留足够等待时间，避免连续取消仍可能成功的读取 */
  var T_POST = 15000;
  var T_UPLOAD = 60000;

  /* 访客身份：和涂鸦画板共用同一个 id，这样「谁的装饰/笔画」判定一致 */
  function visitor() {
    var v = null;
    try { v = localStorage.getItem(VISITOR_KEY); } catch (e) {}
    if (!v) {
      v = 'v' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem(VISITOR_KEY, v); } catch (e) {}
    }
    return v;
  }

  function usable() { return !gate; }

  function emit() {
    for (var i = 0; i < statusFns.length; i++) {
      try { statusFns[i](online); } catch (e) {}
    }
  }

  function markUp() {
    gate = false;
    backoff = 1000;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (online !== true) {
      online = true;
      if (window.console && console.info) console.info('[api] 已连上数据服务');
      emit();
    }
  }

  /* 最后一次失败的原因（给用户看的，用于诊断「为什么连不上」） */
  var lastErr = '';
  function noteErr(why) { lastErr = why; }

  function markDown() {
    gate = true;
    if (online !== false) {
      online = false;
      if (window.console && console.info) {
        console.info('[api] 数据服务暂时连不上，先按本机模式运行（会自动重试，不用刷新）');
      }
      emit();
    }
    scheduleRetry();
  }

  /* 退避重试：到点放行一次，由这次真实请求去确认服务是否恢复。
     只要恢复，online 会变回 true 并通知上层把数据补上。 */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      gate = false;
      backoff = Math.min(backoff * BACKOFF_MUL, MAX_BACKOFF);
      call('/api/state', null, T_GET);   /* 探活，结果由 markUp/markDown 处理 */
    }, backoff);
  }

  function call(path, body, timeout) {
    if (!usable()) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeout || T_GET);
      var opt = {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      };
      if (body) {
        opt.headers = { 'Content-Type': 'text/plain;charset=UTF-8' }; // JSON 内容不变，避免跨域预检多一次网络往返
        opt.body = JSON.stringify(body);
      }
      /* ⚠️ 加一个随机参数绕过中间层缓存 —— 曾经不带参数时，
         同一时刻不同设备可能拿到**不同版本**的数据（一个 66、一个 72）。 */
      var bust = (BASE + path).indexOf('?') >= 0 ? '&' : '?';
      fetch(BASE + path + bust + '_=' + Date.now() + Math.random().toString(36).slice(2, 6), opt).then(function (r) {
        return r.json().then(function (j) {
          clearTimeout(timer);
          if (!r.ok || !j || j.ok !== true) {
            noteErr((j && (j.err || j.error || j.message)) || ('服务响应异常（HTTP ' + r.status + '）'));
            // 业务拒绝不表示断网；仍保留写入队列，但不能声称已经上传成功。
            if (r.status >= 500 || r.status === 429 || (r.ok && (!j || typeof j.ok !== 'boolean'))) markDown();
            return resolve(null);
          }
          if (path === '/api/state') {
            if (!Array.isArray(j.notes) || typeof j.candles !== 'number') {
              noteErr('共享记录格式异常');
              markDown();
              return resolve(null);
            }
            if (latestState && typeof latestState.rev === 'number' &&
                typeof j.rev === 'number' && j.rev < latestState.rev) j = latestState;
            else latestState = j;
          }
          lastErr = '';
          markUp();
          resolve(j);
        });
      }).catch(function (e) {
        clearTimeout(timer);
        noteErr(e && e.name === 'AbortError' ? '请求超时' : (e instanceof SyntaxError ? '服务未返回有效数据' : '网络错误'));
        markDown();
        resolve(null);
      });
    });
  }

  /* state 去重：页面初始化时蜡烛 / 装饰 / 便签会各调一次 state()，
     合并成一次网络请求 —— 手机端能快不少。 */
  function state() {
    if (inflightState) return inflightState;
    var p = call('/api/state', null, T_GET);
    inflightState = p;
    p.then(function () { inflightState = null; });
    return p;
  }

  /* 图片压缩：上传前在本地缩到 1600px / JPEG，省流量也省服务器空间 */
  function compress(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('not-image'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        var x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, cw, ch);
        x.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        resolve({ data: c.toDataURL('image/jpeg', quality || 0.82), w: cw, h: ch });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode-fail')); };
      img.src = url;
    });
  }

  window.LZX_API = {
    /* 状态 */
    isOnline: function () { return online; },
    base: function () { return BASE; },
    setBase: function (v) { BASE = String(v || '').replace(/\/$/, ''); },
    visitor: visitor,
    onStatus: function (fn) { if (typeof fn === 'function') statusFns.push(fn); },
    lastError: function () { return lastErr; },
    /* 手动催一次重试（页面回到前台、网络恢复时用） */
    retryNow: function () {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (!gate) return;
      gate = false;
      backoff = 1000;
      call('/api/state', null, T_GET);
    },

    /* 读 */
    state: state,
    exportAll: function () { return call('/api/export'); },

    /* 写 */
    candle: function () { return call('/api/candle', { visitor: visitor() }, T_POST); },
    addDeco: function (item) {
      return call('/api/deco', Object.assign({}, item, { visitor: visitor() }), T_POST);
    },
    removeDeco: function (id, code) {
      return call('/api/deco/remove', { id: id, visitor: visitor(), code: code || '' }, T_POST);
    },
    addNote: function (note) {
      return call('/api/note', Object.assign({}, note, { visitor: visitor() }), T_POST);
    },
    removeNote: function (id, code) {
      return call('/api/note/remove', { id: id, visitor: visitor(), code: code || '' }, T_POST);
    },
    addPhoto: function (photo) {
      return call('/api/photo', Object.assign({}, photo, { visitor: visitor() }), T_UPLOAD);
    },
    removePhoto: function (id, code) {
      return call('/api/photo/remove', { id: id, visitor: visitor(), code: code || '' }, T_UPLOAD);
    },
    checkAdmin: function (code) { return call('/api/admin', { code: code }, T_POST); },

    /* 工具 */
    compress: compress
  };
})();
