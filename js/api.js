/* =========================================================
   共享数据的客户端
   ---------------------------------------------------------
   页面本身是静态的，要和「大家的共同记忆」打交道就得调后端。
   设计原则：**后端不可用时，一切照旧能用**。
     · 连得上 → 数据存到服务端，所有人共享
     · 连不上 → 自动退回 localStorage，只影响「别人看不看得到」，
                绝不让人连蜡烛都点不了
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
  var failedAt = 0;           /* 上次失败时间，失败后 45 秒内不再重试 */
  var RETRY_MS = 45000;

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

  function usable() {
    if (online === false && Date.now() - failedAt < RETRY_MS) return false;
    return true;
  }

  function markDown() {
    online = false;
    failedAt = Date.now();
    if (window.console && console.info) {
      console.info('[api] 数据服务暂时连不上，已切到本机模式（功能照旧，只是不共享）');
    }
  }

  function call(path, body, timeout) {
    if (!usable()) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeout || 12000);
      var opt = {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      };
      if (body) {
        opt.headers = { 'Content-Type': 'application/json' };
        opt.body = JSON.stringify(body);
      }
      fetch(BASE + path, opt).then(function (r) {
        clearTimeout(timer);
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status >= 500) { markDown(); return resolve(null); }
          online = true;
          resolve(j);
        });
      }).catch(function () {
        clearTimeout(timer);
        markDown();
        resolve(null);
      });
    });
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

    /* 读 */
    state: function () { return call('/api/state'); },
    exportAll: function () { return call('/api/export'); },

    /* 写 */
    candle: function () { return call('/api/candle', { visitor: visitor() }); },
    addDeco: function (item) {
      return call('/api/deco', Object.assign({}, item, { visitor: visitor() }));
    },
    removeDeco: function (id, code) {
      return call('/api/deco/remove', { id: id, visitor: visitor(), code: code || '' });
    },
    addNote: function (note) {
      return call('/api/note', Object.assign({}, note, { visitor: visitor() }));
    },
    removeNote: function (id, code) {
      return call('/api/note/remove', { id: id, code: code || '' });
    },
    addPhoto: function (photo) {
      return call('/api/photo', Object.assign({}, photo, { visitor: visitor() }), 60000);
    },
    removePhoto: function (id, code) {
      return call('/api/photo/remove', { id: id, code: code || '' });
    },
    checkAdmin: function (code) { return call('/api/admin', { code: code }); },

    /* 工具 */
    compress: compress
  };
})();
