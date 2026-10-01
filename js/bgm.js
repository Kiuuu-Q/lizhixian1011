/* =========================================================
   背景音乐：用 Web Audio API 现场合成一段八音盒版《生日快乐》
   ---------------------------------------------------------
   为什么不用 mp3？
     · 零体积、零请求，弱网/离线也能响
     · 不涉及任何音乐版权
   形态：一颗粒感很弱的正弦泛音 + 指数衰减包络 = 八音盒/音乐盒音色，
        再挂一个程序生成的混响，听起来才不干。
   对外只暴露 window.LZX_BGM（start / pause / resume / toggle / isPlaying）
   ========================================================= */
(function () {
  'use strict';

  var KEY = 'lzx_bgm_on';

  /* 音名 → 频率（A4 = 440Hz，十二平均律） */
  var F = {
    G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99
  };

  /* 《生日快乐》主旋律（1=C，3/4 拍）
     四句：5 5 6 5 1̇ 7 / 5 5 6 5 2̇ 1̇ / 5 5 5̇ 3̇ 1̇ 7 6 / 4̇ 4̇ 3̇ 1̇ 2̇ 1̇ */
  var SONG = [
    ['G4', .5], ['G4', .5], ['A4', 1], ['G4', 1], ['C5', 1], ['B4', 2],
    ['G4', .5], ['G4', .5], ['A4', 1], ['G4', 1], ['D5', 1], ['C5', 2],
    ['G4', .5], ['G4', .5], ['G5', 1], ['E5', 1], ['C5', 1], ['B4', 1], ['A4', 2],
    ['F5', .5], ['F5', .5], ['E5', 1], ['C5', 1], ['D5', 1], ['C5', 3]
  ];

  /* 每小节一个低音，给旋律搭个地板，不然太飘 */
  var BASS = [
    ['G3', 3], ['G3', 3],
    ['G3', 3], ['C4', 3],
    ['C4', 3], ['C4', 3],
    ['F4', 3], ['C4', 3]
  ];

  var BEAT = 0.72;          /* 一拍的秒数 → 约 83 BPM */
  var VOL = 0.30;           /* 主音量 */
  var TAIL = 2 * BEAT;      /* 一轮结束后留白 */

  var ctx = null, master = null, bus = null;
  var playing = false, cycleTimer = null, started = false;
  var listeners = [];

  /* ---------- 程序生成一段混响脉冲，等价于「小房间」 ---------- */
  function makeImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function build() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }

    master = ctx.createGain();
    master.gain.value = 0;

    /* 混响支路：bus → 干声 → master，同时 bus → 混响 → master */
    var verb = ctx.createConvolver();
    verb.buffer = makeImpulse(2.1, 2.6);
    var verbGain = ctx.createGain();
    verbGain.gain.value = 0.34;
    bus = ctx.createGain();
    bus.gain.value = 1;

    bus.connect(master);
    bus.connect(verb);
    verb.connect(verbGain);
    verbGain.connect(master);
    master.connect(ctx.destination);
    return true;
  }

  /* ---------- 一颗「八音盒」音：基音 + 三个泛音，各自不同的衰减 ---------- */
  function bell(freq, at, dur, vol) {
    var partials = [
      [1,   1.00, 1.00],
      [2,   0.30, 0.58],
      [3,   0.11, 0.40],
      [5.4, 0.045, 0.24]   /* 非整数倍泛音 → 那点金属味 */
    ];
    for (var i = 0; i < partials.length; i++) {
      var p = partials[i];
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p[0];
      var g = ctx.createGain();
      var peak = Math.max(vol * p[1], 0.0002);
      var end = at + Math.max(dur * p[2], 0.06);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g);
      g.connect(bus);
      osc.start(at);
      osc.stop(end + 0.04);
    }
  }

  /* 低音：音量小、衰减长，只做铺底 */
  function bassNote(freq, at, dur) {
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.055, at + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur * 1.35);
    osc.connect(g);
    g.connect(bus);
    osc.start(at);
    osc.stop(at + dur * 1.4 + 0.05);
  }

  /* ---------- 排一轮，快放完时再排下一轮，实现无缝循环 ---------- */
  function scheduleCycle(from) {
    var t = from;
    for (var i = 0; i < SONG.length; i++) {
      var note = SONG[i];
      var dur = note[1] * BEAT;
      bell(F[note[0]], t, dur * 1.9, VOL);
      t += dur;
    }
    var bt = from;
    for (var k = 0; k < BASS.length; k++) {
      var bd = BASS[k][1] * BEAT;
      bassNote(F[BASS[k][0]], bt, bd * 0.92);
      bt += bd;
    }

    var next = t + TAIL;
    var waitMs = (next - ctx.currentTime - 0.45) * 1000;
    cycleTimer = setTimeout(function () {
      if (playing) scheduleCycle(next);
    }, Math.max(60, waitMs));
  }

  function clearTimer() {
    if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) listeners[i](playing);
  }

  function fadeTo(v, sec) {
    if (!master || !ctx) return;
    var now = ctx.currentTime;
    try {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
      master.gain.linearRampToValueAtTime(v, now + sec);
    } catch (e) { master.gain.value = v; }
  }

  /* ---------- 对外 API ---------- */
  function start() {
    /* 必须在用户手势里调用，否则 iOS / Chrome 会拒绝出声 */
    if (!build()) return false;
    if (ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) {}
    }
    if (playing) return true;
    playing = true;
    started = true;
    clearTimer();
    fadeTo(VOL, 1.8);
    scheduleCycle(ctx.currentTime + 0.25);
    writePref(true);
    emit();
    return true;
  }

  function pause() {
    if (!playing) return;
    playing = false;
    clearTimer();
    fadeTo(0, 0.7);
    writePref(false);
    emit();
  }

  function toggle() {
    if (playing) { pause(); return false; }
    return start();
  }

  function writePref(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
  }

  /* 被嵌在 iframe 里（比如编辑器的内置预览面板）时，默认不出声 ——
     预览往往是自动打开的，一进来就循环放歌会吵到人。手动点右上角按钮仍然能听。 */
  function inEmbed() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }

  function readPref() {
    if (inEmbed()) return false;
    try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  window.LZX_BGM = {
    start: start,
    pause: pause,
    toggle: toggle,
    isPlaying: function () { return playing; },
    isStarted: function () { return started; },
    enabled: readPref,
    onChange: onChange
  };

  /* 切到别的 App / 锁屏时自动停，回来不自动响（礼貌一些） */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && playing) pause();
  });
})();
