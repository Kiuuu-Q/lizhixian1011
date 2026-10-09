/* =========================================================
   李芷贤 · 生日礼物页 (lizhixian1011)
   交互脚本：背景星光 / 艺术字 / 3D 蛋糕 / 回忆放映机 / 便签墙
   ========================================================= */
(function () {
  'use strict';

  /* 重载后别让浏览器把我们丢回上次的滚动位置 */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  /* ---------------- 小工具 ---------------- */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const rad = d => (d * Math.PI) / 180;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (e) { return false; }
    }
  };

  /* ---------------- Toast ---------------- */
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  /* =========================================================
     0. 全屏烟花引擎
     ---------------------------------------------------------
     做法参考业界成熟实现（fireworks-js 的参数模型 + Canvas 粒子优化惯例）：
       · 光晕**不用 shadowBlur** —— 每颗粒子设一次会直接把帧率打下来。
         改成「预渲染一张径向渐变光点贴图 + drawImage + lighter 加法混合」，
         重叠处会自然过曝成白，光晕质感反而更真。
       · 拖尾不存历史点，每帧用 destination-out 擦一层半透明，
         让画布自己当尾迹缓存（省内存，粒子翻倍也不怕）。
       · 粒子走对象池，避免频繁 new / GC 造成卡顿尖峰。
       · 位置按 deltaTime 积分，60Hz / 120Hz 屏表现一致。
       · 有粒子上限，掉帧时自动降档。
     ========================================================= */
  const fw = $('#fwCanvas');
  const fwx = fw ? fw.getContext('2d') : null;
  const FW_SHOW = 5000;      // 发射阶段
  const FW_FADE = 1500;      // 之后的淡出时间
  const FW_TAU = Math.PI * 2;

  /* 色板：全部取自页面自己那套浅蓝紫（紫/蓝为主，粉·薄荷·暖金只做点缀），
     每项 = [亮芯, 主色]，会烘成一张光点贴图 */
  const FW_TONES = [
    ['#ece6ff', '#8b7bf6'],   // 紫（主）
    ['#e4efff', '#79a4ff'],   // 蓝（主）
    ['#f1ecff', '#a99cff'],   // 浅紫（主）
    ['#ffe9f3', '#ffb3d3'],   // 粉（点）
    ['#e7fff6', '#93e6d0'],   // 薄荷（点）
    ['#fff8e6', '#ffd36e']    // 暖金（点）
  ];
  /* 六成以上走紫蓝系，画面才不会花 */
  function fwPickTone() {
    return Math.random() < 0.66 ? ((Math.random() * 3) | 0) : (3 + ((Math.random() * 3) | 0));
  }

  /* 照搬真实烟花的型号体系：牡丹 / 菊花 / 柳 / 环 / 花心 / 十字
     每个型号的「脾气」都不一样，编排在一起才有层次，不会每朵都一样。
       n    每次炸开的粒子数
       ring 是否沿圆周均匀铺开
       life 寿命区间（越小活得越久）
       r    体积区间
       gl   有多少比例的粒子会频闪
       g    重力倍数（柳枝垂得快就是因为这个大）
       gold 强制走暖金色调 */
  const FW_KINDS = ['peony', 'chrysanthemum', 'willow', 'ring', 'pistil', 'crossette'];
  const FW_SPEC = {
    peony:         { n: [40, 58], ring: 0, life: [0.0048, 0.0090], r: [5, 10],    gl: 0.16, g: 1.0 },
    chrysanthemum: { n: [52, 76], ring: 0, life: [0.0026, 0.0052], r: [4.5, 8.5], gl: 0.42, g: 1.0 },
    willow:        { n: [32, 48], ring: 0, life: [0.0016, 0.0033], r: [4, 7.5],   gl: 0.30, g: 1.7, gold: 1 },
    ring:          { n: [40, 56], ring: 1, life: [0.0038, 0.0070], r: [4.5, 8],   gl: 0.20, g: 0.45 },
    pistil:        { n: [40, 56], ring: 0, life: [0.0032, 0.0060], r: [4.5, 8.5], gl: 0.30, g: 1.0 },
    crossette:     { n: [26, 38], ring: 1, life: [0.0032, 0.0054], r: [5, 9],     gl: 0,    g: 0.55 }
  };

  /* 爆炸的一瞬，给整屏染一下这朵烟花的颜色 —— 就像真的把夜空照亮了一下。
     走 CSS 变量 + 极短过渡，不占 canvas 的性能。 */
  let fwLastFlash = 0;
  function fwFlash(tone) {
    const now = performance.now();
    if (now - fwLastFlash < 300) return;
    const v = $('#fireVeil');
    if (!v || !v.classList.contains('on')) return;
    fwLastFlash = now;
    v.style.setProperty('--flash', FW_TONES[tone][1]);
    v.classList.remove('flash');
    void v.offsetWidth;          /* 强制重排，动画才会每次都从头放 */
    v.classList.add('flash');
    setTimeout(() => v.classList.remove('flash'), 200);
  }

  let fwSprites = [];        // 预渲染的光点贴图（按色板顺序）
  let fwOn = false, fwW = 0, fwH = 0, fwDpr = 1;
  let fwStart = 0, fwNextAt = 0, fwStopAt = 0, fwLast = 0;
  let fwRockets = [], fwParts = [], fwPool = [];
  let fwFadeT = null, fwGoneT = null;
  let fwBudget = 1600;       // 同时在场粒子上限，掉帧时自动往下调
  let fwSlow = 0;

  /* 把「亮芯 → 主色 → 透明」烘成一张 64px 贴图，之后只 drawImage */
  function fwMakeSprite(inner, outer) {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0,    'rgba(255,255,255,1)');
    g.addColorStop(0.14, inner);
    g.addColorStop(0.40, outer);
    g.addColorStop(1,    'rgba(0,0,0,0)');   // lighter 下黑色不贡献亮度，等于透明
    x.fillStyle = g;
    x.beginPath();
    x.arc(S / 2, S / 2, S / 2, 0, FW_TAU);
    x.fill();
    return c;
  }

  function fwBuildSprites() {
    if (fwSprites.length) return;
    for (let i = 0; i < FW_TONES.length; i++) {
      fwSprites.push(fwMakeSprite(FW_TONES[i][0], FW_TONES[i][1]));
    }
  }

  function fwResize() {
    if (!fw || !fwx) return;
    /* 烟花是发光粒子，不需要极致清晰 —— 这里选「流畅」而不是「清晰」 */
    fwDpr = Math.min(window.devicePixelRatio || 1, PERF.mobile ? 1 : (PERF.low ? 1.25 : 1.5));
    fwW = window.innerWidth;
    fwH = window.innerHeight;
    fw.width = Math.round(fwW * fwDpr);
    fw.height = Math.round(fwH * fwDpr);
    fw.style.width = fwW + 'px';
    fw.style.height = fwH + 'px';
    fwx.setTransform(fwDpr, 0, 0, fwDpr, 0, 0);
  }

  /* 从粒子池里取一个，池空就新建 */
  function fwTake() {
    const p = fwPool.pop();
    return p || {};
  }
  function fwGive(p) {
    if (fwPool.length < 2200) fwPool.push(p);
  }

  /* 发射一枚：从屏幕下方升起，到接近顶点才炸 */
  function fwLaunch(big) {
    const kind = FW_KINDS[(Math.random() * FW_KINDS.length) | 0];
    const tone = FW_SPEC[kind].gold ? 5 : fwPickTone();   /* 柳枝固定走金色 */
    const x = rnd(fwW * 0.1, fwW * 0.9);
    const vy = -rnd(9.2, 13.2);
    const rise = Math.max(20, Math.round(rnd(fwH * 0.52, fwH * 0.86) / -vy));
    fwRockets.push({
      x: x, y: fwH + 10, vx: rnd(-1.1, 1.1), vy: vy,
      rise: rise, t: 0, tone: tone, kind: kind,
      big: big === undefined ? Math.random() < 0.3 : big
    });
    /* 升空的「咻」：rise 是帧数（60fps 计），除 60 得到秒 —— 音画才对得上。
       弱机就不放了，省一点算力，爆裂声还在。 */
    if (!PERF.low) fwSoundWhoosh(rise / 60);
  }

  /* 音效包装：声音引擎是独立文件，判一下存在再用，缺了也不影响烟花 */
  function fwSoundWhoosh(sec) {
    if (window.LZX_BGM && window.LZX_BGM.whoosh) window.LZX_BGM.whoosh(sec);
  }
  function fwSoundBoom(tone, big) {
    if (window.LZX_BGM && window.LZX_BGM.boom) window.LZX_BGM.boom(!!big, tone);
  }

  /* 炸开：按型号生成。粒子少而精，靠速度和寿命把范围铺开 */
  function fwBurst(x, y, tone, big, kind) {
    /* 和视觉爆炸同一帧触发，声音才「贴在」爆炸上 */
    fwSoundBoom(tone, big);
    kind = kind || FW_KINDS[(Math.random() * FW_KINDS.length) | 0];
    const spec = FW_SPEC[kind] || FW_SPEC.peony;
    const sprite = fwSprites[tone] || fwSprites[0];
    const scale = PERF.low ? 0.7 : 1;
    const n = Math.max(12, Math.round(rnd(spec.n[0], spec.n[1]) * scale));
    const power = rnd(4.8, 7.8) * (big ? 1.45 : 1) * (fwW < 640 ? 0.84 : 1);
    /* 花心：内圈换一个色调、速度慢一档，套出一朵小的 */
    const innerSprite = kind === 'pistil' ? fwSprites[(tone + 3) % FW_TONES.length] : null;

    for (let i = 0; i < n; i++) {
      if (fwParts.length >= fwBudget) break;
      const useInner = innerSprite && i % 5 === 0;
      const ang = spec.ring ? (i / n) * FW_TAU + rnd(-0.04, 0.04) : rnd(0, FW_TAU);
      let sp = spec.ring ? power * rnd(0.95, 1.05)
                         : power * Math.pow(Math.random(), 0.5);
      if (useInner) sp *= 0.45;

      const p = fwTake();
      p.x = x; p.y = y;
      /* 一律正圆：x / y 方向用同一个速度，屏幕上就是个规规矩矩的圆。
         之前环型把 vx 乘了个 ~0.68 的系数压成椭圆，看上去像「竖着的鸡蛋」，已去掉。 */
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.life = 1;
      p.decay = rnd(spec.life[0], spec.life[1]) / (big ? 1.25 : 1);
      p.r = rnd(spec.r[0], spec.r[1]) * (big ? 1.3 : 1);
      p.s = useInner ? innerSprite : sprite;
      p.tw = rnd(0, 6.283);
      p.gm = spec.g;
      p.gl = Math.random() < spec.gl ? rnd(0.024, 0.05) : 0;
      /* 十字：飞到一半再炸成四个小十字 */
      p.split = (kind === 'crossette' && Math.random() < 0.6) ? rnd(0.42, 0.62) : 0;
      fwParts.push(p);
    }
    if (big) fwFlash(tone);
    /* 炸点只留一层很淡的柔光，不做刺眼的白团 —— 过曝会显土 */
    const c = fwTake();
    c.x = x; c.y = y; c.vx = 0; c.vy = 0;
    c.life = 0.5; c.decay = 0.16; c.r = big ? 62 : 46;
    c.s = sprite; c.tw = 0;
    fwParts.push(c);

    /* 大烟花再引出一朵小的，节奏才有起伏 */
    if (big && !PERF.low) {
      const ang = rnd(0, FW_TAU), dist = rnd(80, 165);
      const sx = clamp(x + Math.cos(ang) * dist, 40, fwW - 40);
      const sy = clamp(y + Math.sin(ang) * dist * 0.55, 40, fwH - 60);
      setTimeout(() => {
        if (fwOn) fwBurst(sx, sy, fwPickTone(), false);
      }, Math.round(rnd(180, 420)));
    }
  }

  function fwDraw(now) {
    if (!fwx) return;

    /* 帧间隔换算成「以 60fps 为 1」的倍率，快慢一致 */
    const dt = clamp((now - fwLast) / 16.667, 0.25, 3.2);
    fwLast = now;

    /* 掉帧就慢慢削粒子预算，别硬撑 */
    if (dt > 1.75) {
      fwSlow++;
      if (fwSlow > 20) { fwBudget = Math.max(420, fwBudget - 260); fwSlow = 0; }
    } else if (fwSlow > 0) fwSlow--;

    /* 拖尾：擦掉一层，而不是整块清空 —— 旧的粒子自然淡出成尾迹 */
    fwx.globalCompositeOperation = 'destination-out';
    fwx.globalAlpha = 1;
    /* 擦得越轻，光丝拖得越长 —— 这是「缎带感」的来源 */
    fwx.fillStyle = 'rgba(0,0,0,' + (0.085 + 0.05 * (1 - Math.min(1, dt))) + ')';
    fwx.fillRect(0, 0, fwW, fwH);

    /* 加法混合：重叠的粒子亮度相加，中心自然过曝成白 —— 不用 shadowBlur */
    fwx.globalCompositeOperation = 'lighter';

    if (now < fwStopAt && now >= fwNextAt) {
      fwLaunch();
      if (Math.random() < 0.26) fwLaunch();
      fwNextAt = now + rnd(430, 900);
    }

    const fric = 1 - 0.026 * dt;     // 摩擦（按 dt 补偿）
    const grav = 0.070 * dt;         // 重力稍大：光丝会像柳枝一样垂下来

    /* --- 上升的火箭 --- */
    for (let i = fwRockets.length - 1; i >= 0; i--) {
      const r = fwRockets[i];
      r.t += dt;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.vy += grav;
      const s = fwSprites[r.tone] || fwSprites[0];
      fwx.globalAlpha = 0.72;
      const rr = 8;
      fwx.drawImage(s, r.x - rr, r.y - rr, rr * 2, rr * 2);
      if (r.vy >= 0 || r.t >= r.rise) {
        fwBurst(r.x, r.y, r.tone, r.big, r.kind);
        fwRockets.splice(i, 1);
      }
    }

    /* --- 炸开的粒子 --- */
    for (let i = fwParts.length - 1; i >= 0; i--) {
      const p = fwParts[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= fric;
      p.vy = p.vy * fric + grav * (p.gm || 1);
      p.life -= p.decay * dt;
      if (p.life <= 0) {
        fwGive(p);
        fwParts.splice(i, 1);
        continue;
      }

      /* 十字型号：飞到一半就地再炸成四个小十字 */
      if (p.split && p.life <= p.split) {
        p.split = 0;
        const base = Math.atan2(p.vy, p.vx);
        const sp0 = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 0.6;
        for (let k = 0; k < 4; k++) {
          if (fwParts.length >= fwBudget) break;
          const q = fwTake();
          const aa = base + k * 1.5708 + rnd(-0.25, 0.25);
          q.x = p.x; q.y = p.y;
          q.vx = Math.cos(aa) * sp0;
          q.vy = Math.sin(aa) * sp0;
          q.life = 0.6;
          q.decay = p.decay * 1.5;
          q.r = p.r * 0.7;
          q.s = p.s; q.tw = rnd(0, 6.283);
          q.gm = 1; q.gl = 0; q.split = 0;
          fwParts.push(q);
        }
      }

      /* 微微呼吸；频闪的粒子快速爆闪，像真的火星在跳 */
      let a = p.life * (0.50 + 0.32 * Math.sin(p.tw + now * 0.010));
      if (p.gl) a *= 0.52 + 0.48 * Math.max(0, Math.sin(now * p.gl + p.tw));
      fwx.globalAlpha = a < 0 ? 0 : a;
      const rad = p.r * (0.26 + p.life * 0.74);
      fwx.drawImage(p.s, p.x - rad, p.y - rad, rad * 2, rad * 2);
    }

    fwx.globalAlpha = 1;
    fwx.globalCompositeOperation = 'source-over';
  }

  /* 放烟花：show 毫秒在发，随后 fade 毫秒淡掉。由开始页按钮触发 */
  function playFireworks(show, fade) {
    if (!fw || !fwx) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fw.classList.add('gone');
      return;
    }
    show = show || FW_SHOW;
    fade = (fade === undefined) ? FW_FADE : fade;

    clearTimeout(fwFadeT);
    clearTimeout(fwGoneT);
    fw.classList.remove('gone');
    fw.classList.remove('fading');

    fwBuildSprites();
    fwResize();
    fwBudget = PERF.mobile ? 320 : (PERF.low ? 620 : 1000);
    fwSlow = 0;

    fwOn = true;
    fwStart = performance.now();
    fwLast = fwStart;
    fwNextAt = fwStart;
    fwStopAt = fwStart + show;
    fwRockets.length = 0;
    /* 池子里的对象交还给池，别直接丢弃 */
    for (let i = 0; i < fwParts.length; i++) fwGive(fwParts[i]);
    fwParts.length = 0;
    if (fwx) fwx.clearRect(0, 0, fwW, fwH);

    /* 开场先补两朵，第一秒不空，但也别一上来就糊满 */
    fwLaunch(true);
    fwLaunch();

    fwFadeT = setTimeout(() => { fw.classList.add('fading'); }, show);
    fwGoneT = setTimeout(() => {
      fwOn = false;
      fw.classList.add('gone');
      for (let i = 0; i < fwParts.length; i++) fwGive(fwParts[i]);
      fwRockets.length = 0;
      fwParts.length = 0;
      if (fwx) { fwx.globalAlpha = 1; fwx.clearRect(0, 0, fwW, fwH); }
    }, show + fade);
  }

  /* =========================================================
     1. 背景星光
     ========================================================= */
  /* ---------- 设备能力：弱机自动降档，别让人卡着看 ---------- */
  const PERF = (function () {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 640;
    const mobile = coarse || narrow;
    const low = mobile || cores <= 4 || mem <= 2;
    return {
      mobile: mobile,
      low: low,
      dprCap: mobile ? 1 : (low ? 1.5 : 2),      /* 低端机别按 3x 渲染，像素量差一倍多 */
      part: mobile ? 0.35 : (low ? 0.5 : 1),        /* 粒子数量系数 */
      glow: !low,                 /* 低端机关掉 shadowBlur，这玩意最费 */
      bgMs: mobile ? 80 : (low ? 55 : 32)         /* 背景星空的重绘间隔 */
    };
  })();
  if (PERF.low) document.documentElement.classList.add('perf-low');
  if (PERF.mobile) document.documentElement.classList.add('perf-mobile');
  const bg = $('#bgCanvas');
  const bctx = bg ? bg.getContext('2d') : null;
  let bgW = 0, bgH = 0, dots = [];

  function newDot() {
    return {
      x: Math.random() * bgW,
      y: Math.random() * bgH,
      r: rnd(0.8, 2.3),
      vx: rnd(-0.14, 0.14),
      vy: rnd(-0.24, -0.05),
      ph: Math.random() * Math.PI * 2,
      sp: rnd(0.5, 1.5),
      hue: rnd(225, 275)
    };
  }

  function bgResize() {
    if (!bg) return;
    const dpr = Math.min(window.devicePixelRatio || 1, PERF.dprCap);
    bgW = window.innerWidth;
    bgH = window.innerHeight;
    bg.width = Math.round(bgW * dpr);
    bg.height = Math.round(bgH * dpr);
    bg.style.width = bgW + 'px';
    bg.style.height = bgH + 'px';
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(clamp(Math.round(bgW / 24), 30, 88) * PERF.part);
    dots = [];
    for (let i = 0; i < n; i++) dots.push(newDot());
  }

  function bgDraw(t) {
    if (!bctx) return;
    bctx.clearRect(0, 0, bgW, bgH);
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < -12) { d.y = bgH + 12; d.x = Math.random() * bgW; }
      if (d.x < -12) d.x = bgW + 12;
      if (d.x > bgW + 12) d.x = -12;

      const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.0011 * d.sp + d.ph));
      bctx.beginPath();
      bctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      bctx.fillStyle = 'hsla(' + d.hue + ',90%,76%,' + (0.34 * tw).toFixed(3) + ')';
      bctx.fill();

      if (d.r > 1.85) {
        const len = d.r * 3.1;
        bctx.strokeStyle = 'hsla(' + d.hue + ',95%,84%,' + (0.22 * tw).toFixed(3) + ')';
        bctx.lineWidth = 0.9;
        bctx.beginPath();
        bctx.moveTo(d.x - len, d.y); bctx.lineTo(d.x + len, d.y);
        bctx.moveTo(d.x, d.y - len); bctx.lineTo(d.x, d.y + len);
        bctx.stroke();
      }
    }
  }

  /* =========================================================
     2. 艺术字标题
     ========================================================= */
  const TITLE = 'Happy Birthday';
  const PALETTE = [
    ['#a9bdff', '#7d8cf9'],
    ['#cbb0ff', '#977af2'],
    ['#ffc4de', '#ff8ebd'],
    ['#a9dcff', '#74b0ff'],
    ['#d6c0ff', '#a98cf6']
  ];
  const COLOR_MAP = [0, 1, 2, 3, 4, 0, 2, 1, 3, 4, 0, 2, 1];

  function buildTitle() {
    const holder = $('#titleArt');
    if (!holder) return;
    const frag = document.createDocumentFragment();
    let li = 0;
    TITLE.split(' ').forEach((word, wi) => {
      const wEl = document.createElement('span');
      wEl.className = 'word';
      for (let k = 0; k < word.length; k++) {
        const idx = li++;
        const sp = document.createElement('span');
        const c = PALETTE[COLOR_MAP[idx] === undefined ? idx % PALETTE.length : COLOR_MAP[idx]];
        sp.className = 'ltr';
        sp.textContent = word[k];
        sp.style.setProperty('--c1', c[0]);
        sp.style.setProperty('--c2', c[1]);
        sp.style.setProperty('--i', idx);
        sp.style.setProperty('--rot', rnd(-3.4, 3.4).toFixed(2) + 'deg');
        wEl.appendChild(sp);
      }
      frag.appendChild(wEl);
      if (wi < TITLE.split(' ').length - 1) li++; // 跳过空格位
    });
    holder.appendChild(frag);
  }

  /* =========================================================
     3. 3D 蛋糕
     ========================================================= */
  const stage    = $('#cakeStage');
  const spinEl   = $('#cakeSpin');
  const numEl    = $('#cakeNum');   /* 「19」的不旋转层 */
  const fxLayer  = $('#fxLayer');
  const lightBtn = $('#lightBtn');
  const lightNum = $('#lightCount');
  const lightTip = $('#lightTip');

  const LIFT = 108;      // 蛋糕整体上移，使视觉居中
  const SPEED = 9;       // 自动旋转速度 deg/s（约 40 秒一圈）
  const TILT = -9;       // 俯视角度（收小一点，蛋糕更「立」）

  let ry = 18;           // 当前旋转角
  let cakeScale = 1;
  let dragging = false, dragX = 0, dragRy = 0, resumeAt = 0;

  /* 许愿时蛋糕会「长大」一点：wishScale 平滑逼近目标值 */
  let wishScale = 1, wishScaleTo = 1;

  /* 坐标约定：原点 = 上层顶面中心，y 向下为正
     y 0..88  上层蛋糕体 / 88..184 下层蛋糕体 / 184..200 托盘 / y<0 蜡烛 */
  /* 分段数从 36/40/34 拉到 56/60/46 —— 边多=圆润，这是「不粗糙」的关键；
     同时整体放大一圈、加高，摆脱「扁」的观感。 */
  const TIERS = [
    { kind: 't2',    r: 96,  h: 98,  cy: 49,  n: 76, lo: 0.80, hi: 1.24, ao: 0 },
    { kind: 't1',    r: 150, h: 110, cy: 153, n: 84, lo: 0.80, hi: 1.24, ao: 18 },
    { kind: 'plate', r: 186, h: 18,  cy: 217, n: 64, lo: 0.78, hi: 1.18, ao: 12 }
  ];

  function svgURI(inner, w, h) {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + w + " " + h +
                "' preserveAspectRatio='none'>" + inner + "</svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  /* 顶部环境光遮蔽（被上一层压住的部分更暗） */
  function aoLayer(height) {
    if (!height) return '';
    return "<defs><linearGradient id='ao' x1='0' y1='0' x2='0' y2='1'>" +
           "<stop offset='0' stop-color='#8a7d6b' stop-opacity='.22'/>" +
           "<stop offset='.55' stop-color='#8a7d6b' stop-opacity='.07'/>" +
           "<stop offset='1' stop-color='#8a7d6b' stop-opacity='0'/>" +
           "</linearGradient></defs>" +
           "<rect width='100' height='" + height + "' fill='url(#ao)'/>";
  }

  /* 贴在每一片薄片上的「圆柱柔光 + 上下收边」。
     几十片各自带一点点明暗，拼起来就是一整个圆润的奶油柱 ——
     不再是棱角分明的一圈多边形，这是「角圆钝」的关键。 */
  /* 裱花底下的那圈柔影 */
  const SOFT_BLUR =
    "<filter id='sb' x='-25%' y='-25%' width='150%' height='150%'>" +
      "<feGaussianBlur stdDeviation='1.7'/>" +
    "</filter>";

  const CYL =
    "<defs>" + SOFT_BLUR +
      "<linearGradient id='vt' x1='0' y1='0' x2='0' y2='1'>" +
        "<stop offset='0' stop-color='#ffffff' stop-opacity='.55'/>" +
        "<stop offset='.16' stop-color='#ffffff' stop-opacity='0'/>" +
        "<stop offset='.82' stop-color='#8a7d6b' stop-opacity='0'/>" +
        "<stop offset='1' stop-color='#8a7d6b' stop-opacity='.14'/>" +
      "</linearGradient>" +
    "</defs>" +
    "<rect width='100' height='100' fill='url(#vt)'/>";
  /* ---- 奶油裱花边 ----
     重要：花边是「绕整圈」的一条连续波浪，而不是每片各画一个包。
     这里把这一片所占的那一段角度，切到整圈的波浪函数上采样，
     所以相邻薄片首尾相接，绕一圈看就是一条圆钝的裱花边，
     不会在片与片的接缝上出现折角。
       centerDeg / stepDeg : 这一片在整圈里的中心角与张角
       yCrest / yBottom    : 缝口处（最浅）与包底（最深）的纵向位置
       lobes               : 整圈一共几朵奶油花
     坐标是这片贴图的 100×100 局部坐标，纵向会被拉伸到真实层高。 */
  function creamWave(centerDeg, stepDeg, yCrest, yBottom, lobes) {
    const P = 360 / lobes;
    const N = 14;
    const pts = [];
    for (let k = N; k >= 0; k--) {
      const x = k * (100 / N);
      const deg = centerDeg + (x / 100 - 0.5) * stepDeg;
      let t = (((deg % P) + P) % P) / P;
      const sh = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);   // 0 → 1 → 0，光滑周期
      pts.push([x, yCrest + (yBottom - yCrest) * sh]);
    }
    const f = function (v) { return v.toFixed(2); };
    const fill = 'M0 0 H100 V' + f(pts[0][1]) +
                 pts.slice(1).map(function (p) { return ' L' + f(p[0]) + ' ' + f(p[1]); }).join('') +
                 ' Z';
    const line = 'M' + pts.slice().reverse()
                 .map(function (p) { return f(p[0]) + ' ' + f(p[1]); }).join(' L');
    return { fill: fill, line: line };
  }

  /* 顶面和侧面之间的那道圆角 —— 少了它，圆柱顶边就是一条硬生生的直角，
     这是「低模感」最大的来源。做法是贴一条「暗 → 亮 → 透明」的过渡带。 */
  /* 抹刀痕：侧面那层柔和的明暗光泽。
     ⚠️ 这里**必须是纯纵向**的渐变（x1 = x2 = 0）。
     以前它是斜的（x1=0,y1=0 → x2=1,y2=1）。问题是每片薄片都会把这段纹理
     在属于自己的 100×100 贴图里重画一遍 —— 于是横向的明暗在每一片里都
     「从头开始」，绕一圈下来就是一排锯齿：凑近看是密密麻麻的竖条纹，
     蛋糕转起来就是整片表面在闪（「蛋糕闪来闪去」的根源就在这一行）。
     改成纵向之后横向不再有任何结构，一圈下来天然连续，闪就没了。
     颜色仍是原来那几档奶白/暖白，只是把横向那一半去掉了。 */
  const SWIRL =
    "<defs><linearGradient id='sw' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#ece4d6' stop-opacity='.273'/>" +
      "<stop offset='.2' stop-color='#ffffff' stop-opacity='.34'/>" +
      "<stop offset='.52' stop-color='#ffffff' stop-opacity='.03'/>" +
      "<stop offset='.9' stop-color='#e3d7c2' stop-opacity='.24'/>" +
      "<stop offset='1' stop-color='#ece4d6' stop-opacity='.273'/>" +
    "</linearGradient></defs>" +
    "<rect width='100' height='100' fill='url(#sw)'/>";

  const ROUND_TOP =
    "<defs><linearGradient id='rt' x1='0' y1='0' x2='0' y2='1'>" +
      "<stop offset='0' stop-color='#dccfb6'/>" +
      "<stop offset='.3' stop-color='#fdfaf3'/>" +
      "<stop offset='.58' stop-color='#ffffff'/>" +
      "<stop offset='1' stop-color='#ffffff' stop-opacity='0'/>" +
    "</linearGradient></defs>" +
    "<rect width='100' height='23' fill='url(#rt)'/>";

  /* 奶油边沿的高光 + 裱花在下面的落影 */
  const CREAM_EDGE =
    " fill='none' stroke='#ffffff' stroke-opacity='.45' stroke-width='3'" +
    " stroke-linecap='round' stroke-linejoin='round'";
  const CREAM_SHADE =
    " fill='none' stroke='#9c8f7b' stroke-opacity='.18' stroke-width='4.5'" +
    " stroke-linecap='round' stroke-linejoin='round' filter='url(#sb)'";
  /* 淡描边：把每一块奶油的轮廓轻轻勾出来，就有了手绘的感觉 */
  const CREAM_INK =
    " fill='none' stroke='#a89a84' stroke-opacity='.3' stroke-width='1.5'" +
    " stroke-linecap='round' stroke-linejoin='round'";

  /* 白色系五档明度 —— 不靠颜色，全靠明度差把立体感撑起来 */
  const W_HI    = '#ffffff';   /* 高光 */
  const W_BASE  = '#faf4ea';   /* 主体奶白 */
  const W_CREAM = '#e9dcc4';   /* 奶油花边（比主体明显暗一档，花边才「凸」出来） */
  const W_SHADE = '#e2d6c4';   /* 阴影侧 */
  const W_DEEP  = '#d6c8b3';   /* 最暗的一档 */

  /* 侧面贴图：一层一片，画好「奶油 / 糖带 / 圆钝花边」
     花边一律「一片一个圆包」—— 一个包横跨整个薄片宽度，
     两端的切线水平，所以相邻薄片接得上，看上去是连续的奶油波浪。 */
  const SIDE = {
    /* 花边的下沿是一条「首尾切线都水平」的三次曲线，
       相邻两片接起来完全平滑 —— 于是奶油是圆圆的一串波浪，没有尖角 */
    /* 三层裱花：粉色托盘边 / 奶油底托 + 粉色糖带 / 粉色糖霜 */
    plate: function (a, step) {
      const w = creamWave(a, step, 40, 58, 14);
      return "<rect width='100' height='100' fill='" + W_SHADE + "'/>" +
             SWIRL +
             "<path d='" + w.fill + "' fill='" + W_CREAM + "'/>" +
             "<path d='" + w.line + "'" + CREAM_SHADE + "/>" +
             "<path d='" + w.line + "'" + CREAM_EDGE + "/>" +
             "<path d='" + w.line + "'" + CREAM_INK + "/>" +
             "<rect width='100' height='24' fill='" + W_HI + "' opacity='.4'/>" + ROUND_TOP;
    },
    t1: function (a, step) {
      const w = creamWave(a, step, 30, 50, 12);
      const w2 = creamWave(a, step, 18, 32, 17);
      return "<rect width='100' height='100' fill='" + W_BASE + "'/>" +
             SWIRL +
             "<path d='" + w2.fill + "' fill='" + W_HI + "' opacity='.85'/>" +
             "<path d='" + w2.line + "'" + CREAM_INK + "/>" +
             /* 一条淡紫糖带，和页面的浅蓝紫主题悄悄呼应 */
             "<rect y='62' width='100' height='10' fill='#e8e0f8'/>" +
             "<rect y='72' width='100' height='7' fill='#d5c9f0'/>" +
             "<path d='" + w.fill + "' fill='" + W_CREAM + "'/>" +
             "<path d='" + w.line + "'" + CREAM_SHADE + "/>" +
             "<path d='" + w.line + "'" + CREAM_EDGE + "/>" +
             "<path d='" + w.line + "'" + CREAM_INK + "/>" +
             ROUND_TOP;
    },
    t2: function (a, step) {
      const w = creamWave(a, step, 44, 64, 10);      /* 外圈：圆钝的大波浪 */
      const w2 = creamWave(a, step, 26, 40, 14);     /* 内圈：更小更密的一层裱花 */
      return "<rect width='100' height='100' fill='" + W_BASE + "'/>" +
             SWIRL +
             "<path d='" + w2.fill + "' fill='" + W_HI + "' opacity='.9'/>" +
             "<path d='" + w2.line + "'" + CREAM_INK + "/>" +
             "<path d='" + w.fill + "' fill='" + W_CREAM + "'/>" +
             "<path d='" + w.line + "'" + CREAM_SHADE + "/>" +
             "<path d='" + w.line + "'" + CREAM_EDGE + "/>" +
             "<path d='" + w.line + "'" + CREAM_INK + "/>" +
             ROUND_TOP;
    }
  };

  /* 顶着顶面外圈摆一圈小珍珠 —— 白色蛋糕最容易缺的就是这种「密度」 */
  function pearls(r, n, col) {
    let out = '';
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = 100 + Math.cos(ang) * r;
      const y = 100 + Math.sin(ang) * r;
      out += "<circle cx='" + x.toFixed(1) + "' cy='" + y.toFixed(1) + "' r='3.2' fill='" + col +
             "' stroke='#bfb19c' stroke-opacity='.18' stroke-width='.7'/>";
    }
    return out;
  }

  function sprinkles(n, size) {
    let out = '';
    for (let i = 0; i < n; i++) {
      const x = rnd(8, 92), y = rnd(8, 92), a = rnd(0, 180);
      const c = pick(['#7fd0ff', '#ffd166', '#ff9ec4', '#9ee6a8', '#ffb072', '#b9a6ff']);
      out += "<rect x='-4' y='-1.1' width='8' height='2.2' rx='1.1' fill='" + c +
             "' transform='translate(" + x + " " + y + ") rotate(" + a.toFixed(1) + ")'/>";
    }
    return out;
  }

  function buildTier(cfg, parent) {
    const part = document.createElement('div');
    part.className = 'part';
    part.style.transform = 'translateY(' + cfg.cy + 'px)';

    const step = 360 / cfg.n;
    const ao = aoLayer(cfg.ao);
    const w = 2 * cfg.r * Math.sin(Math.PI / cfg.n) + 1.4;
    const tz = cfg.r * Math.cos(Math.PI / cfg.n);
    const h = cfg.h;

    for (let i = 0; i < cfg.n; i++) {
      const a = i * step;
      const s = document.createElement('div');
      s.className = 'slice';
      s.style.width = w.toFixed(2) + 'px';
      s.style.height = h + 'px';
      s.style.left = (-w / 2).toFixed(2) + 'px';
      s.style.top = (-h / 2) + 'px';
      s.style.transform = 'rotateY(' + a.toFixed(2) + 'deg) translateZ(' + tz.toFixed(2) + 'px)';
      /* 明暗**不再用 CSS filter** —— 两百多个薄片各自跑一遍 brightness()，
         等于每帧重新栅格化两百多层，帧率直接从 60 掉到 35。
         改成在 SVG 里叠一层半透明遮罩，视觉一样但几乎不花钱。 */
      const bri = cfg.lo + (cfg.hi - cfg.lo) * Math.max(0, Math.cos(rad(a - 26)));
      const shade = bri < 1
        ? "<rect width='100' height='100' fill='#5b5145' opacity='" + ((1 - bri) * 0.95).toFixed(3) + "'/>"
        : "<rect width='100' height='100' fill='#ffffff' opacity='" + ((bri - 1) * 0.72).toFixed(3) + "'/>";
      s.style.backgroundImage =
        svgURI(SIDE[cfg.kind](a, step) + ao + CYL + shade, 100, 100);
      s.style.backgroundSize = '100% 100%';
      part.appendChild(s);
    }

    /* 顶面 / 底面 */
    [1, -1].forEach(dir => {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.style.width = (cfg.r * 2) + 'px';
      cap.style.height = (cfg.r * 2) + 'px';
      cap.style.left = (-cfg.r) + 'px';
      cap.style.top = (-cfg.r) + 'px';
      cap.style.transform = 'translateY(' + (-dir * h / 2) + 'px) rotateX(90deg)';

      if (cfg.kind === 'plate') {
        cap.style.background =
          'radial-gradient(circle at 50% 50%, #fffdf9 0%, #f4ecdf 58%, #e4d7c2 100%)';
      } else if (cfg.kind === 't2') {
        /* 顶面只有一层奶油和糖霜粒，不再画笑脸 */
        cap.style.background =
          'radial-gradient(circle at 50% 46%, #ffffff 0%, #fdf9f2 48%, #f6eee1 80%, #eadecb 100%)';
        cap.style.backgroundImage =
          svgURI(pearls(86, 20, '#fffdf8') + sprinkles(14, 3), 200, 200) + ',' +
          'radial-gradient(circle at 50% 46%, #ffffff 0%, #fdf9f2 48%, #f6eee1 80%, #eadecb 100%)';
        cap.style.backgroundSize = '100% 100%, 100% 100%';
      } else {
        cap.style.backgroundImage =
          svgURI(pearls(90, 26, '#fffdf8') + sprinkles(18, 3), 200, 200) + ',' +
          'radial-gradient(circle at 44% 40%, #ffffff 0%, #fffdfa 34%, #f8f2e8 68%, #efe4d3 100%)';
        cap.style.backgroundSize = '100% 100%, 100% 100%';
      }
      part.appendChild(cap);
    });

    parent.appendChild(part);
    return part;
  }

  /* =========================================================
     3b. 蛋糕 DIY 装饰（水果 / 小蜡烛 / 小玩意，可署名）
     ========================================================= */
  const DIY_KEY = 'lzx_cake_deco';
  const DIY_MAX = 40;
  let diyItems = store.get(DIY_KEY, null);
  if (!Array.isArray(diyItems)) diyItems = [];

  const DECOS = [
    { k: 'straw',  n: '草莓' },
    { k: 'blue',   n: '蓝莓' },
    { k: 'cherry', n: '樱桃' },
    { k: 'lemon',  n: '柠檬' },
    { k: 'star',   n: '星星' },
    { k: 'heart',  n: '爱心' },
    { k: 'flower', n: '小花' },
    { k: 'candle', n: '小蜡烛' },
    { k: 'candy',  n: '糖果' },
    { k: 'bow',    n: '蝴蝶结', inner: '<i class="knot"></i>' },
    { k: 'choco',  n: '巧克力' },
    { k: 'donut',  n: '甜甜圈' }
  ];

  const decoLayer = document.createElement('div');
  decoLayer.className = 'part';

  /* 找个不和已有装饰打架的位置：一半放上层顶面，一半放下层那一圈 */
  function freeSlot() {
    for (let t = 0; t < 80; t++) {
      const ring = Math.random() < 0.55;
      const a = rnd(0, 360);
      const R = ring ? rnd(100, 127) : rnd(46, 76);
      const y = ring ? 88 : 0;
      let ok = true;
      for (let i = 0; i < diyItems.length; i++) {
        const it = diyItems[i];
        if (it.y !== y) continue;
        let da = Math.abs(it.a - a);
        if (da > 180) da = 360 - da;
        if (da < 22 && Math.abs(it.R - R) < 26) { ok = false; break; }
      }
      if (ok) return { a: a, R: R, y: y };
    }
    return { a: rnd(0, 360), R: 116, y: 88 };
  }

  function renderDecos() {
    if (!decoLayer) return;
    decoLayer.innerHTML = '';
    diyItems.forEach((it, i) => {
      const p = document.createElement('div');
      p.className = 'part';
      p.style.transform =
        'rotateY(' + it.a.toFixed(1) + 'deg) translateZ(' + it.R.toFixed(1) + 'px)' +
        ' translateY(' + it.y + 'px)';

      const face = document.createElement('div');
      face.className = 'face';
      face.style.setProperty('--a', it.a.toFixed(1) + 'deg');

      const def = DECOS.filter(x => x.k === it.k)[0];
      const d = document.createElement('span');
      d.className = 'deco deco-' + it.k;
      if (def && def.inner) d.innerHTML = def.inner;
      d.setAttribute('data-from', it.from || '');
      d.setAttribute('role', 'button');
      d.style.setProperty('--d', String(i % 9));
      d.title = it.from ? (it.from + ' 放的') : '匿名放的';

      face.appendChild(d);
      p.appendChild(face);
      decoLayer.appendChild(p);
    });
    const c = $('#diyCount');
    if (c) c.textContent = diyItems.length;
  }

  function addDeco(kind) {
    if (diyItems.length >= DIY_MAX) {
      toast('蛋糕已经放满啦，先撤掉几个再放吧 🙈');
      return;
    }
    const slot = freeSlot();
    const nameEl = $('#diyName');
    const from = nameEl && nameEl.value.trim() ? nameEl.value.trim().slice(0, 10) : '';
    const item = {
      id: 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      k: kind, a: slot.a, R: slot.R, y: slot.y, from: from
    };
    diyItems.push(item);
    store.set(DIY_KEY, diyItems);
    renderDecos();
    const def = DECOS.filter(x => x.k === kind)[0];
    const nm = def ? def.n : '装饰';
    toast(from ? ('「' + from + '」放了一个' + nm + ' ✦') : ('放好了一个' + nm + ' ✦'));
    syncDecoUp(item);
  }

  /* 把刚放的装饰送到服务器 —— 这样别人打开也能看到 */
  function syncDecoUp(item) {
    if (!window.LZX_API) return;
    LZX_API.addDeco(item).then(d => {
      if (!d) {
        /* ⚠️ 失败不能静默 return（旧版就是直接 return，用户完全不知道没传上去）。
           装饰本身已存在本机，这里告诉用户 + 排进重试。 */
        queueDecoRetry(item);
        return;
      }
      if (d.ok && Array.isArray(d.deco)) { diyItems = d.deco; renderDecos(); }
      else if (d.err === 'full') { toast('蛋糕上已经放满啦 🙈'); syncDecos(); }
      else { queueDecoRetry(item); }
    });
  }

  /* 装饰的自动重试（和留言同一套思路） */
  var decoQueue = [], decoTimer = null, decoDelay = 5000;

  function queueDecoRetry(item) {
    var dup = decoQueue.some(function (x) { return x.id === item.id; });
    if (!dup) decoQueue.push(item);
    toast('装饰放好了，但还没传上去 —— 会自动重试 ✦');
    scheduleDecoRetry();
  }

  function scheduleDecoRetry() {
    if (decoTimer || !decoQueue.length || !window.LZX_API) return;
    decoTimer = setTimeout(function () {
      decoTimer = null;
      var it = decoQueue[0];
      if (!it) return;
      LZX_API.addDeco(it).then(function (d) {
        if (d && d.ok) {
          decoQueue.shift();
          decoDelay = 5000;
          if (Array.isArray(d.deco)) { diyItems = d.deco; renderDecos(); }
        } else if (d && d.err === 'full') {
          decoQueue.shift();
          toast('蛋糕上已经放满啦 🙈');
        } else {
          decoDelay = Math.min(decoDelay * 1.8, 60000);
        }
        scheduleDecoRetry();
      });
    }, decoDelay);
  }

  /* 拉取服务器上的装饰（大家放的都在这里）。
     ⚠️ 这里**不能要求 length > 0**：服务器上被撤空时本机也得跟着变空，
        否则会一直挂着一个早就没人要的装饰。
     指纹是为了挡住「数据没变也重建 DOM」—— 现在每 20 秒轮询一次，
     每次都重建会让蛋糕上的装饰闪一下，很烦。 */
  var decoSig = '';
  function syncDecos() {
    if (!window.LZX_API) return;
    LZX_API.state().then(d => {
      if (!d || !d.ok || !Array.isArray(d.deco)) return;
      const sig = d.deco.map(x => x.id + '|' + x.k + '|' + Math.round(x.a || 0) + '|' + Math.round(x.R || 0)).join(',');
      if (sig === decoSig) return;
      decoSig = sig;
      diyItems = d.deco;
      renderDecos();
    });
  }

  function initDiy() {
    const grid = $('#diyGrid');
    if (grid) {
      grid.innerHTML = DECOS.map(d =>
        '<button class="deco-btn" data-k="' + d.k + '" type="button">' +
          '<span class="ico"><span class="deco deco-' + d.k + '">' + (d.inner || '') + '</span></span>' +
          '<span class="nm">' + d.n + '</span>' +
        '</button>').join('');

      grid.addEventListener('click', e => {
        const b = e.target.closest('.deco-btn');
        if (!b) return;
        b.classList.add('pop');
        setTimeout(() => b.classList.remove('pop'), 420);
        addDeco(b.dataset.k);
      });
    }

    const undo = $('#diyUndo');
    if (undo) {
      /* 装饰现在是大家共用的，所以「撤销」只能撤自己放的那个
         （和涂鸦画板同一个规矩：别人的东西不许动） */
      undo.addEventListener('click', () => {
        if (!diyItems.length) { toast('还没有放装饰呢～'); return; }
        const me = window.LZX_API ? LZX_API.visitor() : null;
        let k = -1;
        for (let j = diyItems.length - 1; j >= 0; j--) {
          const it = diyItems[j];
          if (!it.by || it.by === me) { k = j; break; }
        }
        if (k < 0) { toast('这些装饰都是别人放的，不能替他们撤哦～'); return; }
        const gone = diyItems[k];
        diyItems.splice(k, 1);
        renderDecos();
        if (window.LZX_API && gone.by) {
          LZX_API.removeDeco(gone.id).then(d => {
            if (d && d.ok && Array.isArray(d.deco)) { diyItems = d.deco; renderDecos(); }
          });
        } else {
          store.set(DIY_KEY, diyItems);
        }
        toast('已撤掉你放的那个装饰');
      });
    }

    /* 点蛋糕上的装饰 → 看看是谁加的 */
    if (stage) {
      let downX = 0, downY = 0, movedFar = false;
      stage.addEventListener('pointerdown', e => {
        downX = e.clientX; downY = e.clientY; movedFar = false;
      });
      stage.addEventListener('pointermove', e => {
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 8) movedFar = true;
      });
      stage.addEventListener('click', e => {
        const d = e.target.closest('.deco');
        if (!d || movedFar) return;
        const from = d.getAttribute('data-from');
        toast(from ? ('这个装饰是「' + from + '」加的 ✦') : '这个装饰是匿名的人加的 ✦');
      });
    }

    renderDecos();
    syncDecos();
  }

  /* 蜡烛（简化：上层顶面正中间只留一根） */
  const candles = [];

  function buildCandle(parent) {
    const sr = 8, sh = 68;
    const part = document.createElement('div');
    part.className = 'part candle';
    /* 原点 = 蜡烛正中心；向下半个高度刚好落回顶面 */
    part.style.transform = 'translateY(' + (-sh / 2) + 'px)';

    /* 蜡身（12 面细圆柱） */
    const shaftPart = document.createElement('div');
    shaftPart.className = 'part';
    const n = 12, step = 360 / n;
    const w = 2 * sr * Math.sin(Math.PI / n) + 0.8;
    const tz = sr * Math.cos(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const a = i * step;
      const sl = document.createElement('div');
      sl.className = 'slice';
      sl.style.width = w.toFixed(2) + 'px';
      sl.style.height = sh + 'px';
      sl.style.left = (-w / 2).toFixed(2) + 'px';
      sl.style.top = (-sh / 2) + 'px';
      sl.style.transform = 'rotateY(' + a.toFixed(2) + 'deg) translateZ(' + tz.toFixed(2) + 'px)';
      sl.style.backgroundImage =
        'repeating-linear-gradient(38deg, #fffdf8 0 6px, #f0e2c8 6px 12px)';
      sl.style.filter = 'brightness(' + (0.86 + 0.18 * Math.max(0, Math.cos(rad(a - 26)))).toFixed(3) + ')';
      shaftPart.appendChild(sl);
    }
    part.appendChild(shaftPart);

    /* 顶端：星星 + 火焰 */
    const tip = document.createElement('div');
    tip.className = 'candle-tip';
    tip.style.transform = 'translateY(' + (-sh / 2) + 'px)';

    const face = document.createElement('div');
    face.className = 'face';
    face.style.setProperty('--a', '0deg');
    face.innerHTML = '<div class="candle-halo"></div><div class="flame"></div>' +
                     '<div class="star"><i class="star-mouth"></i></div>';
    const starEl = face.querySelector('.star');
    starEl.style.setProperty('--s1', '#fff4bd');
    starEl.style.setProperty('--s2', '#ffc62f');
    tip.appendChild(face);

    part.appendChild(tip);
    parent.appendChild(part);
    candles.push({ el: part, kind: 'candle' });
  }

  /* 「19」做成两只飘在蛋糕上方的银色气球。
     挂在 #cakeNum 这一层（不跟蛋糕旋转），所以飘着飘着不会插进蛋糕里。 */
  function buildNumberCandles(parent) {
    if (!parent) return;
    const part = document.createElement('div');
    part.className = 'cnum-wrap';
    part.innerHTML =
      '<svg class="cnum-string" viewBox="0 0 118 96" aria-hidden="true">' +
        '<path d="M41 2 C33 32 28 62 36 94"/>' +
        '<path d="M77 2 C85 32 90 62 82 94"/>' +
      '</svg>' +
      '<div class="cnum-line">' +
        '<span class="cnum-d">1</span>' +
        '<span class="cnum-d">9</span>' +
      '</div>';
    parent.appendChild(part);
    /* 气球不参与「点亮 / 吹灭」，所以不进 candles 数组 */
  }

  function buildCake() {
    if (!spinEl) return;
    spinEl.innerHTML = '';
    TIERS.forEach(t => buildTier(t, spinEl));
    buildCandle(spinEl);
    buildNumberCandles(numEl || spinEl);
    spinEl.appendChild(decoLayer);
    renderDecos();
  }

  /* 蛋糕（含右上方气球）在 scale = 1 时、相对锚点的视觉外延。
     这两个数是**扫了一整圈旋转**量出来的最坏值（每 6° 采一次）：
       锚点往上是气球顶 177（含浮动到最高点），
       锚点往下是盘子外沿 314 —— 注意它远大于盘子本身的半径，
       因为 perspective 会把靠近镜头的那半边放大，前沿甩得很低；
       而且它随旋转相位在 282~314 之间摆动，只采几秒会严重低估。
     ⚠️ 这两个数决定「蛋糕最大能放多大」和「许愿要抬多少」，
     估小了许愿时就会顶出屏幕（本轮先后按 226 / 236 估，都被这圈透视摆幅打脸）。 */
  const CAKE_UP = 180, CAKE_DOWN = 320;
  /* 许愿时放大的倍率。这个值不能随便加 —— 它和上面的外延一起决定蛋糕总高，
     stage 高度只够容纳 (CAKE_UP + CAKE_DOWN) * cakeScale * 本值 的 95%。
     1.19 是垂直方向还能兜住的最大值，再大许愿时就会顶出屏幕。 */
  const CAKE_WISH_MAX = 1.19;
  /* 基准蛋糕最多占掉垂直预算的 90%，剩下的留给许愿那一下放大 —— 
     舞台高度是有限的，基准占太多，许愿就放不大；留太少，蛋糕平时又显小。 */
  const CAKE_BASE_SHARE = 0.9;
  const CAKE_MARGIN = 12;       /* 上下各留一点呼吸位，别贴着屏幕边 */
  let stageH = 0;
  let wishMax = CAKE_WISH_MAX;  /* 实际可用的放大倍率，会按当前舞台高度收紧 */

  function calcScale() {
    const w = stage ? stage.clientWidth : window.innerWidth;
    /* ⚠️ 舞台高度必须**每次重新读**。它由 `calc(100svh - 120px)` 决定，
       而 svh 会随浏览器地址栏伸缩、窗口缩放而变化 —— 读一次存起来迟早会过期
       （本轮就是它停在 780、实际只有 680，于是按假高度算出了一个假的安全区）。 */
    stageH = stage ? stage.clientHeight : 780;
    const byW = (w - 30) / 420;
    /* 垂直预算：舞台高度扣除上下留白后，总共能容纳多少「未缩放高度」。
       高度方向必须卡一道，否则矮屏上一许愿，气球就被顶出屏幕。 */
    const budget = (stageH * 0.95) / (CAKE_UP + CAKE_DOWN);
    cakeScale = clamp(Math.min(byW, budget * CAKE_BASE_SHARE), 0.45, 1.5);
    /* 许愿能放大多少 = 剩下的预算。这样永远满足：
       (CAKE_UP + CAKE_DOWN) * cakeScale * wishMax ≤ 0.95 * 舞台高 → 不可能越界 */
    wishMax = clamp(budget / cakeScale, 1.0, CAKE_WISH_MAX);
  }

  /* 蛋糕整体上移多少 —— 随便给个固定值是会翻车的：
     放大之后如果还按原来的比例往上提，顶上的气球就出了屏幕顶部；
     提得不够，底下的盘子又出了底部。所以这里按 stage 的真实高度反推一个安全值。 */
  function wishLift() {
    const S = cakeScale * wishScale;
    const anchor = stageH * 0.57;          /* 锚点（蛋糕顶面）在 stage 里的位置 */
    const up = CAKE_UP * S;                /* 锚点往上：气球 */
    const down = CAKE_DOWN * S;            /* 锚点往下：盘子 */
    const hi = anchor - up - CAKE_MARGIN;         /* 上移量的上限：顶部（气球）不越界 */
    const lo = anchor + down - stageH + CAKE_MARGIN;  /* 下移量的下限：底部（盘子）不越界 */
    let lift = LIFT * wishScale;
    if (lo <= hi) lift = clamp(lift, lo, hi);
    else lift = (hi + lo) / 2;             /* 实在放不下就取中点，两边各让一点 */
    return Math.max(0, lift);
  }

  function spinTransform() {
    return 'translateY(' + (-wishLift()).toFixed(1) + 'px) scale(' +
           (cakeScale * wishScale).toFixed(4) +
           ') rotateX(' + TILT + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
  }

  /* 数字层：只要「升降 + 缩放」，不要任何旋转 —— 这一条就是防穿模的关键 */
  function numTransform() {
    return 'translateY(' + (-wishLift()).toFixed(1) + 'px) scale(' +
           (cakeScale * wishScale).toFixed(4) + ')';
  }

  /* 蛋糕和数字必须在同一帧、同一参数下更新，否则许愿放大会脱节 */
  function applySpin() {
    if (spinEl) spinEl.style.transform = spinTransform();
    if (numEl) numEl.style.transform = numTransform();
  }

  let litCount = 0;
  const LIGHT_KEY = 'lzx_light_count';

  /* ---------- 共享计数：所有人的点亮次数汇总在服务器上 ----------

     ⚠️ 这里的核心是**乐观更新**：点一下，大数字立刻 +1，
        **不等服务器往返**。服务器只负责把这个数变成「所有人都看得到的数」。

     之前的问题是：大数字直接读服务器返回值，于是
       · 请求还没回来 / 被限流 / 网络抖一下 → 数字一动不动
       · 而下面那行小字用的是本机计数，照常变化 → 看上去就是「小字动了、大数字没反应」。
     现在四个量分工明确，任何一步出问题都不会让数字卡住：

       gCandles  服务器确认过的「大家一共点亮」
       gWait     本机已点、还没发出去的次数
       gFly      发出去了、还没收到回执的次数
       litCount  这台设备自己点过几次（本地存档，兜底用）

     显示值 = gCandles + gWait + gFly —— 所以「我点 N 次，数字就 +N」永远成立。 */
  let gCandles = 0, gHosts = 0, gLoaded = false;
  const CANDLE_PENDING_KEY = 'lzx_candle_pending';
  let gWait = Math.max(0, Math.floor(Number(store.get(CANDLE_PENDING_KEY, 0)) || 0));
  let gFly = 0, gRetryTimer = null, gRetryDelay = 6000;

  function savePendingCandles() {
    // 包含已发出但还没确认的请求，刷新后仍可重试。
    return store.set(CANDLE_PENDING_KEY, gWait + gFly);
  }

  function restoreSharedLights() {
    const count = Math.max(litCount, gCandles);
    candles.slice(0, count).forEach(c => c.el.classList.add('is-lit'));
    if (candles.length && count >= candles.length && stage) stage.classList.add('lit');
  }

  function apiOk() {
    return !!(window.LZX_API && LZX_API.isOnline() !== false);
  }

  function pendingCount() { return gWait + gFly; }

  /* 大数字显示什么 —— 两个分支都保证「点了必增」 */
  function shownCount() {
    // 所有浏览器展示同一份服务端总数；待上传次数单独说明。
    return gCandles;
  }

  function renderShared() {
    const el = $('#lightShared');
    if (!el) return;
    if (window.LZX_API && LZX_API.isOnline() === false) {
      /* ⚠️ 文案要说清两件事：① **看到的数字不是 0，是上次的值**（否则用户以为数据丢了）；
         ② 正在自动重试、不用刷新。再带上具体原因方便排查。 */
      var why = (LZX_API.lastError && LZX_API.lastError()) || '';
      const known = gLoaded || gCandles > 0;
      el.textContent = '⚠ 暂时连不上服务器' + (why ? '（' + why + '）' : '') +
        (known ? ' —— 现在显示的是上次看到的数据' : ' —— 尚未读取到大家的记录，不能据此判断为 0') +
        '，正在自动重试，不用刷新';
      el.classList.add('warn');
      return;
    }
    el.classList.remove('warn');
    if (!gLoaded) {
      el.textContent = '正在读取大家的点亮记录…' + (pendingCount() ? ' · 本次点亮等待上传' : '');
      return;
    }
    const head = '已有 ' + gHosts + ' 位朋友为她点亮 · 你自己点了 ' + litCount + ' 次 · ';
    el.textContent = gPendingText(head);
  }
  function gPendingText(head) {
    return pendingCount() > 0 ? (head + '还有 ' + pendingCount() + ' 次待上传，暂未计入共享总数') : (head + '已同步服务器 ✦');
  }

  /* 把队列里的点亮次数逐个送出去，避免并发写入与限流。
     成功 → 从「发飞中」销账，并采纳服务器返回的新总数；
     失败 → 退回队列，15 秒后自动重试（所以限流或断网都不会丢）。 */
  function pushCandles() {
    if (!window.LZX_API || gWait <= 0) return;
    /* 数据层还没就绪（api.js 没加载 / 版本不符）：先别扣账，稍后重试 ——
       不然后面调用会抛异常，这一笔就凭空丢了 */
    if (typeof LZX_API.candle !== 'function') { scheduleCandleRetry(); return; }
    if (LZX_API.isOnline() === false) { scheduleCandleRetry(); return; }
    if (gFly > 0) return;
    const n = Math.min(gWait, 1);
    gWait -= n;
    gFly += n;
    savePendingCandles();
    for (let i = 0; i < n; i++) {
      let pr;
      try {
        pr = LZX_API.candle();
      } catch (e) {
        /* 调用当场就抛了：把这笔退回去，宁可重发也不能丢 */
        gFly = Math.max(0, gFly - 1);
        gWait++;
        savePendingCandles();
        scheduleCandleRetry();
        continue;
      }
      Promise.resolve(pr).then(function (d) {
        gFly = Math.max(0, gFly - 1);
        const ok = !!(d && d.ok);
        if (ok) {
          gCandles = Math.max(gLoaded ? gCandles : 0, d.candles || 0);
          gHosts = d.hosts || 0;
          gLoaded = true;
        } else {
          gWait++;                    /* 没成功就退回队列，等下一轮 */
        }
        savePendingCandles();
        restoreSharedLights();
        renderCount(false);
        renderShared();
        if (gWait > 0) {
          if (ok) {
            gRetryDelay = 6000;
            setTimeout(pushCandles, 180);   /* 还有积压就接着推 */
          } else {
            scheduleCandleRetry();
          }
        }
      }).catch(function () {
        gFly = Math.max(0, gFly - 1);
        gWait++;
        savePendingCandles();
        renderCount(false);
        renderShared();
        scheduleCandleRetry();
      });
    }
  }

  /* 退避重试：6 秒起，每次失败翻倍，最多 30 秒 —— 撞上写入限流也能自己爬出来 */
  function scheduleCandleRetry() {
    if (gRetryTimer) return;
    gRetryTimer = setTimeout(() => { gRetryTimer = null; pushCandles(); }, gRetryDelay);
    gRetryDelay = Math.min(gRetryDelay * 1.8, 30000);
  }

  /* 拉一次服务器上的权威值（别人点了多少） */
  function syncCandles() {
    if (!window.LZX_API) return;
    LZX_API.state().then(d => {
      if (d && d.ok) {
        /* 本机点过但还没同步上去时，别让数字往回跳 */
        gCandles = d.candles || 0;
        restoreSharedLights();
        gHosts = d.hosts || 0;
        gLoaded = true;
        renderCount(false);
      }
      renderShared();
    });
  }

  function renderCount(bump) {
    /* ⚠️ 每次都重新取元素，不用初始化时缓存的引用：
       页面若被外部编辑器重新渲染过，旧引用会脱离文档 ——
       写进去完全看不见，表现就是「大数字点了没反应」。 */
    const el = document.getElementById('lightCount') || lightNum;
    if (!el) return;
    el.textContent = (!gLoaded && !gCandles) ? '…' : shownCount();
    if (bump) {
      /* 动画挂在 .counter-num（父级）上 —— CSS 里的选择器就是 .counter-num.bump，
         之前加到 <b> 上，等于这个跳动动画从来没生效过 */
      const box = el.closest('.counter-num') || el;
      box.classList.remove('bump');
      void box.offsetWidth;
      box.classList.add('bump');
    }
  }

  function burst(n, cx, cy) {
    if (!fxLayer) return;
    const EMO = ['✨', '💖', '⭐', '🎉', '🌟', '💫', '🎈', '🫧', '✧'];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'fx';
      el.textContent = pick(EMO);
      el.style.left = (cx === undefined ? rnd(26, 74) : cx + rnd(-8, 8)) + '%';
      el.style.top = (cy === undefined ? rnd(26, 46) : cy + rnd(-6, 6)) + '%';
      el.style.setProperty('--dx', rnd(-110, 110).toFixed(0) + 'px');
      el.style.setProperty('--dy', rnd(-210, -110).toFixed(0) + 'px');
      el.style.setProperty('--dr', rnd(-170, 170).toFixed(0) + 'deg');
      el.style.fontSize = rnd(14, 26).toFixed(0) + 'px';
      el.style.animationDelay = rnd(0, 0.3).toFixed(2) + 's';
      fxLayer.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  }

  const TIPS = [
    '每一次点亮，都是一句「生日快乐」♡',
    '蜡烛亮起来了，愿望会慢慢实现的 ✧',
    '再点一次，把想念也一起点亮 💫',
    '火光里全是我们对你的祝福 🎂',
    '你许愿，我们负责让愿望实现 ✨'
  ];

  function lightUp() {
    litCount++;
    store.set(LIGHT_KEY, litCount);
    /* 先把这一次记进「待发队列」，再渲染 ——
       所以点击的当下大数字就会 +1，与网络快慢、服务器是否正常**完全无关** */
    gWait++;
    if (!savePendingCandles()) toast('浏览器未能保存待上传记录，请等上传完成再刷新');
    renderCount(true);
    renderShared();
    pushCandles();

    const idx = Math.min(litCount - 1, candles.length - 1);
    if (candles[idx]) candles[idx].el.classList.add('is-lit');
    if (litCount >= candles.length && stage) stage.classList.add('lit');

    burst(litCount >= candles.length ? 14 : 9);
    if (lightTip) lightTip.textContent = TIPS[Math.min(litCount, TIPS.length - 1)];

    if (litCount === 1) toast('蜡烛亮啦，生日快乐 ✨');
    if (litCount === 2) toast('数字「1」亮起来了 🕯️');
    if (litCount === 3) toast('「19」全部点亮，一起许个愿吧 🎂');
  }

  function initCake() {
    if (!stage || !spinEl) return;
    buildCake();
    calcScale();
    /* 舞台尺寸一变（地址栏伸缩、窗口缩放、媒体查询切换）就立刻重算 —— 
       只靠 window.resize 不够，svh 变化不一定触发它，而且时机常早于布局完成 */
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        requestAnimationFrame(() => { calcScale(); applySpin(); });
      }).observe(stage);
    }
    spinEl.style.setProperty('--ry', ry + 'deg');
    applySpin();
    spinEl.style.opacity = '1';

    litCount = Number(store.get(LIGHT_KEY, 0)) || 0;
    if (litCount > 0) {
      /* 按已经点过几次来恢复，而不是一上来就全亮 */
      candles.slice(0, litCount).forEach(c => c.el.classList.add('is-lit'));
      if (litCount >= candles.length && stage) stage.classList.add('lit');
    }
    renderCount(false);
    renderShared();
    syncCandles();
    pushCandles();
    /* 每 45 秒悄悄拉一次：别人点的，自己这边也能跟上。
       只读接口，不占写入限流额度。 */
    setInterval(() => { if (!document.hidden) syncCandles(); }, 45000);
    /* 页面回到前台时，把积压的补上、顺便刷新一次 */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      syncCandles();
      pushCandles();
    });

    if (lightBtn) lightBtn.addEventListener('click', lightUp);

    /* 拖拽旋转 */
    stage.addEventListener('pointerdown', e => {
      dragging = true;
      dragX = e.clientX;
      dragRy = ry;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    window.addEventListener('pointermove', e => {
      if (!dragging) return;
      ry = dragRy + (e.clientX - dragX) * 0.42;
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      resumeAt = performance.now() + 3200;
    });
    window.addEventListener('pointercancel', () => { dragging = false; resumeAt = performance.now() + 2000; });
  }

  /* =========================================================
     3c. 许愿 → 吹蜡烛
     ========================================================= */
  const wishBtn  = $('#wishBtn');
  const blowBtn  = $('#blowBtn');
  const wishHint = $('#wishHint');
  const wishEdit = $('#wishEdit');

  let wishing = false;
  let wishBusy = false;

  function blockScroll(e) { if (wishing) e.preventDefault(); }
  function blockKeys(e) {
    if (!wishing) return;
    if (wishEdit && document.activeElement === wishEdit) return;
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown' ||
        k === 'Home' || k === 'End' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
    }
  }
  function lockScroll(on) {
    if (on) {
      window.addEventListener('wheel', blockScroll, { passive: false });
      window.addEventListener('touchmove', blockScroll, { passive: false });
      window.addEventListener('keydown', blockKeys);
    } else {
      window.removeEventListener('wheel', blockScroll);
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('keydown', blockKeys);
    }
  }

  /* 吹气 / 熄灭时飘起来的小火星 */
  function puff(n, cy) {
    if (!fxLayer) return;
    const EMO = ['💨', '✧', '·', '🫧', '✦', '˚'];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'fx';
      el.textContent = pick(EMO);
      el.style.left = rnd(30, 70) + '%';
      el.style.top = (cy + rnd(-5, 5)) + '%';
      el.style.setProperty('--dx', rnd(-70, 70).toFixed(0) + 'px');
      el.style.setProperty('--dy', rnd(-190, -90).toFixed(0) + 'px');
      el.style.setProperty('--dr', rnd(-90, 90).toFixed(0) + 'deg');
      el.style.fontSize = rnd(13, 24).toFixed(0) + 'px';
      el.style.animationDelay = rnd(0, 0.35).toFixed(2) + 's';
      fxLayer.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  }

  function startWish() {
    if (wishing || wishBusy) return;
    wishBusy = true;
    wishing = true;

    /* 先把蛋糕滚到视线中央，再暗下来 —— 不然一暗就找不着蛋糕了 */
    if (stage) {
      const r = stage.getBoundingClientRect();
      const y = window.scrollY + r.top + r.height / 2 - window.innerHeight * 0.46;
      try { window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); }
      catch (e) { window.scrollTo(0, Math.max(0, y)); }
    }

    /* 许愿的时候，蜡烛要全亮着 */
    candles.forEach(c => c.el.classList.add('is-lit'));
    if (stage) stage.classList.add('lit');
    wishScaleTo = wishMax;   /* 上限交给 calcScale / wishLift 一起兜住 */

    setTimeout(() => {
      document.body.classList.add('wishing');
      if (wishBtn) wishBtn.hidden = true;
      if (lightBtn) lightBtn.hidden = true;
      if (blowBtn) blowBtn.hidden = false;
      if (wishHint) wishHint.hidden = false;
      wishBusy = false;
      lockScroll(true);
      burst(12, 50, 34);
      toast('已为你熄了灯 · 慢慢许 ✧');
    }, 220);
  }

  function blowCandles() {
    if (!wishing || wishBusy) return;
    wishBusy = true;
    candles.forEach(c => c.el.classList.remove('is-lit'));
    if (stage) stage.classList.remove('lit');
    puff(16, 44);
    toast('呼～蜡烛吹灭啦，愿望已经出发了 💫');

    /* 吹完 1 秒，页面回到原来的样子 */
    setTimeout(() => {
      document.body.classList.remove('wishing');
      wishScaleTo = 1;
      lockScroll(false);
      if (wishBtn) wishBtn.hidden = false;
      if (lightBtn) lightBtn.hidden = false;
      if (blowBtn) blowBtn.hidden = true;
      if (wishHint) wishHint.hidden = true;
      wishing = false;
      wishBusy = false;
      burst(10, 50, 40);
    }, 1000);
  }

  /* =========================================================
     3d. 生日愿望：她自己写，写完存在本机浏览器
     ========================================================= */
  const WISH_KEY = 'lzx_wish_text';
  const WISH_MAX = 160;

  function readWish() {
    if (!wishEdit) return '';
    let out = '';
    (function walk(node) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const n = node.childNodes[i];
        if (n.nodeType === 3) out += n.nodeValue;
        else if (n.nodeName === 'BR') out += '\n';
        else {
          if (out && !/\n$/.test(out)) out += '\n';
          walk(n);
        }
      }
    })(wishEdit);
    return out.replace(/\n{3,}/g, '\n\n').slice(0, WISH_MAX);
  }

  function writeWish(txt) {
    if (!wishEdit) return;
    wishEdit.textContent = '';
    const str = String(txt || '').slice(0, WISH_MAX);
    str.split('\n').forEach((line, i) => {
      if (i) wishEdit.appendChild(document.createElement('br'));
      wishEdit.appendChild(document.createTextNode(line));
    });
    wishEdit.setAttribute('data-empty', str.trim() ? '0' : '1');
  }

  function initWish() {
    if (wishBtn) wishBtn.addEventListener('click', startWish);
    if (blowBtn) blowBtn.addEventListener('click', blowCandles);

    if (!wishEdit) return;
    writeWish(store.get(WISH_KEY, ''));

    let timer = null;
    const sync = () => wishEdit.setAttribute('data-empty', readWish().trim() ? '0' : '1');
    wishEdit.addEventListener('input', () => {
      if (readWish().length > WISH_MAX) writeWish(readWish());
      sync();
      clearTimeout(timer);
      timer = setTimeout(() => store.set(WISH_KEY, readWish()), 420);
    });
    wishEdit.addEventListener('blur', () => {
      store.set(WISH_KEY, readWish());
      sync();
    });
    /* 粘贴只留纯文字，别把外面的样式一起带进来 */
    wishEdit.addEventListener('paste', e => {
      e.preventDefault();
      const cd = e.clipboardData || window.clipboardData;
      const txt = cd ? String(cd.getData('text') || '') : '';
      writeWish((readWish() + txt).slice(0, WISH_MAX));
      sync();
      store.set(WISH_KEY, readWish());
    });
  }

  function tickCake(dt) {
    if (!stage || !spinEl) return;
    if (Math.abs(wishScaleTo - wishScale) > 0.0005) {
      wishScale += (wishScaleTo - wishScale) * Math.min(1, dt / 420);
    } else {
      wishScale = wishScaleTo;
    }
    if (dragging) {
      applySpin();
      spinEl.style.setProperty('--ry', ry.toFixed(2) + 'deg');
      return;
    }
    if (performance.now() > resumeAt) {
      ry += (SPEED * dt) / 1000;
      if (ry > 360) ry -= 360;
    }
    applySpin();
    spinEl.style.setProperty('--ry', ry.toFixed(2) + 'deg');
  }

  /* =========================================================
     4. 回忆放映机
     ========================================================= */
  /* 内置样片 —— **按作者要求先清空**，放映机留给她们自己上传的照片。
     ⚠️ 图片素材还老老实实留在 assets/ 里（cake.jpg / avatar.jpg / sign.jpg），**一张没删**。
        想放回来的话，把下面三行取消注释就行，不用重新找图：
           { src: 'assets/cake.jpg',   cap: '今天的主角 —— 她的生日蛋糕 🎂' },
           { src: 'assets/avatar.jpg', cap: '她喜欢的刘耀文，也来一起过生日 🐱' },
           { src: 'assets/sign.jpg',   cap: 'To 李芷贤 · Happy Birthday' }
     ⚠️ 千万别学 d02e7f8 那次：撤图的同时把素材图删了、还顺手加了「自动清空本机相册」——
        那是不可逆的数据损失。撤内容可以，删素材和动用户数据不行。 */
  const DEFAULT_ITEMS = [];

  const GAL_KEY = 'lzx_gallery';
  const slideWindow = $('#slideWindow');
  const deck = $('#slideDeck');
  const captionEl = $('#slideCaption');
  const barEl = $('#filmBar');
  const playBtn = $('#playBtn');
  const fileInput = $('#fileInput');
  const resetBtn = $('#resetBtn');
  const slideHint = $('#slideHint');

  let gallery = store.get(GAL_KEY, []) || [];

  /* ⚠️ 这里原本有一段「一次性清空本机相册」的代码（靠 ALBUM_WIPED 标记只跑一次）。
     它会在升级时把用户自己加进相册的照片**全部抹掉，而且找不回来** —— 已删除。
     以后再想清相册，只能由用户主动点「恢复默认」；任何自动清空都不许再加。 */

  let shared = [];        /* 大家上传到服务器上的照片 */
  const photoCache = store.get('lzx_shared_photos_v2', {}) || {};
  let legacyPhotos = photoCache.legacy || [], cloudPhotos = photoCache.cloud || [];
  shared = legacyPhotos.concat(cloudPhotos);
  let photoBusy = false, galleryReady = !window.LZX_BOARD_STORE;
  function saveGallery() {
    const localOK = store.set(GAL_KEY, gallery);
    if (window.LZX_BOARD_STORE) LZX_BOARD_STORE.saveGallery(gallery).then(ok => {
      if (!ok && !localOK && slideHint) { slideHint.textContent = '本机存储不可用，请保持页面打开等待上传完成'; slideHint.classList.add('warn'); }
    });
    return localOK;
  }
  let items = [];
  let cells = [];
  let iPrev = 0, iCur = 1, iNext = 2;
  let idx = 0;
  let slideCounter = null;
  let playing = true;
  let acc = 0;
  const DUR = 4800;

  function buildItems() {
    /* 顺序：大家上传的 → 你自己加的 → 内置样片 */
    const ids = new Set(shared.map(p => p.pid));
    items = shared.concat(gallery.filter(p => !ids.has(p.cloudPid || p.pid))).concat(DEFAULT_ITEMS);
  }

  /* 从服务器把大家上传的照片拉下来 */
  /* 判断一段字幕是不是「文件名的残渣」—— 历史数据里可能有，一律不显示。
     典型形态：IMG_0016 / DSC01234 / dji_mimo_20251206_082630_..._photo /
              32 位哈希名 / 纯数字下划线长串 / 带图片扩展名。
     起因：更早的版本上传时把 `f.name` 直接写进了 cap，相册下面就显示成文件名了。 */
  function filenameLike(t) {
    if (!t) return false;
    if (/^__lzx_photo_[a-z0-9]+__$/i.test(t)) return true;
    var v = String(t).trim();
    if (/\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/i.test(v)) return true;
    /* 相机/手机/无人机的默认名：前缀 + 一串「数字/下划线/横线」。
       · 后缀用 `[\d\-_]+` 而不是 `\d+` —— 要能吃掉 `PXL_20240101_120000` 这种两段下划线。
       · **必须真的带后缀**，所以单独一个「IMG」「照片」「截屏」不会被误伤。 */
    if (/^(img|dsc|dscf|pxl|photo|image|微信图片|截屏|照片)[-_ ]?[\d\-_]+$/i.test(v)) return true;
    if (/^(screenshot|screen ?shot)$/i.test(v)) return true;
    if (/^dji_/i.test(v)) return true;
    if (/^[0-9a-f]{24,}$/i.test(v)) return true;
    if (/^[\d_\-]{12,}$/.test(v)) return true;
    return false;
  }

  function updateSharedPhotos() {
    const old = shared.map(p => p.pid).join(',');
    const migrated = new Set(gallery.filter(p => p.cloudPid && cloudPhotos.some(c => c.pid === p.cloudPid)).map(p => p.pid));
    const cloudIds = new Set(cloudPhotos.map(p => p.pid));
    shared = cloudPhotos.concat(legacyPhotos.filter(p => !migrated.has(p.pid) && !(p.uploadId && cloudIds.has('p' + p.uploadId))));
    store.set('lzx_shared_photos_v2', {legacy:legacyPhotos,cloud:cloudPhotos});
    const next = shared.map(p => p.pid).join(',');
    if (next !== old) buildDeck(true);
  }
  function renderPhotoSync() {
    if (!slideHint) return;
    const n = gallery.filter(p => !p.cloudUp).length;
    slideHint.textContent = n ? n + ' 张照片待上传 · 本机副本保留，联网后自动补传' : '已读取 ' + shared.length + ' 张共享照片 · 所有访客可见';
    slideHint.classList.toggle('warn', n > 0);
  }
  function syncPhotos() {
    if (window.LZX_API) LZX_API.state().then(d => {
      if (!d || !Array.isArray(d.photos)) return;
      legacyPhotos = d.photos.slice().reverse().map(p => ({src:LZX_API.base()+p.url,cap:filenameLike(p.cap)?'':(p.cap||''),shared:true,pid:p.id,uploadId:/^__lzx_photo_([a-z0-9]+)__$/i.test(p.cap||'') ? p.cap.match(/^__lzx_photo_([a-z0-9]+)__$/i)[1] : ''}));
      updateSharedPhotos(); renderPhotoSync();
    });
    boardRequest('/api/photos').then(d => {
      if (!Array.isArray(d.photos)) return;
      cloudPhotos = d.photos.slice().reverse().map(p => ({src:BOARD_CLOUD+p.url,cap:filenameLike(p.cap)?'':(p.cap||''),shared:true,pid:p.id}));
      let changed = false;
      gallery.forEach(it => { const id = 'p'+it.uploadId; if (it.uploadId && !it.cloudUp && cloudPhotos.some(p=>p.pid===id)) { it.cloudUp=true;it.cloudPid=id;changed=true; } });
      updateSharedPhotos(); if (changed) saveGallery(); renderPhotoSync();
    }).catch(() => { if (slideHint) { slideHint.textContent = '共享相册暂未读取成功 · 已保留副本，会自动重试'; slideHint.classList.add('warn'); } });
  }
  async function retryPhotos() {
    if (!galleryReady || !boardReady || !boardCloudKey || photoBusy || document.hidden) return;
    const pending = gallery.filter(p => !p.cloudUp && /^data:image\//.test(p.src||''));
    if (!pending.length) return;
    photoBusy = true;
    try {
      for (const it of pending) {
        if (!it.uploadId) it.uploadId = Date.now().toString(36)+Math.random().toString(36).slice(2,8);
        saveGallery();
        const id='p'+it.uploadId;
        const d=await boardRequest('/api/photos',{id,visitor:boardCloudVisitor,key:boardCloudKey,data:it.src,cap:it.cap||'',name:it.name||''},60000);
        if (!d.photo || d.photo.id!==id) throw new Error('上传未确认');
        it.cloudUp=true;it.cloudPid=id;saveGallery();
      }
      syncPhotos();
    } catch(e) {
      if (slideHint) { slideHint.textContent='上传尚未成功 · 照片副本保留，联网后会自动补传';slideHint.classList.add('warn'); }
    } finally {photoBusy=false;renderPhotoSync();}
  }

  function makeCell() {
    const el = document.createElement('div');
    el.className = 'slide';
    const img = document.createElement('img');
    img.alt = '回忆照片';
    img.decoding = 'async';
    el.appendChild(img);
    deck.appendChild(el);
    return { el: el, img: img };
  }

  function preload(src) {
    const im = new Image();
    im.src = src;
  }

  function loadCell(cell, i) {
    const mi = ((i % items.length) + items.length) % items.length;
    const item = items[mi];
    if (!item) return;
    cell.i = mi;              /* 记下这一格现在放的是第几张，管理删图要用 */
    cell.img.fetchPriority = mi === idx ? 'high' : 'low';
    cell.src = item.src; cell.retryAt = 0;
    cell.img.onerror = () => { cell.retryAt = Date.now() + 10000; };
    cell.img.src = item.src;
    if (cell.img.decode) cell.img.decode().catch(() => {});
  }

  function setRoles() {
    cells.forEach(c => { c.el.className = 'slide'; });
    cells[iPrev].el.classList.add('is-prev');
    cells[iCur].el.classList.add('is-current');
    cells[iNext].el.classList.add('is-next');
    const cur = items.length ? items[idx % items.length] : null;
    if (slideCounter) slideCounter.textContent = items.length ? (idx + 1) + ' / ' + items.length : '0 / 0';
    if (captionEl) {
      captionEl.style.opacity = '0';
      setTimeout(() => {
        captionEl.textContent = (cur && cur.cap) ? cur.cap
          : (items.length ? '' : '相册空空的 —— 用下面「＋ 添加照片」放几张进来吧 ✦');
        captionEl.style.opacity = '1';
      }, 220);
    }
  }

  function buildDeck(rebuild) {
    if (!deck) return;
    const current = items[idx];
    buildItems();
    const retained = current ? items.findIndex(p => current.pid ? p.pid === current.pid : p.src === current.src) : -1;
    idx = retained >= 0 ? retained : Math.min(idx, Math.max(0, items.length - 1));
    if (rebuild || cells.length === 0) {
      deck.innerHTML = '';
      cells = [makeCell(), makeCell(), makeCell()];
      iPrev = 2; iCur = 0; iNext = 1;
      loadCell(cells[iCur], idx);
      loadCell(cells[iPrev], idx - 1);
      loadCell(cells[iNext], idx + 1);
      ctx_bindClicks();
    } else {
      loadCell(cells[iCur], idx);
      loadCell(cells[iPrev], idx - 1);
      loadCell(cells[iNext], idx + 1);
    }
    setRoles();
    syncEmpty();
    if (!current || retained < 0) acc = 0;
    if (barEl) barEl.style.width = clamp(acc / DUR * 100, 0, 100) + '%';
  }
  function ctx_bindClicks() {}

  /* 相册空着的时候，别留一个白框 —— 窗口里给一句话，按钮也照顾一下 */
  function syncEmpty() {
    const empty = items.length === 0;
    if (slideWindow) slideWindow.classList.toggle('is-empty', empty);
    if (playBtn) playBtn.disabled = empty;
    if (barEl) barEl.style.width = '0%';
  }

  function go(step) {
    if (!cells.length || items.length < 2) return;
    idx = ((idx + step) % items.length + items.length) % items.length;

    if (step < 0) {
      const oldNext = iNext;
      iNext = iCur; iCur = iPrev; iPrev = oldNext;
      loadCell(cells[iPrev], idx - 1);
    } else {
      const oldPrev = iPrev;
      iPrev = iCur; iCur = iNext; iNext = oldPrev;
      loadCell(cells[iNext], idx + 1);
    }

    if (!PERF.mobile) preload(items[(idx + 2) % items.length].src);

    setRoles();
    acc = 0;
    if (barEl) barEl.style.width = '0%';
  }

  function tickSlides(dt) {
    if (!cells.length || items.length < 2 || !playing) return;
    const nextImage = cells[iNext].img;
    if (!nextImage.complete || !nextImage.naturalWidth) {
      const next = cells[iNext];
      if (next.retryAt && Date.now() >= next.retryAt) { next.retryAt = Date.now() + 10000; nextImage.src = next.src + (next.src.includes('?') ? '&' : '?') + 'retry=' + Date.now(); }
      if (slideCounter) slideCounter.textContent = (idx + 1) + ' / ' + items.length + ' · 下一张加载中…';
      return;
    }
    if (slideCounter) slideCounter.textContent = (idx + 1) + ' / ' + items.length;
    acc += dt;
    if (barEl) barEl.style.width = clamp((acc / DUR) * 100, 0, 100) + '%';
    if (acc >= DUR) go(1);
  }

  function compress(file, max, quality) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          const s = Math.min(1, max / Math.max(im.width, im.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(im.width * s));
          c.height = Math.max(1, Math.round(im.height * s));
          const g = c.getContext('2d');
          g.drawImage(im, 0, 0, c.width, c.height);
          try { resolve(c.toDataURL('image/jpeg', quality)); }
          catch (e) { reject(e); }
        };
        im.onerror = reject;
        im.src = fr.result;
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function initSlides() {
    if (!deck) return;
    slideCounter = document.createElement('span');
    slideCounter.className = 'slide-counter'; slideCounter.setAttribute('aria-live', 'polite');
    if (captionEl) captionEl.insertAdjacentElement('afterend', slideCounter);
    if (window.LZX_BOARD_STORE) {
      if (fileInput) fileInput.disabled = true;
      LZX_BOARD_STORE.loadGallery().then(saved => {
        gallery = saved;
        gallery.forEach(it => { if (it.up && !it.pid) it.up = false; });
        galleryReady = true;
        if (fileInput) fileInput.disabled = false;
        buildDeck(true); syncPhotos(); retryPhotos();
      }).catch(() => { galleryReady = true; if (fileInput) fileInput.disabled = false; retryPhotos(); });
    }
    buildDeck(true);

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        playing = !playing;
        playBtn.textContent = playing ? '暂停' : '播放';
        if (playing) acc = 0;
      });
    }
    $$('[data-act="prev"]').forEach(b => b.addEventListener('click', () => { go(-1); }));
    $$('[data-act="next"]').forEach(b => b.addEventListener('click', () => { go(1); }));

    if (resetBtn) {
      /* 有内置样片时它是「恢复默认」（撤掉本机的、回到样片）；
         没样片时它就是「清空相册」（只清本机加的那些）。
         —— 别人传到网上的不归它管，得由上传的人自己撤。 */
      resetBtn.textContent = DEFAULT_ITEMS.length ? '恢复默认' : '清空相册';
      resetBtn.addEventListener('click', () => {
        if (!gallery.length) { toast('相册现在就是空的'); return; }
        gallery = [];
        saveGallery();
        buildDeck(true);
        toast(DEFAULT_ITEMS.length ? '已恢复默认照片' : '已清空这台设备上的照片');
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', async e => {
        const files = Array.prototype.slice.call(e.target.files || [], 0, 10);
        if (!files.length) return;
        if (slideHint) { slideHint.textContent = '正在处理照片…'; slideHint.classList.remove('warn'); }
        const added = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!/^image\//.test(f.type)) continue;
          try {
            const data = await compress(f, 1400, 0.82);
            added.push({ src: data, cap: '', uploadId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) });   /* ⚠️ 不要把文件名当字幕 —— 会显示成 IMG_0016 / dji_mimo_2025..._photo 这种。 */
          } catch (err) { /* 忽略单张失败 */ }
        }
        if (!added.length) {
          if (slideHint) { slideHint.textContent = '这些文件没法读取，换几张图片试试？'; slideHint.classList.add('warn'); }
          return;
        }
        /* 先上屏（立刻能看到），再传服务器 —— 本地存不下也不影响上传 */
        gallery = gallery.concat(added);
        buildDeck(true);
        playing = true;
        if (playBtn) playBtn.textContent = '暂停';
        const localOk = saveGallery();
        if (slideHint) {
          slideHint.textContent = localOk
            ? ('已添加 ' + added.length + ' 张，正在上传…')
            : ('已添加 ' + added.length + ' 张（本机存不下了，正在直接传到网上）');
          slideHint.classList.remove('warn');
        }

        /* 传到服务器 —— 这一步才是「所有人都能看到」的关键 */
        if (window.LZX_API) {
          const who = (($('#diyName') && $('#diyName').value.trim()) ||
                       ($('#noteName') && $('#noteName').value.trim()) || '');
          added.forEach(it => { it.name = who; });
          saveGallery();
          retryPhotos();
        } else if (slideHint) {
          slideHint.textContent = '照片已添加（只存在本机，这台设备上的浏览器能看到）';
        }
        toast('照片加进来啦，开始回忆放映 ✨');
        e.target.value = '';
      });
    }
    /* 管理模式下点照片可以删（照片是大家传的，总得有个收拾的口子） */
    if (deck) {
      deck.addEventListener('click', e => {
        if (!adminCode()) return;
        const img = e.target.closest('img');
        if (!img) return;
        const cell = cells.filter(c => c.img === img)[0];
        const it = cell && items[cell.i];
        if (!it || !it.shared) return;
        if (!confirm('删掉这张照片吗？所有人都会看不到它了。')) return;
        LZX_API.removePhoto(it.pid, adminCode()).then(d => {
          if (d && d.ok) {
            shared = shared.filter(x => x.pid !== it.pid);
            buildItems();
            buildDeck(true);
            toast('照片已删除');
          } else {
            toast('删不掉，可能口令不对');
          }
        });
      });
    }

    const syncButton = document.createElement('button'); syncButton.className='ctrl-btn'; syncButton.type='button';syncButton.textContent='重新同步照片';syncButton.addEventListener('click',()=>{syncPhotos();retryPhotos();});
    if (slideHint) slideHint.insertAdjacentElement('afterend',syncButton);
    syncPhotos();
    retryPhotos();
    setInterval(() => { if (!document.hidden) { syncPhotos(); retryPhotos(); } }, 15000);
    window.addEventListener('online', retryPhotos);
    /* 预加载第一张。⚠️ 相册**可能是空的**（按作者要求先清空样片），
       所以必须先判空 —— 原来直接写 `DEFAULT_ITEMS[0].src`，
       数组一空就抛 TypeError，而这里在初始化流程里，
       **异常会把后面的代码整段打断**：烟花不发射、蛋糕不转、主循环根本不启动。
       （这个坑真踩过：一次清空样片之后，整个页面变成静止画面。） */
    const firstPick = items[0] || DEFAULT_ITEMS[0];
    if (firstPick && firstPick.src) preload(firstPick.src);
  }

  /* =========================================================
     管理口令
     ---------------------------------------------------------
     页面是公开的，谁都能贴便签、传照片 —— 所以需要一个「收拾场面」的口子：
       · 用 ?admin=口令 打开页面，口令会记在本次会话里
       · 之后删别人的便签 / 删照片就不用每次输了
     ========================================================= */
  const ADMIN_KEY = 'lzx_admin';
  function adminCode() {
    try {
      const q = new URLSearchParams(location.search).get('admin');
      if (q) { sessionStorage.setItem(ADMIN_KEY, q); return q; }
      return sessionStorage.getItem(ADMIN_KEY) || '';
    } catch (e) { return ''; }
  }

  /* =========================================================
     5. 便签墙
     ========================================================= */
  const NCOLORS = [
    { a: '#ffe6f0', b: '#ffc8de' },
    { a: '#e6eeff', b: '#c8dbff' },
    { a: '#ece4ff', b: '#d7c9ff' },
    { a: '#e0f8ee', b: '#c3eedb' },
    { a: '#fff6cd', b: '#ffe9a1' },
    { a: '#ffe9d4', b: '#ffd0ab' },
    { a: '#ffffff', b: '#f1efff' },
    { a: '#e2f4ff', b: '#c2e8ff' }
  ];
  const NSHAPES = [
    { k: 'round', n: '圆角' },
    { k: 'square', n: '直角' },
    { k: 'circle', n: '圆形' },
    { k: 'heart', n: '爱心' },
    { k: 'tag', n: '标签' },
    { k: 'pillow', n: '云朵' }
  ];
  const NMATS = [
    { k: 'paper', n: '纸感' },
    { k: 'kraft', n: '牛皮纸' },
    { k: 'lined', n: '横线本' },
    { k: 'grid', n: '方格本' },
    { k: 'gloss', n: '亮面' },
    { k: 'frost', n: '磨砂' },
    { k: 'denim', n: '布纹' }
  ];

  const NOTES_KEY = 'lzx_notes';
  const NOTE_CLEAN_AT = 1791561087048;
  function removedByNoteCleanup(n) { const name = String(n.from || n.name || '').trim().toLowerCase(); return !['邓蕙荞', 'dhq'].includes(name) && (!n.at || n.at <= NOTE_CLEAN_AT); }
  const DEFAULT_NOTES = [
    { id: 'seed1', text: '生日快乐呀！愿你今年所有的期待都有着落 ♡', from: '', c: 0, s: 'round', m: 'paper', tilt: -3.1 },
    { id: 'seed2', text: '新的一岁，继续闪闪发光', from: '一直看着你的人', c: 2, s: 'heart', m: 'gloss', tilt: 2.6 },
    { id: 'seed3', text: '记得吃蛋糕，记得要开心，记得有人惦记着你', from: '', c: 3, s: 'tag', m: 'lined', tilt: -1.4 },
    { id: 'seed4', text: '十月十一日快乐，往后每一天都要顺顺利利', from: '路过的人', c: 5, s: 'circle', m: 'frost', tilt: 1.9 },
    { id: 'seed5', text: '愿你所求皆有回响，所行皆有归途', from: '', c: 1, s: 'pillow', m: 'grid', tilt: -2.3 }
  ];

  const wall = $('#noteWall');
  const emptyTip = $('#noteEmpty');
  const noteText = $('#noteText');
  const noteName = $('#noteName');
  const charNow = $('#charNow');
  const pickColor = $('#pickColor');
  const pickShape = $('#pickShape');
  const pickMat = $('#pickMat');
  const notePreview = $('#notePreview');
  const noteAdd = $('#noteAdd');

  let notes = store.get(NOTES_KEY, null);
  if (!notes || !notes.length) notes = DEFAULT_NOTES.slice();
  /* 没有 by 的都是内置的示例便签，标成「本机」—— 只有这种能在本地直接撕掉 */
  if (!store.get('lzx_notes_cleaned_n', false)) { store.set('lzx_notes_before_cleanup_n', notes); store.set('lzx_notes_cleaned_n', true); }
  notes = notes.filter(n => !removedByNoteCleanup(n));
  store.set(NOTES_KEY, notes);
  notes.forEach(n => { if (!n.by) n.local = true; });

  /* 把服务器上的留言拉下来（所有人写的都在这儿） */
  function syncNotes() {
    if (!window.LZX_API) return;
    LZX_API.state().then(d => {
      if (!d || !d.ok || !Array.isArray(d.notes)) return;
      const remoteIds = new Set(d.notes.map(n => n.id));
      const locals = notes.filter(n => n.local && !removedByNoteCleanup(n) && !remoteIds.has(n.id));
      /* 服务器上的字段叫 name，本机用 from；样式字段缺了就按 id 推一个稳定的，
         这样即使某条留言少了样式，也不会所有人都是同一张白纸 */
      const fixed = d.notes.filter(n => !removedByNoteCleanup(n)).sort((a, b) => (b.at || 0) - (a.at || 0)).map(n => {
        const idNum = String(n.id || '').split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
        return {
          id: n.id, text: n.text,
          from: n.from || n.name || '',
          c: (typeof n.c === 'number') ? n.c : (idNum % NCOLORS.length),
          s: n.s || NSHAPES[idNum % NSHAPES.length].k,
          m: n.m || NMATS[idNum % NMATS.length].k,
          tilt: (typeof n.tilt === 'number') ? n.tilt : ((idNum % 11) - 5),
          by: n.by, at: n.at
        };
      });
      const next = fixed.concat(locals);
      /* 指纹：数据没变就不重建 DOM。轮询每 20 秒一次，
         重建会让整面便签墙闪一下，还会打断刚贴上去的那张的动画。 */
      const sig = next.map(n => n.id + '|' + n.text + '|' + n.from).join('~');
      if (sig === notesSig) return;
      notesSig = sig;
      notes = next;
      store.set(NOTES_KEY, notes);
      renderWall(null);
      renderNoteSync();
      if (window.__noteHint && notes.length) window.__noteHint.hidden = true;
    });
  }
  var notesSig = '';
  let sel = { c: 0, s: 'round', m: 'paper' };

  function noteHTML(n) {
    const body = esc(n.text).replace(/\n/g, '<br>');
    const from = n.from ? esc(n.from) : '匿名';
    return '<div class="note-body">' + body + '</div><span class="note-from">— ' + from + '</span>';
  }

  function styleNote(el, n) {
    const col = NCOLORS[n.c] || NCOLORS[0];
    /* 字数自适应：爱心 / 圆形便签的可用面积小，长文案自动降字号，避免越出轮廓 */
    const len = (n.text || '').length;
    const size = len <= 22 ? 'short' : (len <= 44 ? 'mid' : 'long');
    el.className = 'note shape-' + n.s + ' mat-' + n.m + ' len-' + size;
    el.style.setProperty('--n1', col.a);
    el.style.setProperty('--n2', col.b);
    el.title = n.text || '';
  }

  function renderPicker() {
    if (pickColor) {
      pickColor.innerHTML = NCOLORS.map((c, i) =>
        '<button class="swatch' + (i === sel.c ? ' on' : '') + '" data-i="' + i +
        '" style="background:linear-gradient(140deg,' + c.a + ',' + c.b + ')" title="颜色' + (i + 1) + '"></button>'
      ).join('');
      pickColor.onclick = e => {
        const b = e.target.closest('.swatch');
        if (!b) return;
        sel.c = Number(b.dataset.i);
        renderPicker(); renderPreview();
      };
    }
    if (pickShape) {
      pickShape.innerHTML = NSHAPES.map(s =>
        '<button class="chip' + (s.k === sel.s ? ' on' : '') + '" data-k="' + s.k + '">' + s.n + '</button>'
      ).join('');
      pickShape.onclick = e => {
        const b = e.target.closest('.chip');
        if (!b) return;
        sel.s = b.dataset.k;
        renderPicker(); renderPreview();
      };
    }
    if (pickMat) {
      pickMat.innerHTML = NMATS.map(m =>
        '<button class="chip' + (m.k === sel.m ? ' on' : '') + '" data-k="' + m.k + '">' + m.n + '</button>'
      ).join('');
      pickMat.onclick = e => {
        const b = e.target.closest('.chip');
        if (!b) return;
        sel.m = b.dataset.k;
        renderPicker(); renderPreview();
      };
    }
  }

  function renderPreview() {
    if (!notePreview) return;
    const txt = (noteText && noteText.value.trim()) || '写一句想对她说的话…';
    const from = (noteName && noteName.value.trim()) || '你的署名';
    notePreview.innerHTML = '<div class="note-preview-inner"></div>';
    const wrap = notePreview.firstChild;
    const n = document.createElement('div');
    styleNote(n, { c: sel.c, s: sel.s, m: sel.m });
    n.innerHTML = '<span class="note-pin"></span>' + noteHTML({ text: txt, from: from });
    wrap.appendChild(n);
  }

  function buildNoteCard(n, isNew) {
    const card = document.createElement('div');
    card.className = 'note-card' + (isNew ? ' is-new' : '');
    card.dataset.id = n.id;
    card.style.setProperty('--tilt', (n.tilt || 0) + 'deg');

    const isRoundish = n.s === 'heart' || n.s === 'circle';
    const usePin = isRoundish ? true : Math.random() > 0.5;

    const note = document.createElement('div');
    styleNote(note, n);
    if (usePin) note.classList.add('pin-mode');
    note.innerHTML = '<span class="note-pin"></span>' + noteHTML(n);

    card.appendChild(note);

    const del = document.createElement('button');
    del.className = 'note-del';
    del.title = '撕掉这张便签';
    del.textContent = '×';
    card.appendChild(del);
    return card;
  }

  function renderWall(newId) {
    if (!wall) return;
    wall.innerHTML = '';
    notes.filter(n => !removedByNoteCleanup(n)).forEach(n => wall.appendChild(buildNoteCard(n, n.id === newId)));
    if (emptyTip) emptyTip.hidden = notes.length > 0;
  }

  /* ---------- 留言的自动重试 ----------
     留言发失败时**不能静默丢掉**（用户会以为写好了）。
     它已经在本机存档（带 `local` 标记），这里排进队列退避重试；
     成功之后才摘掉标记、从本机存档里移除。刷新页面会重新从存档捡起来。 */
  var noteQueue = [], noteTimer = null, noteDelay = 5000;

  function queueNoteRetry(n) {
    if (noteQueue.indexOf(n) < 0) noteQueue.push(n);
    toast('便签贴上了，但还没传上去 —— 会自动重试，先别关页面 ✦');
    scheduleNoteRetry();
  }

  function scheduleNoteRetry(silent) {
    if (noteTimer || !noteQueue.length || !window.LZX_API) return;
    var silentOnce = !!silent;        /* 只对「这一次」静默 */
    noteTimer = setTimeout(function () {
      noteTimer = null;
      var item = noteQueue[0];
      if (!item) return;
      LZX_API.addNote({ text: item.text, from: item.from, name: item.from,
                        c: item.c, s: item.s, m: item.m, tilt: item.tilt })
        .then(function (d) {
          if (d && d.ok && d.note) {
            noteQueue.shift();
            item.id = d.note.id; item.by = d.note.by; item.at = d.note.at;
            item.local = true; // 保留副本，直到读取接口也确认这条记录
            delete item.pending;
            renderWall(null);
            renderNoteSync();
            store.set(NOTES_KEY, notes);
            noteDelay = 5000;
            if (!silentOnce) toast('刚才那条便签已经传上去啦 ✦');
          } else {
            noteDelay = Math.min(noteDelay * 1.8, 60000);
          }
          scheduleNoteRetry();
        }).catch(function () {
          noteDelay = Math.min(noteDelay * 1.8, 60000);
          scheduleNoteRetry();
        });
    }, noteDelay);
  }

  /* 刷新后把本机存档里「用户写了但还没传上去的」重新排进队列。
     ⚠️ 只看 `pending`，**绝不能用 `local`** —— 内置样片也带 `local`，
        拿它来筛会把示例留言也传上服务器。 */
  function resumeNoteRetries() {
    var waiting = notes.filter(function (n) { return n.pending && n.text; });
    if (!waiting.length) return;
    noteQueue = waiting;
    scheduleNoteRetry(true);      /* true = 静默重试，不弹提示（避免一刷新就跳 toast） */
  }

  function addNote() {
    const text = noteText ? noteText.value.trim() : '';
    if (!text) {
      toast('先写一句想对她说的话吧 ✎');
      if (noteText) noteText.focus();
      return;
    }
    const n = {
      id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      text: text,
      from: noteName ? noteName.value.trim() : '',
      c: sel.c,
      s: sel.s,
      m: sel.m,
      tilt: Number(rnd(-5, 5).toFixed(2)),
      /* 🔴 `local` = 进本机存档（发失败时刷新也还在）；
         `pending` = **还没上传成功**，只有用户亲手写的才有。
      ⚠️ 这两个标记**不能混用**：内置样片留言（DEFAULT_NOTES）也带 `local`，
         如果拿 `local` 当「待上传」用，会把样片也传到服务器上（我犯过这个错，
         结果留言墙上多出几条重复的示例）。 */
      local: true,
      pending: true
    };
    notes.unshift(n);
    /* 先存本机 —— 就算接下来发送失败，刷新页面它也还在，而且会一直重试 */
    const ok = store.set(NOTES_KEY, notes);
    /* 再送到服务器 —— 这样所有人打开都能看到这条祝福 */
    if (window.LZX_API) {
      LZX_API.addNote({ text: n.text, from: n.from, name: n.from, c: n.c, s: n.s, m: n.m, tilt: n.tilt })
        .then(d => {
          if (d && d.ok && d.note) {
            n.id = d.note.id;
            n.by = d.note.by;
            n.at = d.note.at;
            n.local = true;          /* 读取接口确认前保留本地副本，防止旧响应覆盖 */
            delete n.pending;
            store.set(NOTES_KEY, notes);
            renderWall(null);
            renderNoteSync();
            toast('便签已保存到服务器，其他设备刷新即可看到 ✦');
            syncNotes();
          } else {
            queueNoteRetry(n);       /* 失败 → 排队自动重试，别让它悄悄丢了 */
          }
        }).catch(function () { queueNoteRetry(n); });
    } else {
      queueNoteRetry(n);
    }
    renderWall(n.id);
    renderNoteSync();
    if (noteText) noteText.value = '';
    if (charNow) charNow.textContent = '0';
    renderPreview();
    toast(ok ? '便签已保存在本机，正在上传 ♡' : '贴上了！不过浏览器没存住（本地空间可能满了）');
    const first = wall.firstElementChild;
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function initNotes() {
    if (!wall) return;
    renderPicker();
    renderPreview();
    /* 离线兜底：把上次从服务器拉到的留言先摆出来 ——
       这样即使这一刻连不上，也能看到「大家写的」而不是一片空白。
       连上之后 syncNotes 会用服务器数据整体替换，不会重复。 */
    var cached = readCache();
    if (cached && Array.isArray(cached.notes) && cached.notes.length) {
      var have = {};
      notes.forEach(function (n) { have[n.id] = 1; });
      cached.notes.slice().reverse().forEach(function (n) {
        if (!n.id || have[n.id] || removedByNoteCleanup(n)) return;
        notes.unshift({
          id: n.id, text: n.text, from: n.from || n.name || '',
          c: (typeof n.c === 'number') ? n.c : 0,
          s: n.s || 'round', m: n.m || 'paper',
          tilt: (typeof n.tilt === 'number') ? n.tilt : 0,
          by: n.by, at: n.at
        });
      });
    }
    renderWall(null);
    window.__noteHint = emptyTip;
    /* 上次没传上去的留言（刷新前留下的），接着重试 */
    resumeNoteRetries();
    syncNotes();

    if (noteAdd) noteAdd.addEventListener('click', addNote);

    if (noteText) {
      noteText.addEventListener('input', () => {
        if (charNow) charNow.textContent = String(noteText.value.length);
        renderPreview();
      });
    }
    if (noteName) noteName.addEventListener('input', renderPreview);

    wall.addEventListener('click', e => {
      const del = e.target.closest('.note-del');
      if (!del) return;
      const card = del.closest('.note-card');
      if (!card) return;
      const id = card.dataset.id;
      const note = notes.filter(n => n.id === id)[0];
      const me = window.LZX_API ? LZX_API.visitor() : null;

      function drop() {
        notes = notes.filter(n => n.id !== id);
        store.set(NOTES_KEY, notes);
        card.style.transition = 'transform .35s, opacity .35s';
        card.style.transform = 'scale(.6) rotate(20deg)';
        card.style.opacity = '0';
        setTimeout(() => renderWall(null), 330);
        toast('便签已撕下');
      }

      /* 别人贴的便签：要么是本人（同一台浏览器）撤自己的，要么输管理口令 */
      if (!note || note.local || (note.by && note.by === me)) {
        if (note && note.by && window.LZX_API) LZX_API.removeNote(id, adminCode());
        drop();
        return;
      }
      const code = prompt('这张便签是别人贴的。\n输入管理口令可以撕掉它：', adminCode());
      if (!code) return;
      if (window.LZX_API) LZX_API.removeNote(id, code);
      drop();
    });
  }

  /* =========================================================
     5b. 涂鸦画板
     ========================================================= */
  const board    = $('#board');
  const boardHint = $('#boardHint');
  const BW = 1200, BH = 1400;            // 逻辑坐标，和显示尺寸无关
  const bdctx = board ? board.getContext('2d') : null;

  /* 已完成的笔画单独放一层，画面板时「已画好的 + 正在画的」分开合成，
     半透明笔刷才不会因为逐段重绘而出现接头加深 */
  const committed = document.createElement('canvas');
  const cctx = committed.getContext('2d');

  const BOARD_KEY = 'lzx_board';
  // 完整保留笔画，不按数量截断。
  let boardReady = !window.LZX_BOARD_STORE;
  let boardSaveVersion = 0;
  let boardSaveStatus = null;
  let boardCloudVisitor = '', boardCloudKey = '', boardCloudBusy = false, boardCloudRevision = '';
  let boardRemoved = [], boardCloudOnline = false, boardCloudTimer = null, boardCloudError = false, sharedStrokeCount = 0, boardCloudMessage = '';
  const BOARD_CLOUD = 'https://e7b4f5bca0ca45598b6b1379c930e2b3.app.workbuddy.host';

  function boardId() {
    return 's' + (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }
  function initBoardIdentity() {
    const meta = window.LZX_BOARD_STORE ? LZX_BOARD_STORE.metadata() : {};
    boardRemoved = Array.isArray(meta.removed) ? meta.removed : [];
    try { boardCloudKey = meta.key || localStorage.getItem('lzx_board_cloud_key') || ''; } catch (e) {}
    if (!boardCloudKey) {
      const bytes = new Uint8Array(32);
      if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
      boardCloudKey = Array.from(bytes).map(n => n.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('lzx_board_cloud_key', boardCloudKey); } catch (e) {}
    }
    try { boardCloudVisitor = meta.visitor || localStorage.getItem('lzx_board_cloud_visitor') || ME; } catch (e) { boardCloudVisitor = meta.visitor || ME; }
    strokes.forEach(s => {
      if (!s.id || !/^s[a-zA-Z0-9_-]{8,100}$/.test(s.id)) s.id = boardId();
      // Older brushes rendered a default seed without saving it.
      if (!Number.isFinite(s.seed)) s.seed = 1;
    });
  }
  function boardPending() { return strokes.filter(s => !s._shared); }
  function renderBoardCloud() {
    const count = boardPending().length + boardRemoved.length;
    showBoardSave(count ? '还有 ' + count + ' 笔更改待上传 · ' + (boardCloudMessage || '本机副本保留，联网后自动补传') : (boardCloudOnline ? '共有 ' + sharedStrokeCount + ' 笔共享涂鸦 · 已同步，所有访客可见' : (boardCloudError ? '共享读取暂未成功 · 本机副本保留，会自动重试' : '正在读取共享涂鸦 · 本机副本保留')), boardCloudError);
  }
  function boardRequest(path, body, timeout = 30000) {
    // XMLHttpRequest also works in older embedded browsers; always enforce a timeout.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(body ? 'POST' : 'GET', BOARD_CLOUD + path, true);
      xhr.timeout = timeout;
      if (body) xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = () => {
        let d; try { d = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) return resolve(d);
        const error = new Error(d && d.error || 'HTTP ' + xhr.status);
        error.status = xhr.status; error.code = d && d.error; reject(error);
      };
      xhr.onerror = () => reject(new Error('网络未能连接共享服务器，正在重试'));
      xhr.ontimeout = () => reject(new Error('上传超时，正在重试'));
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }
  async function writeBoardCloud(body) {
    try { return await boardRequest('/api/board', {...body, visitor:boardCloudVisitor,key:boardCloudKey}); }
    catch(e) {
      if (e.status !== 403 || e.code !== 'not-owner') throw e;
      // A browser restored its visitor ID but lost the matching key. Keep all strokes,
      // and register a separate upload identity without changing the note/candle visitor.
      boardCloudVisitor = 'v' + boardId().slice(1);
      try { localStorage.setItem('lzx_board_cloud_visitor', boardCloudVisitor); } catch(e) {}
      saveBoard(false);
      return boardRequest('/api/board', {...body, visitor:boardCloudVisitor,key:boardCloudKey});
    }
  }
  function scheduleBoardCloud() {
    if (boardCloudTimer) clearTimeout(boardCloudTimer);
    boardCloudTimer = setTimeout(syncBoardCloud, 800);
  }
  async function syncBoardCloud() {
    if (!boardReady || boardCloudBusy || document.hidden) return;
    boardCloudBusy = true;
    try {
      const pending = boardPending().filter(s => !s._retryAt || s._retryAt <= Date.now()).slice(0, 20), removed = boardRemoved.slice(0, 100);
      let uploadFailure = '';
      // One rejected legacy stroke must not block all later drawings.
      for (const s of pending) {
        try {
          const d = await writeBoardCloud({additions:[{id:s.id,t:s.t,c:s.c,w:s.w,seed:s.seed,o:s.o||'',p:s.p}],removed:[]});
          if (!(d.accepted || []).includes(s.id)) throw new Error('服务器尚未确认这笔涂鸦');
          s._shared = true; saveBoard(false);
        } catch (e) {
          uploadFailure = e.code === 'stroke' ? '一笔旧涂鸦格式不兼容，副本保留，其余继续上传' : e.message;
          if (e.status === 400 || e.status === 413) s._retryAt = Date.now() + 60000;
          if (!e.status || e.status >= 500 || e.status === 403) break;
        }
      }
      if (removed.length) {
        const d = await writeBoardCloud({additions:[],removed});
        boardRemoved = boardRemoved.filter(id => !(d.removed || []).includes(id));
        saveBoard(false);
      }
      const d = await boardRequest('/api/board?revision=' + encodeURIComponent(boardCloudRevision));
      if (!d.unchanged && Array.isArray(d.strokes) && Array.isArray(d.removed)) {
        sharedStrokeCount = d.strokes.length;
        const removedIds = new Set(d.removed.concat(boardRemoved)), remoteIds = new Set(d.strokes.map(s => s.id));
        const local = strokes.filter(s => !remoteIds.has(s.id) && !removedIds.has(s.id));
        strokes = d.strokes.filter(s => !removedIds.has(s.id)).map(s => ({...s,_shared:true})).concat(local);
        if (!boardDraw) repaintAll();
        saveBoard(false);
      }
      boardCloudRevision = d.revision || '';
      boardCloudOnline = true; boardCloudError = !!uploadFailure; boardCloudMessage = uploadFailure;
    } catch (e) { boardCloudOnline = false; boardCloudError = true; boardCloudMessage = e.message; }
    finally { boardCloudBusy = false; renderBoardCloud(); if (boardPending().length || boardRemoved.length) { if (boardCloudTimer) clearTimeout(boardCloudTimer); boardCloudTimer = setTimeout(syncBoardCloud, boardCloudOnline && !boardCloudError ? 800 : 10000); } }
  }
  function removeBoardStrokes(removed) {
    removed.forEach(s => { if (s.id && !boardRemoved.includes(s.id)) boardRemoved.push(s.id); });
  }

  const BRUSHES = [
    { k: 'pen',    n: '圆珠笔', mul: 1.0, alpha: 1,   blend: 'source-over' },
    { k: 'marker', n: '马克笔', mul: 1.9, alpha: 1,   blend: 'source-over' },
    { k: 'crayon', n: '蜡笔',   mul: 2.4, alpha: 1,   blend: 'source-over' },
    { k: 'hi',     n: '荧光笔', mul: 3.6, alpha: .32, blend: 'multiply' },
    { k: 'spray',  n: '喷枪',   mul: 2.8, alpha: 1,   blend: 'source-over' },
    { k: 'star',   n: '星星笔', mul: 3.2, alpha: .95, blend: 'source-over' },
    { k: 'heart',  n: '爱心笔', mul: 3.2, alpha: .95, blend: 'source-over' },
    { k: 'flower', n: '小花笔', mul: 3.4, alpha: .95, blend: 'source-over' },
    { k: 'eraser', n: '橡皮',   mul: 2.6, alpha: 1,   blend: 'destination-out' }
  ];

  const PEN_COLORS = [
    '#5b6ef0', '#8f79f0', '#c77ad8', '#f47bb4',
    '#ef6a6a', '#f0a72c', '#3fbf9a', '#3fa2ef',
    '#6b5f96', '#2f2a52'
  ];

  let strokes = store.get(BOARD_KEY, null);
  if (!Array.isArray(strokes)) strokes = [];

  /* 每台设备/浏览器一个固定访客编号，用来区分「我画的」和「别人之前画的」。
     只有带自己编号的笔画才会被「撤销 / 清空我的」动到。 */
  const VISITOR_KEY = 'lzx_visitor';
  function visitorId() {
    let v = null;
    try { v = localStorage.getItem(VISITOR_KEY); } catch (e) {}
    if (!v) {
      v = 'v' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem(VISITOR_KEY, v); } catch (e) {}
    }
    return v;
  }
  const ME = visitorId();
  /* 没有 o 字段的是本次改版之前留下的笔画，一律当成「别人画的」保护起来 */
  const isMine = s => !!s && s.o === ME;
  const myStrokeCount = () => strokes.filter(isMine).length;

  let curBrush = 'pen';
  let curColor = PEN_COLORS[0];
  let curSize = 8;
  let boardDraw = false;
  let liveStroke = null;
  let boardSeed = 1;

  function brushOf(k) {
    for (let i = 0; i < BRUSHES.length; i++) if (BRUSHES[i].k === k) return BRUSHES[i];
    return BRUSHES[0];
  }

  /* 固定种子的随机数，保证同一笔回放出来和画的时候一模一样 */
  function rngSeed(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function stampShape(ctx, kind, x, y, r, rot, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = color;
    if (kind === 'star') {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = (i % 2) ? r * 0.45 : r;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    } else if (kind === 'heart') {
      const k = r / 16;
      ctx.scale(k, k);
      ctx.beginPath();
      ctx.moveTo(0, 13);
      ctx.bezierCurveTo(-19, -1, -15, -19, -6, -14);
      ctx.bezierCurveTo(-2, -12, 0, -6, 0, -4);
      ctx.bezierCurveTo(0, -6, 2, -12, 6, -14);
      ctx.bezierCurveTo(15, -19, 19, -1, 0, 13);
      ctx.closePath(); ctx.fill();
    } else if (kind === 'flower') {
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55,
                    r * 0.44, r * 0.30, a, 0, 6.2832);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = '#ffd166';
      ctx.arc(0, 0, r * 0.30, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function paintStroke(ctx, s) {
    const b = brushOf(s.t);
    const p = s.p;
    if (!p || p.length < 2) return;

    ctx.save();
    ctx.globalCompositeOperation = b.blend;
    ctx.globalAlpha = b.alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const w = Math.max(1, s.w * b.mul);

    if (s.t === 'crayon') {
      ctx.fillStyle = s.c;
      for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.round(len / (w * 0.3)));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const r1 = rngSeed(s.seed + i * 131 + k * 17);
          ctx.globalAlpha = 0.09 + r1() * 0.15;
          ctx.beginPath();
          ctx.arc(x0 + (x1 - x0) * t + (r1() - 0.5) * w * 0.6,
                  y0 + (y1 - y0) * t + (r1() - 0.5) * w * 0.6,
                  w * 0.33, 0, 6.2832);
          ctx.fill();
        }
      }
    } else if (s.t === 'spray') {
      ctx.fillStyle = s.c;
      for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.round(len / (w * 0.22)));
        const r1 = rngSeed(s.seed + i * 977);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
          for (let q = 0; q < 10; q++) {
            const ang = r1() * 6.2832;
            const rad = Math.sqrt(r1()) * w * 0.62;
            ctx.globalAlpha = 0.06 + r1() * 0.30;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad,
                    0.8 + r1() * 1.5, 0, 6.2832);
            ctx.fill();
          }
        }
      }
    } else if (s.t === 'star' || s.t === 'heart' || s.t === 'flower') {
      /* 涂鸦笔：沿着轨迹按固定间距盖印章，位置由种子决定，回放一致 */
      const sp = Math.max(16, s.w * b.mul);
      let acc = 0, idx = 0;
      for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
        const seg = Math.hypot(x1 - x0, y1 - y0);
        if (seg <= 0) continue;
        let travelled = 0;
        while (travelled < seg) {
          const need = sp - acc;
          if (travelled + need <= seg) {
            travelled += need;
            const t = travelled / seg;
            const r1 = rngSeed(s.seed + idx * 7919);
            const jitter = (r1() - 0.5) * sp * 0.7;
            const nx = -(y1 - y0) / seg, ny = (x1 - x0) / seg;
            stampShape(ctx, s.t,
                       x0 + (x1 - x0) * t + nx * jitter,
                       y0 + (y1 - y0) * t + ny * jitter,
                       sp * (0.30 + r1() * 0.16),
                       (r1() - 0.5) * 1.6,
                       s.c);
            idx++; acc = 0;
          } else {
            acc += seg - travelled;
            travelled = seg;
          }
        }
      }
    } else {
      /* 圆珠笔 / 马克笔 / 荧光笔 / 橡皮：整笔一条路径，笔迹均匀 */
      ctx.strokeStyle = s.t === 'eraser' ? '#000' : s.c;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) {
        if (i === 2) ctx.lineTo(p[i], p[i + 1]);
        else {
          /* 用二次曲线把折线抹圆，线条更顺 */
          const mx = (p[i - 2] + p[i]) / 2, my = (p[i - 1] + p[i + 1]) / 2;
          ctx.quadraticCurveTo(p[i - 2], p[i - 1], mx, my);
        }
      }
      const n = p.length;
      ctx.lineTo(p[n - 2], p[n - 1]);
      ctx.stroke();
    }

    ctx.restore();
  }

  function sizeBoard() {
    if (!board || !bdctx) return;
    board.style.setProperty('--board-ar', BW + ' / ' + BH);
    const cssW = board.clientWidth || 900;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    /* 位图宽高严格按 BW:BH 生成，和 CSS 的 aspect-ratio 一致，
       x/y 缩放系数相同，画圆才是正圆 */
    const pxW = Math.max(240, Math.round(cssW * dpr));
    const pxH = Math.round(pxW * BH / BW);
    if (board.width === pxW && board.height === pxH) return;
    board.width = pxW; board.height = pxH;
    committed.width = pxW; committed.height = pxH;
    const k = pxW / BW;
    bdctx.setTransform(k, 0, 0, k, 0, 0);
    cctx.setTransform(k, 0, 0, k, 0, 0);
    repaintAll();
  }

  function blit() {
    if (!bdctx) return;
    bdctx.save();
    bdctx.setTransform(1, 0, 0, 1, 0, 0);
    bdctx.clearRect(0, 0, board.width, board.height);
    bdctx.drawImage(committed, 0, 0);
    bdctx.restore();
  }

  /* 把所有笔画重画一遍（撤销 / 清空 / 尺寸变化时用） */
  function repaintAll() {
    if (!cctx) return;
    cctx.save();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, committed.width, committed.height);
    cctx.restore();
    for (let i = 0; i < strokes.length; i++) paintStroke(cctx, strokes[i]);
    blit();
    if (boardHint) boardHint.hidden = strokes.length > 0;
  }

  function showLive() {
    blit();
    if (liveStroke) paintStroke(bdctx, liveStroke);
  }

  function showBoardSave(text, warn) {
    if (!boardSaveStatus) return;
    boardSaveStatus.textContent = text;
    boardSaveStatus.classList.toggle('warn', !!warn);
  }

  function saveBoard(sync = true) {
    const version = ++boardSaveVersion;
    showBoardSave('正在保存涂鸦…');
    if (window.LZX_BOARD_STORE) {
      LZX_BOARD_STORE.save(strokes, {key:boardCloudKey,visitor:boardCloudVisitor,removed:boardRemoved.slice()}).then(result => {
        if (version !== boardSaveVersion) return;
        if (result.ok) renderBoardCloud(); else showBoardSave('本机保存空间不可用，正在尝试共享保存；请用「保存图片」另存备份', true);
      });
    } else {
      try { localStorage.setItem(BOARD_KEY, JSON.stringify(strokes)); showBoardSave('涂鸦已保存在此浏览器'); }
      catch (e) { showBoardSave('保存空间不可用，请先用「保存图片」备份；当前画面仍保留', true); }
    }
    if (sync) scheduleBoardCloud();
  }

  function localPos(e) {
    const r = board.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width) * BW, 0, BW),
      y: clamp((e.clientY - r.top) / Math.max(1, r.height) * BH, 0, BH)
    };
  }

  function pushPoint(s, x, y) {
    const p = s.p;
    const n = p.length;
    if (n >= 2) {
      const dx = x - p[n - 2], dy = y - p[n - 1];
      if (dx * dx + dy * dy < 6.25) return false;      // 2.5px 以内不记
    }
    p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    return true;
  }

  function renderBrushUI() {
    const list = $('#brushList');
    if (list) {
      list.innerHTML = BRUSHES.map(b =>
        '<button class="chip' + (b.k === curBrush ? ' on' : '') + '" data-k="' + b.k +
        '" type="button">' + b.n + '</button>').join('');
      list.onclick = e => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        curBrush = btn.dataset.k;
        renderBrushUI();
      };
    }
    const cols = $('#penColors');
    if (cols) {
      cols.innerHTML = PEN_COLORS.map(c =>
        '<button class="swatch' + (c === curColor ? ' on' : '') + '" data-c="' + c +
        '" type="button" title="' + c + '" style="background:' + c + '"></button>').join('');
      cols.onclick = e => {
        const btn = e.target.closest('.swatch');
        if (!btn) return;
        curColor = btn.dataset.c;
        renderBrushUI();
      };
    }
  }

  function initBoard() {
    if (!board || !bdctx) return;

    boardSaveStatus = document.createElement('p');
    boardSaveStatus.className = 'board-save-status';
    boardSaveStatus.setAttribute('role', 'status');
    boardSaveStatus.id = 'boardSaveStatus';
    board.closest('.board').appendChild(boardSaveStatus);
    const refreshBoard = document.createElement('button');
    refreshBoard.type = 'button'; refreshBoard.className = 'ctrl-btn'; refreshBoard.textContent = '重新同步涂鸦';
    refreshBoard.addEventListener('click', () => { boardCloudRevision = ''; syncBoardCloud(); });
    board.closest('.board').appendChild(refreshBoard);
    showBoardSave('正在恢复已保存的涂鸦…');
    if (window.LZX_BOARD_STORE) {
      LZX_BOARD_STORE.load().then(saved => {
        strokes = saved;
        initBoardIdentity();
        boardReady = true;
        repaintAll();
        saveBoard();
        syncBoardCloud();
      }).catch(() => { initBoardIdentity(); boardReady = true; saveBoard(); syncBoardCloud(); });
    } else { initBoardIdentity(); boardReady = true; saveBoard(); syncBoardCloud(); }
    renderBrushUI();

    const sizeEl = $('#penSize');
    const sizeNow = $('#sizeNow');
    if (sizeEl) {
      sizeEl.value = String(curSize);
      sizeEl.addEventListener('input', () => {
        curSize = Number(sizeEl.value) || 8;
        if (sizeNow) sizeNow.textContent = String(curSize);
      });
    }

    const undo = $('#drawUndo');
    if (undo) {
      undo.addEventListener('click', () => {
        if (!boardReady) return;
        if (!strokes.length) { toast('还没有画东西呢～'); return; }
        let mineIndex = strokes.length - 1;
        while (mineIndex >= 0 && !isMine(strokes[mineIndex])) mineIndex--;
        if (mineIndex < 0) {
          toast('只能撤销自己画的哦～');
          return;
        }
        removeBoardStrokes([strokes[mineIndex]]);
        strokes.splice(mineIndex, 1);
        saveBoard();
        repaintAll();
      });
    }

    const clear = $('#drawClear');
    if (clear) {
      clear.addEventListener('click', () => {
        if (!boardReady) return;
        const mine = myStrokeCount();
        if (!strokes.length) { toast('画布已经是空的啦'); return; }
        if (!mine) { toast('你没有画过东西，别人的笔迹不能清哦～'); return; }
        const others = strokes.length - mine;
        const ask = others > 0
          ? '只清掉你画的 ' + mine + ' 笔，别人画的 ' + others + ' 笔会保留。确定吗？'
          : '确定要把你画的 ' + mine + ' 笔清空吗？清掉就找不回来了。';
        if (!window.confirm(ask)) return;
        removeBoardStrokes(strokes.filter(isMine));
        strokes = strokes.filter(s => !isMine(s));
        saveBoard();
        repaintAll();
        toast(others > 0 ? '你画的部分已清掉，别人画的还在 ✎' : '画布已清空，重新开始吧 ✎');
      });
    }

    const saveBtn = $('#drawSave');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const out = document.createElement('canvas');
        out.width = BW; out.height = BH;
        const octx = out.getContext('2d');
        octx.fillStyle = '#f7f6ff';
        octx.fillRect(0, 0, BW, BH);
        octx.drawImage(committed, 0, 0, BW, BH);
        const a = document.createElement('a');
        a.download = 'lizhixian1011-doodle.png';
        a.href = out.toDataURL('image/png');
        a.click();
        toast('图片已保存 ✎');
      });
    }

    function beginBoardStroke(e) {
      if (!boardReady) { toast('正在恢复涂鸦，请稍候'); return; }
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      boardDraw = true;
      try { board.setPointerCapture(e.pointerId); } catch (err) {}
      const pt = localPos(e);
      boardSeed = (boardSeed * 31 + Math.floor(Math.random() * 100000) + 7) % 2147483647;
      liveStroke = { t: curBrush, c: curColor, w: curSize, seed: boardSeed, o: ME, p: [pt.x, pt.y] };
      if (curBrush === 'eraser') {
        paintStroke(cctx, liveStroke);
        blit();
      } else {
        showLive();
      }
      e.preventDefault();
    }

    function moveBoardStroke(e) {
      if (!boardDraw || !liveStroke) return;
      const pt = localPos(e);
      if (!pushPoint(liveStroke, pt.x, pt.y)) return;
      if (curBrush === 'eraser') {
        /* 橡皮直接作用在已完成那层，重复擦同一条路径是幂等的 */
        paintStroke(cctx, liveStroke);
        blit();
      } else {
        showLive();
      }
      e.preventDefault();
    }

    function endStroke(e) {
      if (!boardDraw) return;
      boardDraw = false;
      if (liveStroke) {
        if (liveStroke.t !== 'eraser') paintStroke(cctx, liveStroke);
        liveStroke.id = boardId();
        strokes.push(liveStroke);
        saveBoard();
        liveStroke = null;
        repaintAll();
        if (boardHint) boardHint.hidden = strokes.length > 0;
      }
      if (e && e.preventDefault) e.preventDefault();
    }

    window.addEventListener('pagehide', () => endStroke());
    document.addEventListener('visibilitychange', () => { if (document.hidden) endStroke(); });
    if (window.PointerEvent) {
      board.addEventListener('pointerdown', beginBoardStroke);
      board.addEventListener('pointermove', moveBoardStroke);
      board.addEventListener('pointerup', endStroke);
      board.addEventListener('pointercancel', endStroke);
      board.addEventListener('pointerleave', e => { if (boardDraw) endStroke(e); });
    } else {
      function touch(e, action) {
        const point = e.touches[0] || e.changedTouches[0];
        if (point) action({clientX:point.clientX,clientY:point.clientY,preventDefault:()=>e.preventDefault()});
      }
      board.addEventListener('touchstart', e => touch(e, beginBoardStroke), {passive:false});
      board.addEventListener('touchmove', e => touch(e, moveBoardStroke), {passive:false});
      board.addEventListener('touchend', endStroke, {passive:false});
      board.addEventListener('touchcancel', endStroke, {passive:false});
      board.addEventListener('mousedown', beginBoardStroke);
      board.addEventListener('mousemove', moveBoardStroke);
      window.addEventListener('mouseup', endStroke);
    }

    sizeBoard();
    setInterval(syncBoardCloud, 10000);
    window.addEventListener('online', syncBoardCloud);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncBoardCloud(); });
  }

  /* =========================================================
     6. 贴纸彩蛋
     ========================================================= */
  const STICKER_LINES = [
    '文文说：生日快乐！🐱',
    '她也喜欢这首歌吗？🎵',
    '偷偷替她收下一份祝福 ♡',
    '猫猫耳朵竖起来啦 ✧',
    '今天的主角只有一个 🎂'
  ];

  function initStickers() {
    $$('[data-sticker]').forEach(st => {
      st.addEventListener('click', e => {
        st.classList.remove('pop');
        void st.offsetWidth;
        st.classList.add('pop');
        const r = st.getBoundingClientRect();
        const sc = stage ? stage.getBoundingClientRect() : null;
        if (fxLayer && sc) {
          const cx = ((r.left + r.width / 2 - sc.left) / sc.width) * 100;
          const cy = ((r.top + r.height / 2 - sc.top) / sc.height) * 100;
          if (cx > 2 && cx < 98 && cy > 2 && cy < 98) burst(7, cx, cy);
        }
        toast(pick(STICKER_LINES));
      });
    });
  }

  /* =========================================================
     7. 滚动进场
     ========================================================= */
  function initReveal() {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(el => io.observe(el));
  }

  /* =========================================================
     8. 主循环 & 初始化
     ========================================================= */
  let last = performance.now();
  let bgTick = 0;

  let cakeVisible = true, slidesVisible = true;

  function initAnimationVisibility() {
    if (!window.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const visible = entry.isIntersecting;
        entry.target.classList.toggle('motion-paused', !visible);
        if (entry.target.id === 'cake') cakeVisible = visible;
        if (entry.target.id === 'memory') slidesVisible = visible;
      });
    }, { rootMargin: '120px' });
    $$('.hero, .section').forEach(el => observer.observe(el));
  }

  function loop(now) {
    if (document.hidden) { last = now; requestAnimationFrame(loop); return; }
    // 手机上整个绘制循环限制到 30fps，旋转仍按真实时间推进。
    if (PERF.mobile && now - last < 1000 / 30) { requestAnimationFrame(loop); return; }
    const dt = Math.min(80, now - last);
    last = now;
    bgTick += dt;
    if (bgTick > PERF.bgMs) { bgDraw(now); bgTick = 0; }
    if (fwOn) fwDraw(now);
    if (cakeVisible) tickCake(dt);
    if (slidesVisible) tickSlides(dt);
    requestAnimationFrame(loop);
  }

  let resizeTimer = 0, layoutWidth = window.innerWidth;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      bgResize();
      fwResize();
      // 微信/手机地址栏收起会反复改变高度，只有宽度变化才重排蛋糕和画板。
      if (window.innerWidth !== layoutWidth) {
        layoutWidth = window.innerWidth;
        calcScale();
        applySpin();
        if (typeof sizeBoard === 'function') sizeBoard();
      }
    }, PERF.mobile ? 180 : 80);
  }

  /* =========================================================
     0b. 开始页：点一下 → 起音乐 + 放 5 秒烟花 → 淡出进主页
     ========================================================= */
  function syncBgmBtn() {
    const b = $('#bgmBtn');
    if (!b || !window.LZX_BGM) return;
    const on = window.LZX_BGM.isPlaying();
    b.classList.toggle('playing', on);
    b.classList.toggle('muted', !on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? '关闭背景音乐' : '打开背景音乐');
  }

  function initGate() {
    const gate = $('#gate');
    const btn = $('#gateBtn');
    const bgmBtn = $('#bgmBtn');
    const veil = $('#fireVeil');
    if (!gate) { playFireworks(); return; }

    document.body.classList.add('gate-lock');
    window.scrollTo(0, 0);

    let entered = false;
    function enter() {
      if (entered) return;
      entered = true;

      /* 必须在这次点击里碰音频，否则浏览器不让出声。
         arm() 先解锁（烟花音效要用），音乐则看用户上次有没有主动关掉。 */
      if (window.LZX_BGM) {
        if (window.LZX_BGM.arm) window.LZX_BGM.arm();
        if (window.LZX_BGM.enabled()) window.LZX_BGM.start();
      }
      syncBgmBtn();
      if (bgmBtn) {
        bgmBtn.hidden = false;
        requestAnimationFrame(() => bgmBtn.classList.add('show'));
      }

      window.scrollTo(0, 0);

      /* ① 开始页淡出的同时，整屏黑幕渐入 —— 先暗下来 */
      gate.classList.add('gone');
      document.body.classList.remove('gate-lock');
      if (veil) veil.classList.add('on');

      /* ② 等黑幕铺满（约 .55s），再在黑底上放全屏烟花，
            这样烟花才够亮、不会被浅色的页面底冲淡 */
      setTimeout(() => {
        gate.style.display = 'none';
        playFireworks(FW_SHOW, FW_FADE);
        /* ③ 烟花开始渐隐的同一时刻，黑幕跟着退，页面自然浮现 */
        setTimeout(() => {
          if (veil) veil.classList.remove('on');
        }, FW_SHOW);
      }, 560);
    }

    if (btn) btn.addEventListener('click', enter);
    /* 点到空白也算，别让人找不到入口 */
    gate.addEventListener('click', e => { if (e.target === gate) enter(); });
    document.addEventListener('keydown', e => {
      if (!entered && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) enter();
    });
  }

  function initBgmBtn() {
    const b = $('#bgmBtn');
    if (!b || !window.LZX_BGM) return;
    b.addEventListener('click', () => {
      window.LZX_BGM.toggle();
      syncBgmBtn();
    });
    window.LZX_BGM.onChange(syncBgmBtn);
    syncBgmBtn();
  }

  /* =========================================================
     统一同步：让「大家的东西」自己长出来
     ---------------------------------------------------------
     ⚠️ 旧版三处同步（蜡烛 / 蛋糕装饰 / 便签）都**只在打开页面时拉一次**，
        之后永不刷新 —— 于是「别人写的便签，我这边得重新打开页面才能看到」。
     现在改成轮询：每 20 秒一次（页面切到后台就停，省电省流量），
     另外在「回到前台」「网络恢复」「第一次连上服务器」这三个时点各补一次。
     （三处同步里调的 state() 会被 api.js 合并成一次网络请求，不会打三个。）
     ========================================================= */
  var SYNC_MS = 10000;
  var syncTimer = null;

  /* 最近一次从服务器拿到的数据，存在本机。
     🔴 这是**离线兜底**：用户报「另一台设备打开蜡烛变 0」——
        真实原因是那一刻没连上服务器，于是大数字显示 0，看着像数据丢了。
        有了这份缓存，刚打开（还没连上）时先把**上次看到的值**摆出来，
        连上之后再被真实数据覆盖。 */
  var LAST_KEY = 'lzx_last_state';

  function cacheState(d) {
    if (!d || !d.ok) return;
    try {
      store.set(LAST_KEY, {
        candles: d.candles || 0,
        hosts: d.hosts || 0,
        notes: d.notes || [],
        at: Date.now()
      });
    } catch (e) { /* 存档失败无所谓，不影响主流程 */ }
  }

  function readCache() {
    try { return store.get(LAST_KEY, null); } catch (e) { return null; }
  }

  function syncAll() {
    if (!window.LZX_API || document.hidden) return;
    LZX_API.state().then(d => {
      if (d && d.ok) { cacheState(d); lastSharedAt = Date.now(); }
      renderNoteSync();
    });
    syncCandles();
    syncDecos();
    syncNotes();
  }

  let noteSyncHint = null;
  let lastSharedAt = 0;
  function renderNoteSync() {
    if (!noteSyncHint) return;
    const pending = notes.filter(n => n.pending).length;
    const count = notes.filter(n => n.by && !n.pending).length;
    const status = window.LZX_API ? LZX_API.isOnline() : false;
    if (status === true && lastSharedAt) {
      noteSyncHint.textContent = '已读取 ' + count + ' 条共享便签 · ' +
        new Date(lastSharedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 同步';
    } else if (status === false) {
      noteSyncHint.textContent = '暂时未能读取服务器记录，显示本机副本；正在重试。' +
        ((window.LZX_API && LZX_API.lastError()) ? '（' + LZX_API.lastError() + '）' : '');
    } else noteSyncHint.textContent = '正在读取大家的便签…';
    if (pending) noteSyncHint.textContent += ' · 本机还有 ' + pending + ' 条待上传';
  }

  function initSharedControls() {
    const section = $('#notes');
    if (section) {
      const controls = document.createElement('div');
      controls.className = 'shared-controls';
      noteSyncHint = document.createElement('p');
      noteSyncHint.id = 'noteSyncStatus';
      noteSyncHint.setAttribute('role', 'status');
      controls.appendChild(noteSyncHint);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-light';
      button.textContent = '重新同步';
      button.addEventListener('click', () => {
        if (window.LZX_API) LZX_API.retryNow();
        syncAll(); pushCandles(); scheduleNoteRetry(true);
      });
      controls.appendChild(button);
      const view = document.createElement('a');
      view.href = '#noteWall';
      view.className = 'btn btn-light';
      view.textContent = '查看便签';
      controls.appendChild(view);
      section.insertBefore(controls, section.querySelector('.note-editor') || wall);
    }
    renderNoteSync();
  }

  function startSync() {
    /* 先把上次缓存的值摆出来（避免「刚打开还没连上」时数字是 0） */
    var last = readCache();
    if (last && typeof last.candles === 'number') {
      if (last.candles > gCandles) gCandles = last.candles;
      if ((last.hosts || 0) > gHosts) gHosts = last.hosts;
      restoreSharedLights();
      renderCount(false);
      renderShared();
    }
    syncAll();
    /* 数据服务恢复的一刻，把落下的数据补上（api.js 重试成功时会通知这里） */
    if (window.LZX_API && LZX_API.onStatus) {
      LZX_API.onStatus(function (st) {
        if (st === true) { syncAll(); pushCandles(); scheduleNoteRetry(true); }
        renderShared();
        renderNoteSync();
      });
    }
    if (syncTimer) return;
    syncTimer = setInterval(syncAll, SYNC_MS);

    /* 回到前台：立刻拉一次（手机上切来切去最容易错过别人的更新） */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) syncAll();
    });
    /* 网络恢复：立刻拉一次 */
    window.addEventListener('online', function () { syncAll(); pushCandles(); scheduleNoteRetry(true); });
  }

  function init() {
    // 旧版 WebKit 的缩放手势也显式阻止；普通滚动和按钮点击保持可用。
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(name => document.addEventListener(name, e => e.preventDefault(), { passive: false }));
    document.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', e => e.preventDefault());
    buildTitle();
    bgResize();
    initGate();
    initBgmBtn();
    initCake();
    initWish();
    initDiy();
    initSlides();
    initNotes();
    initBoard();
    initStickers();
    initReveal();
    initAnimationVisibility();
    initSharedControls();
    requestAnimationFrame(loop);
    window.addEventListener('resize', onResize, { passive: true });

    if (lightBtn && litCount === 0) lightBtn.classList.add('breathe');

    /* 打开页面就把「大家的共同记忆」接上，并且**持续**保持同步 */
    startSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
