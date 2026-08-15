// ============================================================
// assessment.js · 颈部健康评估闸门(ES module)
// ------------------------------------------------------------
// 进关卡前的准入闸门:红旗问卷 → 颈部6向ROM采集 → POST /api/screen →
//   gate=pass 才放行;gate=refer 提示线下评估、不进游戏。
//
// 用法(zone.html 里,非 module 脚本可通过 window.runAssessment 调用):
//   import { runAssessment } from './js/assessment.js';
//   window.runAssessment = runAssessment;
//   // 点关卡时: const r = await window.runAssessment('neck');
//   //          if (r.pass) location.href = targetUrl;  (r.flow/r.baseline 已存 sessionStorage)
//
// 降级铁律:后端挂/超时/无摄像头/用户跳过 → 返回 {pass:true, degradedःtrue},不阻断进关卡。
// 隐私红线:只把角度数值+问卷答案发后端,绝不发画面。
// ============================================================

import { createPoseKernel } from './pose-kernel.js';
import { recordAssessment, getTodayFatigue, saveTodayFatigue } from './health-store.js';

// 颈部红旗项(命中任一 → 转介线下,不进游戏)
const RED_FLAGS_NECK = [
  '近期有过头颈部外伤',
  '症状进行性加重、很剧烈',
  '手脚发麻无力 / 动作变笨',
  '走路不稳 / 踩棉花感',
  '吞咽或呼吸有困难',
  '大小便功能近期有新变化',
];

// 颈部6向ROM采集顺序(FaceLandmarker 能测的方向)。axis+dir 决定读 rel 的哪个分量、哪个符号。
// target:达标目标角(和后端 NECK_TARGET_ROM 对齐,仅用于前端进度条,判定以后端为准)。
const ROM_STEPS = [
  { key: 'rotationL', name: '向左转头', axis: 'yaw',   sign: -1, target: 60, emoji: '👈' },
  { key: 'rotationR', name: '向右转头', axis: 'yaw',   sign: +1, target: 60, emoji: '👉' },
  { key: 'flexion',   name: '低头',     axis: 'pitch', sign: +1, target: 40, emoji: '⬇️' },
  { key: 'extension', name: '抬头',     axis: 'pitch', sign: -1, target: 30, emoji: '⬆️' },
  { key: 'lateralL',  name: '左耳靠左肩', axis: 'roll', sign: -1, target: 35, emoji: '↙️' },
  { key: 'lateralR',  name: '右耳靠右肩', axis: 'roll', sign: +1, target: 35, emoji: '↘️' },
];

const HOLD_TO_CONFIRM_MS = 800;   // 转到位后保持这么久算完成该向(慢而稳,不甩)

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return; styleInjected = true;
  const css = `
  .asmt-mask{position:fixed;inset:0;z-index:9999;background:rgba(12,14,24,.78);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:var(--font,"PingFang SC",sans-serif);}
  .asmt-card{width:min(92vw,440px);background:#fff;border-radius:22px;padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center;max-height:90vh;overflow:auto;}
  .asmt-kicker{font-size:12px;font-weight:700;letter-spacing:1px;color:#00A3FF;background:#E1F2FF;display:inline-block;padding:4px 12px;border-radius:999px;margin-bottom:14px;}
  .asmt-title{font-size:20px;font-weight:800;color:#0A0A0F;margin-bottom:8px;}
  .asmt-desc{font-size:14px;color:#6B6B7A;line-height:1.6;margin-bottom:18px;}
  .asmt-q{text-align:left;margin:12px 0;padding:12px 14px;border:1px solid rgba(10,10,15,.08);border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;}
  .asmt-q-txt{font-size:14px;color:#3A3A45;flex:1;}
  .asmt-yn{display:flex;gap:6px;flex-shrink:0;}
  .asmt-yn button{border:1px solid rgba(10,10,15,.15);background:#fff;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;color:#6B6B7A;font-family:inherit;}
  .asmt-yn button.on-yes{background:#FF6B4A;color:#fff;border-color:#FF6B4A;}
  .asmt-yn button.on-no{background:#4CAF88;color:#fff;border-color:#4CAF88;}
  .asmt-btn{margin-top:18px;width:100%;border:none;border-radius:999px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;background:#0A0A0F;color:#fff;font-family:inherit;transition:filter .15s;}
  .asmt-btn:hover{filter:brightness(1.15);} .asmt-btn:disabled{opacity:.4;cursor:not-allowed;}
  .asmt-btn.ghost{background:#F5F5F7;color:#6B6B7A;margin-top:8px;}
  .asmt-cam{position:relative;width:200px;height:150px;margin:0 auto 14px;border-radius:16px;overflow:hidden;background:#000;}
  .asmt-cam video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);}
  .asmt-step-big{font-size:40px;margin-bottom:6px;}
  .asmt-bar{height:10px;border-radius:999px;background:#EDEDF0;overflow:hidden;margin:14px 0 6px;}
  .asmt-bar-fill{height:100%;background:linear-gradient(90deg,#00A3FF,#4CAF88);width:0%;transition:width .1s;}
  .asmt-progress{font-size:12px;color:#A8A8B3;}
  .asmt-refer{color:#FF6B4A;font-weight:700;}
  `;
  const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
}

function mask() {
  const m = document.createElement('div'); m.className = 'asmt-mask';
  const c = document.createElement('div'); c.className = 'asmt-card';
  m.appendChild(c); document.body.appendChild(m);
  return { m, c, close: () => m.remove() };
}

// ——— 第 0 步:AI 问诊(调 /api/intro,问题每次不同)———
// 返回答案对象 {feel, goal, ...};拿不到问题(后端挂)→返回 {},静默跳过。
function introStep(c) {
  return new Promise(async resolve => {
    let data = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('/api/intro', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: {} }), signal: ctrl.signal,
      });
      clearTimeout(timer);
      data = await res.json();
    } catch (e) { data = null; }
    if (!data || data.degraded || !data.questions || !data.questions.length) { resolve({}); return; }

    const answers = {};
    c.innerHTML = `
      <div class="asmt-kicker">AI 问诊 · Joy</div>
      <div class="asmt-title">${data.greeting || '先聊两句~'}</div>
      <div id="asmtIntroQs"></div>
      <button class="asmt-btn" id="asmtIntroNext" disabled>下一步 →</button>
    `;
    const box = c.querySelector('#asmtIntroQs');
    data.questions.forEach(q => {
      const wrap = document.createElement('div'); wrap.style.margin = '14px 0';
      wrap.innerHTML = `<div style="text-align:left;font-size:14px;font-weight:700;color:#3A3A45;margin-bottom:8px;">${q.q}</div>`;
      const opts = document.createElement('div'); opts.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';
      (q.options || []).forEach(opt => {
        const b = document.createElement('button');
        b.textContent = opt;
        b.style.cssText = 'padding:8px 16px;border-radius:20px;border:1px solid rgba(10,10,15,.15);background:#fff;font-size:13px;font-weight:600;cursor:pointer;color:#3A3A45;font-family:inherit;';
        b.addEventListener('click', () => {
          answers[q.id] = opt;
          opts.querySelectorAll('button').forEach(x => { x.style.background = '#fff'; x.style.color = '#3A3A45'; x.style.borderColor = 'rgba(10,10,15,.15)'; });
          b.style.background = '#00A3FF'; b.style.color = '#fff'; b.style.borderColor = '#00A3FF';
          c.querySelector('#asmtIntroNext').disabled = Object.keys(answers).length < data.questions.length;
        });
        opts.appendChild(b);
      });
      wrap.appendChild(opts); box.appendChild(wrap);
    });
    c.querySelector('#asmtIntroNext').addEventListener('click', () => resolve(answers));
  });
}

// ——— 疲劳度视觉:环形分数 + 因素 ———
const FATIGUE_META = {
  high: { label: '偏疲劳', color: '#FF6B4A', tip: '今天身体信号偏累,建议低强度、慢节奏,量力而行。' },
  mid:  { label: '略疲劳', color: '#FFA726', tip: '有点小疲劳,适度活动开、别太猛,做完记得回中立位。' },
  low:  { label: '状态不错', color: '#4CAF88', tip: '今天状态挺好,正常练即可,注意慢而稳。' },
};
function fatigueGauge(score, level) {
  const meta = FATIGUE_META[level] || FATIGUE_META.mid;
  const R = 46, C = 2 * Math.PI * R, off = C * (1 - score / 100);
  return `
    <div style="position:relative;width:132px;height:132px;margin:6px auto 14px;">
      <svg width="132" height="132" style="transform:rotate(-90deg);">
        <circle cx="66" cy="66" r="${R}" fill="none" stroke="#EDEDF0" stroke-width="10"/>
        <circle cx="66" cy="66" r="${R}" fill="none" stroke="${meta.color}" stroke-width="10"
          stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <div style="font-size:34px;font-weight:900;color:${meta.color};line-height:1;">${score}</div>
        <div style="font-size:12px;color:#6B6B7A;margin-top:2px;">疲劳度</div>
      </div>
    </div>`;
}
function fatigueFactorsHtml(factors) {
  if (!factors || !factors.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:6px;">${
    factors.map(f => `<span style="font-size:12px;color:#6B6B7A;background:#F5F5F7;padding:4px 10px;border-radius:100px;">${f}</span>`).join('')}</div>`;
}

// 首次问诊后:展示今日疲劳度结果
function fatigueResultStep(c, fat, isRecap) {
  return new Promise(resolve => {
    const meta = FATIGUE_META[fat.level] || FATIGUE_META.mid;
    c.innerHTML = `
      <div class="asmt-kicker">AI 问诊 · Joy</div>
      <div class="asmt-title">今日疲劳度</div>
      ${fatigueGauge(fat.score, fat.level)}
      <div style="font-size:15px;font-weight:800;color:${meta.color};margin-bottom:10px;">${meta.label}</div>
      ${fatigueFactorsHtml(fat.factors)}
      <div class="asmt-desc">${meta.tip}</div>
      <button class="asmt-btn" id="asmtFatNext">继续 →</button>
    `;
    c.querySelector('#asmtFatNext').addEventListener('click', () => resolve());
  });
}

// 当天已测过:回顾今日疲劳度(不重复问诊)
function fatigueRecapStep(c, fat) {
  return new Promise(resolve => {
    const meta = FATIGUE_META[fat.level] || FATIGUE_META.mid;
    c.innerHTML = `
      <div class="asmt-kicker">今日已问诊 · Joy</div>
      <div class="asmt-title">今天的疲劳度</div>
      ${fatigueGauge(fat.score, fat.level)}
      <div style="font-size:15px;font-weight:800;color:${meta.color};margin-bottom:10px;">${meta.label}</div>
      ${fatigueFactorsHtml(fat.factors)}
      <div class="asmt-desc">今天已经问过啦,直接沿用今日状态~ 明天再帮你重新评估。</div>
      <button class="asmt-btn" id="asmtFatNext">开始评估 →</button>
    `;
    c.querySelector('#asmtFatNext').addEventListener('click', () => resolve());
  });
}

// ——— 第一步:红旗问卷 ———
// 返回 {hit:bool, answers:{}} —— hit=true 表示命中红旗
function redFlagStep(c) {
  return new Promise(resolve => {
    const answers = {};
    c.innerHTML = `
      <div class="asmt-kicker">开始前 · 安全确认</div>
      <div class="asmt-title">先花 20 秒,确认能安全练习</div>
      <div class="asmt-desc">如果有下面这些情况,先别玩游戏,建议去线下看看。</div>
      <div id="asmtQs"></div>
      <button class="asmt-btn" id="asmtNext" disabled>继续 →</button>
    `;
    const qs = c.querySelector('#asmtQs');
    RED_FLAGS_NECK.forEach((q, i) => {
      const row = document.createElement('div'); row.className = 'asmt-q';
      row.innerHTML = `<span class="asmt-q-txt">${q}</span>
        <span class="asmt-yn"><button data-v="yes">有</button><button data-v="no">没有</button></span>`;
      row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        answers[i] = b.dataset.v === 'yes';
        row.querySelector('[data-v=yes]').classList.toggle('on-yes', answers[i]);
        row.querySelector('[data-v=no]').classList.toggle('on-no', !answers[i]);
        // 全部答完才亮"继续"
        c.querySelector('#asmtNext').disabled = Object.keys(answers).length < RED_FLAGS_NECK.length;
      }));
      qs.appendChild(row);
    });
    c.querySelector('#asmtNext').addEventListener('click', () => {
      const hit = Object.values(answers).some(Boolean);
      resolve({ hit, answers });
    });
  });
}

// ——— 第二步:颈部6向ROM采集 ———
// 用内核 tick 读 rel,依次引导6方向,每向记峰值角(转到位保持 HOLD_TO_CONFIRM_MS 算完成)。
// 返回 romNeck 格式 {flexion:{value,confidence},...} 或 null(降级)

// 采集单方向峰值角:持续读 rel,记该轴该符号方向的最大值;到目标附近保持一会儿即完成。
function captureAxisPeak(k, step, barEl) {
  return new Promise(resolve => {
    let peak = 0, holdStart = 0;
    const t0 = performance.now();
    function poll() {
      const snap = k.snapshot ? k.snapshot() : null;
      const rel = snap && snap.rel ? snap.rel : { yaw:0, pitch:0, roll:0 };
      let v = rel[step.axis] * step.sign;   // 该方向为正
      if (v < 0) v = 0;
      if (v > peak) peak = v;
      barEl.style.width = Math.min(100, (peak / step.target) * 100) + '%';
      // 到达目标 80% 且保持 → 完成
      if (peak >= step.target * 0.6) {
        if (!holdStart) holdStart = performance.now();
        else if (performance.now() - holdStart >= HOLD_TO_CONFIRM_MS) { resolve(peak); return; }
      } else { holdStart = 0; }
      // 超时兜底:8s 没到位也收(记已有峰值,后端会判 limited)
      if (performance.now() - t0 > 8000) { resolve(peak); return; }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  });
}

// 等头回到中立位(各轴 rel 都小)
function waitReturnToCenter(k) {
  return new Promise(resolve => {
    const t0 = performance.now();
    function poll() {
      const snap = k.snapshot ? k.snapshot() : null;
      const rel = snap && snap.rel ? snap.rel : { yaw:0, pitch:0, roll:0 };
      const centered = Math.abs(rel.yaw) < 8 && Math.abs(rel.pitch) < 8 && Math.abs(rel.roll) < 8;
      if (centered || performance.now() - t0 > 3000) { resolve(); return; }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  });
}

// ——— 转介提示(命中红旗) ———
function referView(c) {
  return new Promise(resolve => {
    c.innerHTML = `
      <div class="asmt-kicker asmt-refer">建议线下评估</div>
      <div class="asmt-title">这次先不玩游戏哦</div>
      <div class="asmt-desc">你刚才勾选的情况,更适合先让医生看看,别用游戏代替就医。等好点了 Joy 再陪你练~</div>
      <button class="asmt-btn" id="asmtBack">我知道了,返回</button>
    `;
    c.querySelector('#asmtBack').addEventListener('click', () => resolve());
  });
}

// ——— 评估后指导页(gate=pass 才显示):颈部分析 + 今日方案 + 开始 ———
const AXIS_CN = { flexion: '低头', extension: '抬头', lateralL: '左侧屈', lateralR: '右侧屈', rotationL: '左转', rotationR: '右转' };
function coachView(c, coach, result) {
  return new Promise(resolve => {
    const neck = (result.baseline && result.baseline.neck) || {};
    let avail = 0, limited = 0;
    for (const k of Object.keys(neck)) {
      if (neck[k].status === 'available') avail++;
      else if (neck[k].status === 'limited') limited++;
    }
    const planRows = (coach.plan || []).slice(0, 6).map(pl => {
      const cn = AXIS_CN[pl.axis] || pl.axis;
      const cues = (pl.cues || []).join(' · ');
      return `<div class="asmt-q"><span class="asmt-q-txt"><b>${cn}</b> 目标约 ${pl.targetRom || 0}°<br><span style="color:#A8A8B3;font-size:12px;">${cues}</span></span></div>`;
    }).join('');
    c.innerHTML = `
      <div class="asmt-kicker">评估完成 · 今日指导</div>
      <div class="asmt-title">${coach.reason || '来,今天这样练'}</div>
      <div class="asmt-desc">颈部 ${avail} 个方向状态良好${limited ? `,${limited} 个偏紧已为你下调目标` : ''}。下面是今天的动作重点:</div>
      <div style="text-align:left;">${planRows || '<div class="asmt-desc">保持慢而稳,量力而行~</div>'}</div>
      ${coach.breaks ? `<div class="asmt-desc" style="margin-top:12px;">⏰ ${coach.breaks}</div>` : ''}
      <button class="asmt-btn" id="asmtStart">开始训练 →</button>
    `;
    c.querySelector('#asmtStart').addEventListener('click', () => resolve());
  });
}

// ——— 主入口 ———
// zone:'neck'(目前只做颈部)。返回 {pass, flow, baseline, degraded, referReasons}
export async function runAssessment(zone = 'neck') {
  injectStyle();
  const { c, close } = mask();

  try {
    // 0. AI 问诊 + 今日疲劳度(一天一次:当天首次问诊并算疲劳度,当天再进直接复用不重复问)。
    let introAnswers = {};
    const todayFatigue = getTodayFatigue();
    if (todayFatigue) {
      // 今天已测过 → 展示今日疲劳度,跳过问诊
      await fatigueRecapStep(c, todayFatigue);
      introAnswers = todayFatigue.answers || {};
    } else {
      // 今天首次 → 问诊,折算并存今日疲劳度,展示结果
      introAnswers = await introStep(c);
      const fat = saveTodayFatigue(introAnswers);
      await fatigueResultStep(c, fat, false);
    }

    // 1. 红旗安全确认(固定项,不可省)
    const rf = await redFlagStep(c);
    if (rf.hit) {
      await referView(c);
      close();
      return { pass: false, referReasons: ['命中红旗自评项'] };
    }

    // 2. ROM 采集(需要一个 video 元素给内核)
    let video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.muted = true;
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;';
    document.body.appendChild(video);
    const kernel = createPoseKernel({ video });
    let romNeck = null;
    try {
      await kernel.loadModel();
      romNeck = await romStepShared(c, video, kernel);   // 采集6向ROM,把摄像头画面镜像进卡片小窗
    } catch (e) { romNeck = null; }
    video.remove();

    // 3. 降级:采集失败(无摄像头等)→ 直接放行
    if (!romNeck) {
      close();
      return { pass: true, degraded: true };
    }

    // 4. POST /api/screen
    let screen = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch('/api/screen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redFlags: { neck: [] },
          pain: { level: 0, region: 'neck' },
          calib: { keypointQuality: 0.85, shoulderLine: true, trunkRef: true },
          romNeck,
        }), signal: ctrl.signal,
      });
      clearTimeout(timer);
      screen = await res.json();
    } catch (e) { screen = null; }

    close();

    // 后端挂 → 降级放行
    if (!screen || screen.degraded) return { pass: true, degraded: true, romNeck };

    // 存评估结论给关卡消费
    const result = {
      pass: screen.gate === 'pass',
      flow: screen.flow, baseline: screen.baseline, pain: screen.pain,
      referReasons: screen.referReasons || [], romNeck,
    };
    try { sessionStorage.setItem('assessResult', JSON.stringify(result)); } catch {}
    // 写进统一健康档案(供档案页 + AI 画像分析)。隐私:只存角度数值。
    try { recordAssessment({ flow: result.flow, baseline: result.baseline, romNeck, ts: Date.now() }); } catch {}

    // gate=refer → 提示,不进游戏
    if (!result.pass) {
      const { c: c2, close: close2 } = mask();
      await referView(c2);
      close2();
      return result;
    }

    // gate=pass → 评估后、进关卡前:调 /api/coach 出"颈部分析+今日指导",用户看完点开始
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch('/api/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: result.flow, baseline: result.baseline, answers: introAnswers || {} }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const coach = await res.json();
      if (coach && !coach.degraded) {
        const { c: c3, close: close3 } = mask();
        await coachView(c3, coach, result);
        close3();
      }
    } catch (e) { /* coach 失败 → 跳过指导,直接进关卡 */ }

    return result;

  } catch (e) {
    close();
    return { pass: true, degraded: true };  // 任何意外 → 不阻断
  }
}

// 采集颈部6向ROM:用内核 tick 读 rel,依次引导6方向,每向记峰值角。返回 romNeck 或 null(降级)
async function romStepShared(c, kernelVideo, k) {
  const romNeck = {};
  c.innerHTML = `
    <div class="asmt-kicker">活动度测量 · 颈部</div>
    <div class="asmt-title" id="asmtRomTitle">先坐正,收下巴</div>
    <div class="asmt-cam"><video id="asmtVideo" playsinline muted></video></div>
    <div class="asmt-desc" id="asmtRomDesc">让摄像头看清你的脸,保持中立…</div>
    <div class="asmt-bar"><div class="asmt-bar-fill" id="asmtBar"></div></div>
    <div class="asmt-progress" id="asmtProg">校准中</div>
  `;
  const shownVideo = c.querySelector('#asmtVideo');
  const titleEl = c.querySelector('#asmtRomTitle');
  const descEl = c.querySelector('#asmtRomDesc');
  const barEl = c.querySelector('#asmtBar');
  const progEl = c.querySelector('#asmtProg');

  try { await k.startCamera(); } catch (e) { return null; }
  // 把内核摄像头的流也显示到可见小窗
  if (kernelVideo.srcObject) { shownVideo.srcObject = kernelVideo.srcObject; shownVideo.play().catch(()=>{}); }

  let running = true;
  (function tickLoop(){ if(!running) return; k.tick(performance.now()); requestAnimationFrame(tickLoop); })();

  await new Promise(r => setTimeout(r, 400));
  k.beginCalibration();
  await new Promise(r => setTimeout(r, 1200));
  k.endCalibration();

  for (let i = 0; i < ROM_STEPS.length; i++) {
    const step = ROM_STEPS[i];
    titleEl.textContent = `${step.emoji} 请${step.name}`;
    descEl.textContent = '慢慢转到最大,停住别晃 —— 稳一下就好';
    progEl.textContent = `第 ${i + 1} / ${ROM_STEPS.length} 个方向`;
    const peak = await captureAxisPeak(k, step, barEl);
    romNeck[step.key] = { value: Math.round(peak), confidence: 0.85 };
    titleEl.textContent = '回到正中,放松';
    descEl.textContent = '';
    barEl.style.width = '0%';
    await waitReturnToCenter(k);
  }

  running = false;
  k.stopCamera();
  return romNeck;
}
