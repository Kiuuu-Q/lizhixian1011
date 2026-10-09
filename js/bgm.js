/* =========================================================
   声音引擎：Web Audio API 现场合成
   ---------------------------------------------------------
   两个部分：
     1. 背景音乐 —— 八音盒版的《生日快乐》，**三层编配**（刻意从简）：
          ① 主旋律  八音盒音色，唯一的主角，音符之间要留缝
          ② 和声    只给 ≥2 拍的长音，严格取和弦音，音量很轻
          ③ 低音    每个和弦换一次，低八度长音，只当地基

     ⚠️ 「音乐乱」踩过的三个坑，别再犯：
       · 时值乘大系数（曾经 1.9 / 1.5）→ 音符互相叠，再叠上混响就糊成一团。
         现在只多给 5%，颗粒感全靠「音与音之间那道缝」。
       · 挂 DynamicsCompressor → 八音盒的瞬态被「压一下松一下」，
         整首曲子呼哧呼哧地起伏，非常像「乱」。峰值靠音量标定控制，不要用压缩器。
       · 用递归 setTimeout 排下一轮 → 页面一卡（放烟花时动辄几百毫秒）就晚触发，
         下一轮起点成了过去时刻，整轮音符被一次性倾泻出来 = 抢拍糊成一团。
         现在是**前瞻调度**：维护绝对时间轴，定期检查「未来 6 秒内排满了没有」。
     2. 音效 —— 烟花升空的「咻」与炸开的「砰」，由烟花引擎逐朵触发

   为什么全部用合成、不用音频文件：
     · 零体积、零请求，弱网也能响
     · 不涉及任何音乐版权
   对外暴露 window.LZX_BGM
   （start / pause / resume / toggle / isPlaying / boom / whoosh）
   ========================================================= */
(function () {
  'use strict';

  var KEY = 'lzx_bgm_on';

  /* 音名 → 频率（A4 = 440Hz，十二平均律）。写成函数，
     这样和弦音可以算出来，不用手抄一张频率表。 */
  var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function freqOf(name) {
    var m = /^([A-G])(#|b)?(-?\d+)$/.exec(name);
    if (!m) return 440;
    var n = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    var midi = (parseInt(m[3], 10) + 1) * 12 + n;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
  function midiOf(name) {
    var m = /^([A-G])(#|b)?(-?\d+)$/.exec(name);
    var n = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return (parseInt(m[3], 10) + 1) * 12 + n;
  }
  function nameOf(midi) {
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /* 《生日快乐》主旋律（1=C）
     四句：5 5 6 5 1̇ 7 / 5 5 6 5 2̇ 1̇ / 5 5 5̇ 3̇ 1̇ 7 6 / 4̇ 4̇ 3̇ 1̇ 2̇ 1̇ */
  var SONG = [
    ['G4', .5], ['G4', .5], ['A4', 1], ['G4', 1], ['C5', 1], ['B4', 2],
    ['G4', .5], ['G4', .5], ['A4', 1], ['G4', 1], ['D5', 1], ['C5', 2],
    ['G4', .5], ['G4', .5], ['G5', 1], ['E5', 1], ['C5', 1], ['B4', 1], ['A4', 2],
    ['F5', .5], ['F5', .5], ['E5', 1], ['C5', 1], ['D5', 1], ['C5', 3]
  ];

  /* 每个旋律音配一个和弦根音 —— 就是《生日快乐》最常规的那套和声
     （C → G → C → G → D → G → C → F → C …），和声部与琶音都从它推出来 */
  var CHORDS = [
    'C4', 'C4', 'G3', 'G3', 'C4', 'C4',      /* 第一句 */
    'C4', 'C4', 'G3', 'G3', 'G3', 'G3',      /* 第二句 */
    'G3', 'G3', 'C4', 'C4', 'C4', 'F3', 'F3',/* 第三句 */
    'F3', 'F3', 'C4', 'C4', 'G3', 'C4'       /* 第四句 */
  ];

  var BEAT = 0.72;          /* 一拍的秒数 → 约 83 BPM */
  var VOL = 0.40;           /* 总音量（压缩器去掉了、声部也少了，可以抬一点） */
  var MEL_VOL = 0.30;       /* 主旋律 —— 唯一的主角 */
  var HARM_VOL = 0.045;     /* 和声 —— 很轻，只在长音处托一下 */
  var BASS_VOL = 0.05;      /* 低音 —— 只当地基 */
  var TAIL = 2.5 * BEAT;    /* 一轮之间留点呼吸（时值收紧了，这里补回来一点） */

  /* 当前还活着的振荡器。暂停 / 重新开始时要把它们**真正停掉** ——
     只把音量淡到 0 是不够的：已经排到时间轴上的音符还在走，
     再点播放就会「新的一轮 + 旧的残余」叠在一起，听起来就是错位、发乱。 */
  var live = [];

  function track(osc) {
    live.push(osc);
    osc.onended = function () {
      var i = live.indexOf(osc);
      if (i >= 0) live.splice(i, 1);
    };
  }

  function killAll() {
    var list = live.slice();
    live.length = 0;
    for (var i = 0; i < list.length; i++) {
      try { list[i].stop(); } catch (e) {}
    }
  }

  var ctx = null, master = null, bus = null, musicGain = null;
  var playing = false, started = false;
  var listeners = [];
  /* ⚠️ 区分两件事：
       playing   —— 此刻音乐在不在响（切后台会自动停）
       userMuted —— 用户有没有主动关掉声音（右上角按钮）
     音效只看 userMuted，所以「切后台自动停音乐」不会把音效一起弄哑，
     也不会把「关闭」写进偏好里导致下次打开彻底没声。 */
  var userMuted = false;

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

  /* 白噪声缓冲只生成一次，烟花音效反复用（每朵都新建一个太浪费） */
  var noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 2.6);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function build() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }

    /* 总输出：**固定 1，不再淡入**。
       ⚠️ 这里原来是「master.gain 从 0 淡入到 VOL、耗时 1.8 秒」——
          那是为「音乐淡入」设计的，但**音效也被它一起拖累**了：
          开场烟花在点击后 0.56 秒就炸了，那会儿 master 才升到 12%，
          再乘上 whoosh 本身就很轻的音量 → 听感就是「一开始的烟花没有声音」。
          现在拆成两条独立支路：音乐走 musicGain（要淡入淡出），音效直接进 bus。 */
    master = ctx.createGain();
    master.gain.value = 1;

    /* 音乐的专属音量层：start() 淡入、pause() 淡出 —— 只作用于音乐 */
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;

    /* ⚠️ 这里原本挂着一个限幅器（threshold -10dB / ratio 6:1）——
       它是个「听着乱」的隐形元凶：八音盒每个音都是很尖的瞬态，
       压缩器会不停「压一下、松一下」，整首曲子就呼哧呼哧地起伏。
       现在声部已经减到最少，算下来峰值也就 0.2 上下，根本用不着它，去掉。 */

    /* 混响支路：bus → 干声 → master，同时 bus → 混响 → master。
       混响收到 0.9 秒 —— 八音盒最怕尾巴拖太长，音符之间会糊成一片。 */
    var verb = ctx.createConvolver();
    verb.buffer = makeImpulse(0.9, 2.6);
    var verbGain = ctx.createGain();
    verbGain.gain.value = 0.16;
    bus = ctx.createGain();
    bus.gain.value = 1;

    musicGain.connect(bus);       /* 音乐：musicGain → bus → 输出（要淡入淡出） */
    bus.connect(master);          /* 音效直接进 bus（随点随响，不参与淡入） */
    bus.connect(verb);
    verb.connect(verbGain);
    verbGain.connect(master);
    master.connect(ctx.destination);
    return true;
  }

  /* ---------- 声部 1：八音盒主音（基音 + 三个泛音，各自不同的衰减） ---------- */
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
      g.connect(musicGain);
      osc.start(at);
      osc.stop(end + 0.04);
      track(osc);
    }
  }

  /* ---------- 声部 2：和声用的软音色（两个泛音，圆润不抢） ---------- */
  function soft(freq, at, dur, vol) {
    var partials = [[1, 1.0, 1.0], [2, 0.22, 0.5]];
    for (var i = 0; i < partials.length; i++) {
      var p = partials[i];
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p[0];
      var g = ctx.createGain();
      var end = at + Math.max(dur * p[2], 0.08);
      g.gain.setValueAtTime(0.0001, at);
      /* 软起音：8ms 而不是 6ms，听感上就没那么「钉」 */
      g.gain.exponentialRampToValueAtTime(Math.max(vol * p[1], 0.0002), at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g);
      g.connect(musicGain);
      osc.start(at);
      osc.stop(end + 0.04);
      track(osc);
    }
  }

  /* ---------- 声部 3：低音 ----------
     ⚠️ 衰减必须**严格在该和弦段内结束**（at + dur，不乘系数）：
        否则前一个和弦的低音会拖进下一个和弦里，C 和 G 同时响 → 立刻不协和。 */
  function bassNote(freq, at, dur) {
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    var end = at + Math.max(dur, 0.34);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(BASS_VOL, at + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(musicGain);
    osc.start(at);
    osc.stop(end + 0.04);
    track(osc);
  }

  /* 大三和弦的音（本项目用到的和弦都是大三和弦） */
  function triad(rootName) {
    var r = midiOf(rootName);
    return [nameOf(r), nameOf(r + 4), nameOf(r + 7)];
  }

  /* 给旋律音配一个「下方最近的和弦音」。
     ⚠️ 找不到就返回 null（= 这个音不配和声）。
        旧版在找不到时兜底成「旋律下方 5 个半音」，那是纯拍脑袋 ——
        经常落在一个既不属于和弦、也不属于调内的音上，一听就「跑调 / 发乱」。
        宁可少一层和声，也不能塞一个不对的音。 */
  function harmonyFor(melodyName, chordRoot) {
    var m = midiOf(melodyName);
    var tones = triad(chordRoot);
    var best = null;
    for (var i = 0; i < tones.length; i++) {
      var c = midiOf(tones[i]);
      /* 每个和弦音各往下试两个八度，挑「比旋律低 3~16 个半音」里最高的那个 */
      for (var k = 0; k <= 2; k++) {
        var cand = c - k * 12;
        var d = m - cand;
        if (d < 3 || d > 16) continue;
        if (best === null || cand > best) best = cand;
      }
    }
    return best;
  }

  /* ---------- 排一轮：三层编配。起点 from 由调度器给定（一定是未来时刻）----------
     ⚠️ 音的长度**不要乘大系数**：八音盒的颗粒感来自「音符之间有缝」。
        旧版把时值乘 1.9（和声 1.5），一个音还没落下一个就压上来，
        再叠上长混响，听感就是糊成一团「乱」。现在只多给 5%。 */
  function scheduleCycle(from) {
    /* 先算出每个旋律音的起始时刻，所有声部都对齐这条时间轴 */
    var times = [from];
    for (var i = 0; i < SONG.length; i++) times.push(times[i] + SONG[i][1] * BEAT);

    /* ① 主旋律 —— 唯一的主角，颗粒分明 */
    for (var m = 0; m < SONG.length; m++) {
      bell(freqOf(SONG[m][0]), times[m], SONG[m][1] * BEAT * 1.05, MEL_VOL);
    }

    /* ② 和声 —— 只给「2 拍及以上」的长音。
          给 1 拍的音也配的话，和声就和旋律一样密，两个声部在同一个音区抢，
          听感立刻发浑；只留给长音，它才起得到「托一下」的作用。 */
    for (var h = 0; h < SONG.length; h++) {
      if (SONG[h][1] < 2) continue;
      var hv = harmonyFor(SONG[h][0], CHORDS[h]);
      if (hv === null) continue;
      soft(freqOf(nameOf(hv)), times[h], SONG[h][1] * BEAT * 0.9, HARM_VOL);
    }

    /* ③ 低音 —— 每个和弦段一个长音，收在段内，绝不拖进下一个和弦 */
    var segStart = 0;
    for (var s = 1; s <= SONG.length; s++) {
      if (s < SONG.length && CHORDS[s] === CHORDS[segStart]) continue;
      var root = CHORDS[segStart];
      var st = times[segStart];
      var len = times[s] - st;
      bassNote(freqOf(nameOf(midiOf(root) - 12)), st, Math.min(len * 0.8, 2.1));
      segStart = s;
    }
  }

  /* ---------- 前瞻调度器 ----------
     旧做法是「递归 setTimeout」：每轮快放完时才定时排下一轮。
     问题是页面一卡（放烟花时动辄卡几百毫秒），定时器就晚触发，
     下一轮的起点已经变成过去时刻 —— Web Audio 会把整轮音符**一次性倾泻出来**，
     听感就是「突然抢拍、全糊在一起」。这就是「音乐乱了」的机制。
     现在改成：维护一个**绝对时间轴** nextAt，每 1.5 秒检查一次，
     只要「未来 6 秒内还没排音符」就继续往后排 —— 单次定时晚多久都不怕。 */
  var CYCLE = (function () {
    var t = 0;
    for (var i = 0; i < SONG.length; i++) t += SONG[i][1] * BEAT;
    return t + TAIL;
  })();
  var LOOKAHEAD = 6;
  var nextAt = 0, lookTimer = null;

  function tick() {
    if (!playing || !ctx) return;
    var now = ctx.currentTime;
    /* 落后太多（比如刚从后台回来）就从当下重新接上，不去追已经过去的时刻 */
    if (nextAt < now - 0.25) nextAt = now + 0.3;
    var guard = 0;
    while (nextAt < now + LOOKAHEAD && guard++ < 4) {
      scheduleCycle(nextAt);
      nextAt += CYCLE;
    }
  }

  function stopTimers() {
    if (lookTimer) { clearInterval(lookTimer); lookTimer = null; }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) listeners[i](playing);
  }

  /* 只淡音乐（音乐专属的 musicGain）—— 音效不被它牵连 */
  function fadeTo(v, sec) {
    if (!musicGain || !ctx) return;
    var now = ctx.currentTime;
    try {
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(Math.max(musicGain.gain.value, 0.0001), now);
      musicGain.gain.linearRampToValueAtTime(v, now + sec);
    } catch (e) { musicGain.gain.value = v; }
  }

  /* =========================================================
     音效：烟花
     ---------------------------------------------------------
     两种声音：
       whoosh —— 升空的那声「咻」，频率往上扫，时长跟着火箭飞行时间
       boom   —— 炸开的那声「砰」：低频推力 + 噪声爆裂 + 可选噼啪余响
     和视觉是同一帧触发的，所以音画对得上。
     ========================================================= */
  var lastBoom = 0, boomLive = 0;

  function whoosh(seconds) {
    if (userMuted || !ctx) return;
    var dur = Math.min(Math.max(seconds || 0.9, 0.35), 1.8);
    var at = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = noise();
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 5.5;
    bp.frequency.setValueAtTime(320, at);
    bp.frequency.exponentialRampToValueAtTime(1500, at + dur * 0.92);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.10, at + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp); bp.connect(g); g.connect(bus);
    src.start(at); src.stop(at + dur + 0.05);

    /* 再叠一层往上扫的「哨音」：真实烟花升空那声「咻」其实是燃料啸叫，
       只靠带通噪声太「沙沙」，加一条正弦扫频才够尖锐、够远。 */
    var tw = ctx.createOscillator();
    tw.type = 'sine';
    tw.frequency.setValueAtTime(620, at);
    tw.frequency.exponentialRampToValueAtTime(1750, at + dur * 0.95);
    var twg = ctx.createGain();
    twg.gain.setValueAtTime(0.0001, at);
    twg.gain.exponentialRampToValueAtTime(0.026, at + dur * 0.6);
    twg.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    tw.connect(twg); twg.connect(bus);
    tw.start(at); tw.stop(at + dur + 0.05);
  }

  function boom(big, toneIndex) {
    if (userMuted || !ctx) return;
    var now = ctx.currentTime;
    /* 同一时刻炸太多会糊成一片噪音，做个节流 + 并发上限 */
    if (now - lastBoom < 0.075 || boomLive >= 5) return;
    lastBoom = now;
    boomLive++;
    setTimeout(function () { boomLive--; }, 900);

    /* ⚠️ 音效现在直通 master（1.0），不再被音乐的淡入衰减 ——
       峰值要和音乐（0.40）加在一起不越过 1.0，所以定在 0.36 / 0.22。 */
    var lvl = big ? 0.36 : 0.22;
    /* 每朵花的音高略有不同，不然一串烟花听着像复读 */
    var detune = 0.88 + Math.random() * 0.3;
    /* 色调微调音色：暖色偏低沉，冷色偏清脆 */
    var bright = 1;
    if (typeof toneIndex === 'number') {
      bright = toneIndex >= 3 && toneIndex <= 5 ? 0.82 : 1.12;
    }

    /* ① 低频推力：那一下「闷」的冲击 */
    var thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(185 * detune, now);
    thump.frequency.exponentialRampToValueAtTime(36 * detune, now + 0.26);
    var tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.exponentialRampToValueAtTime(lvl * 0.85, now + 0.012);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    thump.connect(tg); tg.connect(bus);
    thump.start(now); thump.stop(now + 0.5);

    /* ② 爆裂：宽频噪声，带通从高扫到低 —— 「炸开」的那层 */
    var src = ctx.createBufferSource();
    src.buffer = noise();
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600 * bright, now);
    lp.frequency.exponentialRampToValueAtTime(320, now + 0.5);
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(lvl * 0.7, now + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + (big ? 0.72 : 0.5));
    src.connect(lp); lp.connect(ng); ng.connect(bus);
    src.start(now); src.stop(now + 0.8);

    /* 远处回声：真实烟花炸完，隔两三百毫秒会从楼宇/山谷里弹一下回来。
       就这一下，让声音一下子「有空间感」，不再是耳边的干响。 */
    var dly = ctx.createDelay(1.0);
    dly.delayTime.value = 0.24 + Math.random() * 0.14;
    var dg = ctx.createGain();
    dg.gain.value = big ? 0.20 : 0.12;
    ng.connect(dly); dly.connect(dg); dg.connect(bus);

    /* ③ 噼啪余响：大烟花才有，一团细碎的火星光 */
    if (big) {
      var cr = ctx.createBufferSource();
      cr.buffer = noise();
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400;
      var cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now + 0.16);
      cg.gain.exponentialRampToValueAtTime(lvl * 0.26, now + 0.3);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + 1.7);
      cr.connect(hp); hp.connect(cg); cg.connect(bus);
      cr.start(now); cg.gain.setValueAtTime(0.0001, now);
      cr.stop(now + 1.8);
    }
  }

  /* 只解锁音频（建上下文 + resume），不排音乐。
     开场点击时调用：这样即使用户关掉了背景音乐，烟花音效也还能响。 */
  function arm() {
    if (!build()) return false;
    if (ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) {}
    }
    started = true;
    return true;
  }

  /* ---------- 对外 API ---------- */
  function start() {
    userMuted = false;
    /* 必须在用户手势里调用，否则 iOS / Chrome 会拒绝出声 */
    if (!build()) return false;
    if (ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) {}
    }
    if (playing) return true;
    playing = true;
    started = true;
    stopTimers();
    killAll();                 /* 兜底：把可能残留的上一轮音符真正停掉，避免叠音 */
    fadeTo(VOL, 1.8);
    nextAt = ctx.currentTime + 0.25;
    tick();
    lookTimer = setInterval(tick, 1500);
    writePref(true);
    emit();
    return true;
  }

  /* byUser=false 时只停声音、不改偏好（切后台走这条） */
  function pause(byUser) {
    if (byUser) userMuted = true;
    if (!playing) { if (byUser) { writePref(false); emit(); } return; }
    playing = false;
    stopTimers();
    fadeTo(0, 0.7);
    /* 淡出之后把音符真正停掉 —— 否则再点播放会「新的一轮 + 旧的残余」叠着响 */
    setTimeout(killAll, 780);
    if (byUser) writePref(false);
    emit();
  }

  function toggle() {
    if (playing) { pause(true); return false; }
    return start();
  }

  function writePref(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
  }

  /* 判断「这是编辑器/工具的内置预览，不是用户真的打开了网页」。
     这种情况默认不出声 —— 预览往往是自动弹出来的，一进来就循环放歌太吵。
     右上角那个喇叭按钮仍然可以手动打开，所以不会把人挡在外面。

     ⚠️ 只判断 window.top 是不够的：WorkBuddy / 各类编辑器的内置预览是
        **Electron 的 webview**，页面在里面本身就是顶层窗口，`self === top` 成立，
        于是照样自动播放（本轮就是这么吵到人的）。所以再补一条 UA 判断。 */
  function inEmbed() {
    try { if (window.self !== window.top) return true; } catch (e) { return true; }
    if (/Electron|WorkBuddy/i.test(navigator.userAgent || '')) return true;
    return false;
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
    onChange: onChange,
    /* arm: 只解锁音频不出声；boom/whoosh: 烟花音效 */
    arm: arm,
    boom: boom,
    whoosh: whoosh
  };

  /* 读一次用户偏好：显式关过 -> userMuted */
  userMuted = !readPref();

  /* 切到别的 App / 锁屏时自动停，回来不自动响（礼貌一些） */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pause(false);
  });
})();
