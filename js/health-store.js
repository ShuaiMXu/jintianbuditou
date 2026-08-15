// ============================================================
// health-store.js · 统一健康数据存档(ES module)
// ------------------------------------------------------------
// 把两个来源的真实数据汇总成一份健康档案,供档案页(mock-body-profile)读取与 AI 画像分析:
//   ① 评估闸门产出:颈部6向ROM、flow、baseline、红旗结果(assessment.js 写)
//   ② 关卡埋点产出:逐轴表现 byAxis、甩头数、时长(mock-walk 等关卡结算写)
//
// 存 localStorage['health_profile_v1']。隐私红线:只存角度/计数/评级数值,绝无画面。
// 无数据的部位(肩/眼)保持 null,档案页显示"待采集"。
// ============================================================

const KEY = 'health_profile_v1';

const DEFAULT_PROFILE = {
  updatedAt: 0,
  totalSessions: 0,
  // 基础个人/体检资料(onboarding 对话式录入写入)。null=未填。隐私:纯数值/文本,无画面。
  profile: {
    nickname: null, age: null, gender: null,
    heightCm: null, weightKg: null, bmi: null,
    occupation: null, sitHoursPerDay: null, screenHoursPerDay: null,
    history: [], chiefComplaint: null, filledAt: 0,
  },
  // 三部位画像。rating 0-100(由 ROM 达标率或关卡表现折算),null=未采集。
  zones: {
    neck:     { rating: null, romNeck: null, flow: null, lastAssessAt: 0 },
    shoulder: { rating: null },   // 待肩部关卡(下一轮)
    eye:      { rating: null },   // 待眼部关卡
  },
  // 最近若干次关卡表现(逐轴),给 AI 看趋势
  recentSessions: [],
  // 今日疲劳度(一天一次:AI 问诊答案 + 当天行为综合折算)。date 为本地 YYYY-MM-DD。
  fatigue: { score: null, level: null, date: null, factors: [] },
};

export function loadProfile() {
  try { return { ...DEFAULT_PROFILE, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; }
  catch { return { ...DEFAULT_PROFILE }; }
}

function save(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}

// 本地日期串 YYYY-MM-DD(用于"一天一次"判断)
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 今日疲劳度:今天已测 → 返回 {score,level,factors};未测(或跨天)→ null
export function getTodayFatigue() {
  const p = loadProfile();
  const f = p.fatigue || {};
  if (f.score != null && f.date === todayStr()) {
    return { score: f.score, level: f.level, factors: f.factors || [], answers: f.answers || {} };
  }
  return null;
}

// 疲劳度折算(问诊答案 + 当天关卡行为综合)。answers:{feel,goal,duration,sleep,...}
// 返回 {score(0-100,越高越累), level, factors[]}。分数越高越疲劳。
export function computeFatigue(answers = {}) {
  let score = 30;               // 基线
  const factors = [];
  // —— 问诊主观答案 ——
  if (answers.feel === '酸胀') { score += 30; factors.push('颈肩酸胀'); }
  else if (answers.feel === '发紧') { score += 18; factors.push('颈肩发紧'); }
  if (answers.duration === '半天没动了') { score += 20; factors.push('久坐半天未动'); }
  else if (answers.duration === '两三小时') { score += 10; factors.push('连续久坐两三小时'); }
  if (answers.sleep === '落枕/没睡好') { score += 20; factors.push('睡眠不佳'); }
  else if (answers.sleep === '一般') { score += 8; }
  if (answers.mood === '压力山大') { score += 10; factors.push('压力偏大'); }
  else if (answers.mood === '有点累') { score += 5; }
  // —— 当天关卡行为:今天练得越多/甩头越多,越显示已疲劳 ——
  const p = loadProfile();
  const today = todayStr();
  const todaySessions = (p.recentSessions || []).filter(s => {
    if (!s.ts) return false;
    const d = new Date(s.ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === today;
  });
  if (todaySessions.length >= 3) { score += 12; factors.push(`今日已练 ${todaySessions.length} 次`); }
  const flings = todaySessions.reduce((s, x) => s + (x.flingCount || 0), 0);
  if (flings >= 5) { score += 8; factors.push('动作偏急(甩头较多)'); }
  // —— 基础资料:久坐族天然疲劳基线略高 ——
  const sit = p.profile && p.profile.sitHoursPerDay;
  if (sit >= 8) { score += 8; factors.push(`日均久坐约 ${sit} 小时`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 70 ? 'high' : score >= 45 ? 'mid' : 'low';
  return { score, level, factors: factors.slice(0, 4) };
}

// 写入今日疲劳度(一天一次)
export function saveTodayFatigue(answers = {}) {
  const r = computeFatigue(answers);
  const p = loadProfile();
  p.fatigue = { score: r.score, level: r.level, date: todayStr(), factors: r.factors, answers, ts: Date.now() };
  save(p);
  return r;
}

// 基础资料录入写入(onboarding 对话式录入调用)。只覆盖传入的非空字段,自动算 BMI。
// basics 形如 {nickname,age,gender,heightCm,weightKg,occupation,sitHoursPerDay,screenHoursPerDay,history,chiefComplaint}
export function saveProfileBasics(basics = {}) {
  const p = loadProfile();
  const prof = { ...DEFAULT_PROFILE.profile, ...(p.profile || {}) };
  for (const [k, v] of Object.entries(basics)) {
    if (v == null) continue;
    if (k === 'history') { prof.history = Array.isArray(v) ? v : prof.history; continue; }
    prof[k] = v;
  }
  // BMI:两值齐了才算,保留一位小数
  if (prof.heightCm > 0 && prof.weightKg > 0) {
    const h = prof.heightCm / 100;
    prof.bmi = Math.round((prof.weightKg / (h * h)) * 10) / 10;
  }
  prof.filledAt = Date.now();
  p.profile = prof;
  p.updatedAt = prof.filledAt;
  save(p);
  return p;
}

// 颈部ROM达标率 → rating(0-100)。目标角与后端 NECK_TARGET_ROM 对齐。
const NECK_TARGET = { flexion: 40, extension: 30, lateralL: 35, lateralR: 35, rotationL: 60, rotationR: 60 };
function neckRatingFromRom(romNeck) {
  if (!romNeck) return null;
  const ratios = [];
  for (const [k, target] of Object.entries(NECK_TARGET)) {
    const v = romNeck[k] && romNeck[k].value;
    if (v != null) ratios.push(Math.min(1, Math.abs(v) / target));
  }
  if (!ratios.length) return null;
  return Math.round((ratios.reduce((s, r) => s + r, 0) / ratios.length) * 100);
}

// 评估结束写入(assessment.js 调用)
export function recordAssessment({ flow, baseline, romNeck, ts } = {}) {
  const p = loadProfile();
  p.zones.neck.romNeck = romNeck || p.zones.neck.romNeck;
  p.zones.neck.flow = flow ?? p.zones.neck.flow;
  p.zones.neck.rating = neckRatingFromRom(romNeck) ?? p.zones.neck.rating;
  p.zones.neck.lastAssessAt = ts || 0;
  p.updatedAt = ts || 0;
  save(p);
  return p;
}

// 单部位 rating 写入(肩/眼摄像头测评调用)。zone: 'shoulder'|'eye'|'neck';raw 存原始测量(角度/覆盖度)
export function recordZoneRating(zone, rating, raw = null, ts = 0) {
  const p = loadProfile();
  if (!p.zones[zone]) p.zones[zone] = {};
  p.zones[zone].rating = rating;
  if (raw != null) p.zones[zone].raw = raw;
  p.zones[zone].lastAssessAt = ts || 0;
  p.updatedAt = ts || 0;
  save(p);
  return p;
}

// 关卡结算写入(mock-walk 等关卡调用,传 lastRun.session 摘要)
export function recordSession({ level, byAxis, flingCount, durationMs, ts } = {}) {
  const p = loadProfile();
  p.totalSessions += 1;
  p.recentSessions.unshift({ level, byAxis, flingCount, durationMs, ts });
  p.recentSessions = p.recentSessions.slice(0, 10);   // 只留最近 10 次
  p.updatedAt = ts || 0;
  save(p);
  return p;
}
