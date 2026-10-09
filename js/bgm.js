/* =========================================================
   声音引擎：Web Audio API 现场合成
   ---------------------------------------------------------
   两个部分：
     1. 背景音乐 —— 八音盒版的《生日快乐》，**六声部编配**（听感要「重奏」不要「单音」）：
          ① 主旋律   八音盒音色，唯一的主角，音符之间要留缝
          ② 高八度    跟着旋律走的高八度加厚层（音乐盒的「双层梳齿」），清亮、很轻
          ③ 和声      只给 ≥2 拍的长音，**双音**（三度 + 五度），严格取和弦音
          ④ 低音      每个和弦换一次，低八度长音，只当地基
          ⑤ 竖琴滑音  每轮开头的上行刮奏（引子），像音乐盒上弦
          ⑥ 风铃      长音后段点一颗高音铃铛，制造「星光一闪」的瞬间
        —— 旧版只有 ①③④，听感单薄；②⑤⑥ 就是「多声部 + 多几种音色」。

     ⚠️ 「音乐乱」踩过的四个坑，别再犯：
       · 时值乘大系数（曾经 1.9 / 1.5）→ 音符互相叠，再叠上混响就糊成一团。
         现在只多给 5%，颗粒感全靠「音与音之间那道缝」。
       · 挂 DynamicsCompressor → 八音盒的瞬态被「压一下松一下」，
         整首曲子呼哧呼哧地起伏，非常像「乱」。峰值靠音量标定控制，不要用压缩器。
       · 用递归 setTimeout 排下一轮 → 页面一卡（放烟花时动辄几百毫秒）就晚触发，
         下一轮起点成了过去时刻，整轮音符被一次性倾泻出来 = 抢拍糊成一团。
         现在是**前瞻调度**：维护绝对时间轴，定期检查「未来 6 秒内排满了没有」。
       · **往中音区塞密集的琶音 / 弦垫** → 和主旋律抢音域，立刻发浑。
         所以新增声部一律**错开音区**：高八度走上面、和声走下面、滑音只做引子。
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
  var VOL = 0.38;           /* 音乐总增益（声部变多了，收一点给峰值留余量） */
  var MEL_VOL = 0.28;       /* ① 主旋律 —— 主角 */
  var MEL2_VOL = 0.085;     /* ② 高八度加厚 —— 约为主旋律的三成 */
  var HARM_VOL = 0.055;     /* ③ 和声（每个音） */
  var BASS_VOL = 0.055;     /* ④ 低音 —— 只当地基 */
  var GLISS_VOL = 0.042;    /* ⑤ 竖琴滑音 —— 引子，极轻 */
  var CHIME_VOL = 0.032;    /* ⑥ 风铃 —— 点一下就走 */
  var LEAD = 0.46;          /* 每轮开头的引子（竖琴刮奏）时长 */
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

  /* ---------- ② 高八度加厚：比 bell 更「清亮」，泛音少而高 ----------
     音乐盒里有「双层梳齿」，同一个音会带一层高八度。这一层就是它：
     只两个泛音、衰减更快，听起来是「叮」的一声亮点，而不是又一条旋律。 */
  function bell2(freq, at, dur, vol) {
    var partials = [[1, 1.00, 1.00], [2.00, 0.20, 0.46]];
    for (var i = 0; i < partials.length; i++) {
      var p = partials[i];
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p[0];
      var g = ctx.createGain();
      var end = at + Math.max(dur * p[2], 0.06);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(vol * p[1], 0.0002), at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g); g.connect(musicGain);
      osc.start(at); osc.stop(end + 0.04);
      track(osc);
    }
  }

  /* ---------- ⑥ 风铃：高音铃铛 ----------
     泛音取「非整数比」（2.76 / 5.40）—— 这是钟、铃、玻璃的特征音程，
     整数比会听成乐音（就变成又一条旋律了）。很短、很轻，一颗就够。 */
  function chime(freq, at, vol) {
    var partials = [[1, 1.00, 1.00], [2.76, 0.26, 0.55], [5.40, 0.08, 0.30]];
    for (var i = 0; i < partials.length; i++) {
      var p = partials[i];
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p[0];
      var g = ctx.createGain();
      var end = at + 0.85 * p[2];
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(vol * p[1], 0.0002), at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g); g.connect(musicGain);
      osc.start(at); osc.stop(end + 0.05);
      track(osc);
    }
  }

  /* ---------- ⑤ 竖琴滑音：一串极短的八音盒音，从低到高（或从高到低）扫过 ----------
     只放在每轮的**开头**当引子 —— 那一段主旋律还没进来，不会抢音域。
     越往后稍微响一点，像刮奏收尾那一下「提」起来。 */
  function gliss(fromMidi, toMidi, at, step, vol) {
    var dir = toMidi >= fromMidi ? 1 : -1;
    var n = Math.floor(Math.abs(toMidi - fromMidi) / step);
    var gap = LEAD / Math.max(n, 1);
    for (var i = 0; i <= n; i++) {
      var m = fromMidi + dir * i * step;
      bell(freqOf(nameOf(m)), at + i * gap, 0.5, vol * (0.7 + 0.6 * i / Math.max(n, 1)));
    }
  }

  /* 大三和弦的音（本项目用到的和弦都是大三和弦） */
  function triad(rootName) {
    var r = midiOf(rootName);
    return [nameOf(r), nameOf(r + 4), nameOf(r + 7)];
  }

  /* 给旋律音配「下方最近的两个和弦音」（三度 + 五度）。
     ⚠️ 找不到就少配一个（宁可只有一层，也不许塞不对的音）。
        旧版曾经在找不到时兜底成「旋律下方 5 个半音」，那是纯拍脑袋 ——
        经常落在一个既不属于和弦、也不属于调内的音上，一听就「跑调 / 发乱」。
        宁可少一层和声，也不能塞一个不对的音。
     ⚠️ 两个音不能是同一个音名（那样只是加厚，不是和声）—— 遇到就跳到下一个候选。 */
  function harmonySet(melodyName, chordRoot) {
    var m = midiOf(melodyName);
    var tones = triad(chordRoot);
    var cands = [];
    for (var i = 0; i < tones.length; i++) {
      var c = midiOf(tones[i]);
      /* 每个和弦音各往下试两个八度，只保留「比旋律低 3~16 个半音」的 */
      for (var k = 0; k <= 2; k++) {
        var cand = c - k * 12;
        var d = m - cand;
        if (d < 3 || d > 16) continue;
        if (cands.indexOf(cand) < 0) cands.push(cand);
      }
    }
    cands.sort(function (a, b) { return b - a; });   /* 从高到低：先取贴近旋律的 */
    var out = [];
    for (var j = 0; j < cands.length && out.length < 2; j++) {
      var nm = nameOf(cands[j]).replace(/-?\d+$/, '');
      var dup = false;
      for (var q = 0; q < out.length; q++) {
        if (nameOf(out[q]).replace(/-?\d+$/, '') === nm) { dup = true; break; }
      }
      if (!dup) out.push(cands[j]);
    }
    return out;
  }

  /* ---------- 排一轮：六声部编配。起点 from 由调度器给定（一定是未来时刻）----------
     ⚠️ 音的长度**不要乘大系数**：八音盒的颗粒感来自「音符之间有缝」。
        旧版把时值乘 1.9（和声 1.5），一个音还没落下一个就压上来，
        再叠上长混响，听感就是糊成一团「乱」。现在只多给 5%。 */
  function scheduleCycle(from) {
    /* 先算出每个旋律音的起始时刻，所有声部都对齐这条时间轴。
       前面空出的 LEAD 是留给竖琴滑音引子的。 */
    var times = [from + LEAD];
    for (var i = 0; i < SONG.length; i++) times.push(times[i] + SONG[i][1] * BEAT);

    /* ⑤ 引子：竖琴上行刮奏（C4 → C6，全音阶）。
          放在最前面 —— 那会儿主旋律还没进来，抢不到音域；
          「上弦 → 开奏」也格外有仪式感。 */
    gliss(60, 84, from, 3, GLISS_VOL);

    /* ① 主旋律 + ② 高八度加厚 + ⑥ 风铃点缀 */
    for (var m = 0; m < SONG.length; m++) {
      var f = freqOf(SONG[m][0]);
      var beats = SONG[m][1];
      var dur = beats * BEAT;
      /* ① 主角，颗粒分明 */
      bell(f, times[m], dur * 1.05, MEL_VOL);
      /* ② 高八度：跟着旋律加厚，音量只有主旋律的三成 ——
            这就是音乐盒「双层梳齿」的做法，听感立刻从「单音」变「合奏」。 */
      bell2(f * 2, times[m], dur * 0.85, MEL2_VOL);
      /* ⑥ 风铃：只在 2 拍以上的长音上，在音的后段点一颗高音铃铛 */
      if (beats >= 2) chime(f * 2, times[m] + dur * 0.55, CHIME_VOL);
    }

    /* ③ 和声 —— 只给「2 拍及以上」的长音，而且给**双音**（三度 + 五度）。
          给 1 拍的音也配的话，和声就和旋律一样密，两个声部在同一个音区抢，
          听感立刻发浑；只留给长音，它才起得到「托一下」的作用。 */
    for (var h = 0; h < SONG.length; h++) {
      if (SONG[h][1] < 2) continue;
      var hs = harmonySet(SONG[h][0], CHORDS[h]);
      for (var k = 0; k < hs.length; k++) {
        soft(freqOf(nameOf(hs[k])), times[h], SONG[h][1] * BEAT * 0.9, HARM_VOL);
      }
    }

    /* ④ 低音 —— 每个和弦段一个长音，收在段内，绝不拖进下一个和弦 */
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
    return t + TAIL + LEAD;      /* ⚠️ 别忘了 LEAD（引子），否则下一轮会提前挤进来 */
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

  /* ---------- 烟花爆炸 ----------
     ⚠️ 「像打铁板」的教训（2026-10-09）：
       旧版用**正弦从 185Hz 滑到 36Hz** 做低频层。正弦是**有音高**的，
       2.4 个八度的滑音听上去就是「哐 ——」一声**敲金属板**。
       真实的爆炸**完全没有音高**，它是宽带噪声：
         ① 极短的起爆冲击（几毫秒内起，能量压在 100Hz 以下）= 「胸口一震」
         ② 中低频轰鸣（100~500Hz）缓慢衰减 = 「轰」的肉
         ③ 一点点高频碎裂声，**音量压到主体的三成以下**，多一分就是金属味
         ④ 几十 Hz 的长尾滚动 = 大烟花和小烟花的区别所在
         ⑤ 空间回声，而且**只把低频弹回来**（远处传来的声音本来就听不到高频）
         ⑥ 「噼里啪啦」要的是**一颗颗随机的小脉冲**，不是一片持续的「嘶——」
       所以整条链路**一个正弦振荡器都没有**，全部是噪声 + 滤波。
       峰值标定要和音乐合计不越过 1.0。 */
  function boom(big, toneIndex) {
    if (userMuted || !ctx) return;
    var now = ctx.currentTime;
    /* 同一时刻炸太多会糊成一片噪音，做个节流 + 并发上限 */
    if (now - lastBoom < 0.06 || boomLive >= 6) return;
    lastBoom = now;
    boomLive++;
    setTimeout(function () { boomLive--; }, 1500);

    var lvl = big ? 0.34 : 0.20;
    /* 每朵花的音色略有不同，不然一串烟花听着像复读 */
    var detune = 0.88 + Math.random() * 0.26;
    /* 色调：暖色（前几个）更闷更沉、尾巴更长；冷色更清亮干脆 */
    var warm = !(typeof toneIndex === 'number') || toneIndex <= 2;
    var tail = (big ? 1 : 0.62) * (warm ? 1.15 : 0.85);

    /* 一层「噪声 + 滤波 + 包络」。整条链路只有噪声，没有振荡器 → 天然无音高。 */
    function layer(type, f0, f1, q, peak, atk, dec) {
      var src = ctx.createBufferSource();
      src.buffer = noise();
      src.playbackRate.value = detune;      /* 每朵花的颗粒感都不一样 */
      var flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.Q.value = q;
      flt.frequency.setValueAtTime(f0, now);
      if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, now + dec);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), now + Math.max(atk, 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, now + dec);
      src.connect(flt); flt.connect(g);
      src.start(now); src.stop(now + dec + 0.08);
      return g;
    }

    /* ① 起爆冲击 —— 无音高的超低频，4ms 起、0.34s 落。「胸口一震」就是它 */
    layer('lowpass', 130 * detune, 62 * detune, 0.7,
          lvl * 0.95, 0.004, 0.34 * tail + 0.16).connect(bus);

    /* ② 轰鸣主体 —— 中低频宽带，缓慢衰减，这是「轰」的肉。
          低通从 1100Hz 收到 260Hz，模拟爆燃迅速转为低频轰响。 */
    var body = layer('lowpass', 1100 * detune, 260 * detune, 0.6,
                     lvl * 0.78, 0.016, 0.62 * tail + 0.3);
    body.connect(bus);

    /* ③ 爆裂细节 —— 极短极轻的高频「啪」。这是唯一带高频的一层，
          音量压到主体的三成以下，多一分就变回金属板。 */
    layer('bandpass', 1500 * detune, 620 * detune, 1.1,
          lvl * 0.26, 0.005, 0.17).connect(bus);

    /* ④ 尾音滚动 —— 几十 Hz 的长尾，沉下去的那口气。
          大烟花 1.8~2.3s，小烟花 0.8s 上下。 */
    layer('lowpass', 62 * detune, 48 * detune, 0.9,
          lvl * 0.5 * (big ? 1 : 0.6), 0.05,
          (big ? 1.9 : 0.85) * (warm ? 1.2 : 0.8)).connect(bus);

    /* ⑤ 空间回声 —— 只把低频弹回来（远处传来的声音本来就没有高频），
          再反馈一次，就是「楼宇之间回荡」的那种厚度。 */
    var dly = ctx.createDelay(1.2);
    dly.delayTime.value = 0.3 + Math.random() * 0.18;
    var ef = ctx.createBiquadFilter();
    ef.type = 'lowpass';
    ef.frequency.value = 520;
    var dg = ctx.createGain();
    dg.gain.value = big ? 0.26 : 0.16;
    var fb = ctx.createGain();
    fb.gain.value = 0.22;
    body.connect(dly); dly.connect(ef); ef.connect(dg); dg.connect(bus);
    ef.connect(fb); fb.connect(dly);

    /* ⑥ 噼啪余烬（大烟花）—— 一颗颗随机的小脉冲，不是一片持续的「嘶——」。
          在一段噪声上点一串 gain 自动化，听感就是火星光在头顶依次熄灭。 */
    if (big) {
      var cr = ctx.createBufferSource();
      cr.buffer = noise();
      var hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 3000 + Math.random() * 900;
      hp.Q.value = 1.3;
      var cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      var pops = 10 + Math.floor(Math.random() * 6);
      var span = 1.5 * (warm ? 1.2 : 0.9);
      for (var i = 0; i < pops; i++) {
        var t = now + 0.2 + Math.random() * span;
        var amp = lvl * (0.05 + Math.random() * 0.14);
        cg.gain.setValueAtTime(0.0001, t);
        cg.gain.exponentialRampToValueAtTime(amp, t + 0.006);
        cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + Math.random() * 0.05);
      }
      cr.connect(hp); hp.connect(cg); cg.connect(bus);
      cr.start(now); cr.stop(now + span + 0.4);
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
