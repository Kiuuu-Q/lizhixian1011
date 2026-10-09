/* 涂鸦持久保存：IndexedDB 主副本 + localStorage 兼容副本，不删旧笔画腾空间。 */
(function () {
  'use strict';
  var KEY = 'lzx_board', META = 'lzx_board_saved_at', DETAILS = 'lzx_board_meta_v2';
  var opening = null, queue = Promise.resolve(), lastStamp = 0, metadata = {};
  function open() {
    if (opening) return opening;
    opening = new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req;
      try { req = indexedDB.open('lzx-birthday-memory', 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () { req.result.createObjectStore('records'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = req.onblocked = function () { resolve(null); };
    });
    return opening;
  }
  function local() {
    try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return { strokes: Array.isArray(a) ? a : [], at: Number(localStorage.getItem(META)) || 0, meta:JSON.parse(localStorage.getItem(DETAILS)||'{}') };  }
    catch (e) { return { strokes: [], at: 0 }; }
  }
  function read(db, key) {
    return new Promise(function (resolve) {
      if (!db) return resolve(null);
      try {
        var t = db.transaction('records', 'readonly'), r = t.objectStore('records').get(key || 'board');
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function write(db, snapshot, key) {
    return new Promise(function (resolve) {
      if (!db) return resolve(false);
      try {
        var t = db.transaction('records', 'readwrite');
        t.objectStore('records').put(snapshot, key || 'board');
        t.oncomplete = function () { resolve(true); };
        t.onerror = t.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }
  function load() {
    var old = local();
    return open().then(read).then(function (saved) {
      if (!saved || !Array.isArray(saved.strokes)) { metadata = old.meta || {}; return old.strokes; }
      metadata = old.at > saved.at ? (old.meta || {}) : (saved.meta || {});
      if (old.at || !old.strokes.length) return old.at > saved.at ? old.strokes : saved.strokes;
      // 首次迁移兼容旧版；只合并缺失笔画，原记录不清除。
      var result = saved.strokes.slice(), seen = new Set(result.map(JSON.stringify));
      old.strokes.forEach(function (s) { var key = JSON.stringify(s); if (!seen.has(key)) { result.push(s); seen.add(key); } });
      return result;
    });
  }
  function save(strokes, meta) {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    var text = JSON.stringify(strokes), snapshot = { strokes: JSON.parse(text), at: lastStamp, meta: meta || metadata }, localOK = false;
    try { localStorage.setItem(KEY, text); localStorage.setItem(DETAILS, JSON.stringify(snapshot.meta)); localStorage.setItem(META, String(lastStamp)); localOK = true; } catch (e) {}
    queue = queue.then(function () { return open().then(function (db) { return write(db, snapshot); }); }).then(function (ok) { return { ok: ok || localOK, indexedDB: ok }; });
    return queue;
  }
  window.LZX_BOARD_STORE = { load: load, save: save,
    loadGallery: function () {
      var old = [];
      try { old = JSON.parse(localStorage.getItem('lzx_gallery') || '[]'); } catch (e) {}
      if (!Array.isArray(old)) old = [];
      return open().then(function(db) { return read(db, 'gallery'); }).then(function(saved) {
        var all = saved && Array.isArray(saved.items) ? saved.items.slice() : [], index = new Map();
        all.forEach(function(p, i) { index.set(p.uploadId || p.pid || p.src, i); });
        old.forEach(function(p) { var key=p.uploadId || p.pid || p.src; if (index.has(key)) Object.assign(all[index.get(key)], p); else { index.set(key, all.length); all.push(p); } });
        return all;
      });
    },
    saveGallery: function (items) {
      var snapshot = {items:JSON.parse(JSON.stringify(items))};
      queue = queue.then(function() { return open().then(function(db) { return write(db, snapshot, 'gallery'); }); });
      return queue;
    },
    metadata: function () { return metadata; } };
})();
