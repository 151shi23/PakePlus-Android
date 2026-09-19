'use strict';

/* UGC 创造中心：数据模型、IndexedDB 存储、校验器、分享码、AI 提示词工厂
   玩家（完全不懂编程）复制提示词 -> 交给任意 AI 生成 -> 粘回游戏 -> 校验 -> 保存为可玩关卡
   官方关卡 DSL 见 levels.js：plan 数组 [米数, '类型', {参数}] */

/* ---------- 物理兜底参数（只 clamp 不拒绝，创作自由） ---------- */
// 内置类型参数兜底（防负宽/负高这类真崩坏）；未知类型 = 自定义机关实体，参数原样放行
const UGC_LIMITS = {
  gap:        { w: 240 },
  spikeTrap:  { w: 150 },
  hiddenSpike:{ w: 150 },
  fakeFloor:  { w: 140 },
  lowBar:     { w: 140, gapH: [60, 180] },
  spikeCeil:  { w: 140, low: [280, 340] },
  crumble:    { w: 140, h: [180, 300] },
  crusher:    { w: [90, 150], travel: [150, 260] },
  movingPlatform: { w: [120, 220], h: [180, 300], amp: [30, 70] },
  pendulum:   { len: [380, 520] },
  platform:   { w: [140, 260] },
};
const UGC_MAX_PLAN = 200;          // plan 软上限（超出截断，防内存爆炸）
const UGC_LENM = [50, 2000];       // 关卡长度 clamp 范围（米）
const UGC_SPEED = [200, 900];      // 基础速度 clamp 范围
const UGC_MAX_PROJECTS = 12;       // 项目数上限
const UGC_MAX_ASSET_MB = 2.5;      // 单图体积上限（MB）
const UGC_MAX_MODS = 12;           // 每关自定义机关上限
const UGC_MAX_CODE = 8000;         // 单段代码字符上限（仅用于报错复制截断，代码本身不截断）

/* ---------- IndexedDB 存储（图片等大对象必须走这里） ---------- */
let ugcDb = null;          // IDB 实例
let ugcCache = [];         // 内存缓存，UI 同步读取用
let ugcReady = false;
let modCache = [];         // 独立 mod 库缓存（无尽模式用，与关卡作品互不重合）
let modReady = false;

function ugcOpen() {
  if (ugcDb) return Promise.resolve(ugcDb);
  return new Promise((res, rej) => {
    try {
      const req = indexedDB.open('jiling_ugc', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('mods')) {
          db.createObjectStore('mods', { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { ugcDb = e.target.result; res(ugcDb); };
      req.onerror = e => rej(e);
    } catch (err) { rej(err); }
  });
}

function ugcList() {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('projects', 'readonly');
    const req = tx.objectStore('projects').getAll();
    req.onsuccess = () => {
      ugcCache = (req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      ugcReady = true;
      res(ugcCache);
    };
    req.onerror = e => rej(e);
  }));
}
function ugcListSync() {
  return ugcReady ? ugcCache.slice() : [];
}
function ugcGet(id) {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('projects', 'readonly');
    const req = tx.objectStore('projects').get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = e => rej(e);
  }));
}
function ugcSave(item) {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(item);
    tx.oncomplete = () => res(item);
    tx.onerror = e => rej(e);
  })).then(it => ugcList().then(() => it));
}
function ugcDelete(id) {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e);
  })).then(() => ugcList());
}

/* ---------- 独立 mod 库：无尽模式的机制/陷阱/界面 mod（与关卡作品互不重合） ---------- */
function ugcModsAll() {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('mods', 'readonly');
    const req = tx.objectStore('mods').getAll();
    req.onsuccess = () => {
      modCache = (req.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      modReady = true;
      res(modCache);
    };
    req.onerror = e => rej(e);
  }));
}
function ugcModsSync() {
  return modReady ? modCache.slice() : [];
}
function ugcModSave(m) {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('mods', 'readwrite');
    tx.objectStore('mods').put(m);
    tx.oncomplete = () => res(m);
    tx.onerror = e => rej(e);
  })).then(it => ugcModsAll().then(() => it));
}
function ugcModDelete(id) {
  return ugcOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('mods', 'readwrite');
    tx.objectStore('mods').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e);
  })).then(() => ugcModsAll());
}

/* ---------- 工具 ---------- */
function ugcUid() {
  return 'u' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}
const imgBytes = url => {
  const m = /^data:([^;]+)?(;base64)?,(.*)$/.exec(String(url || '').slice(0, 3200));
  if (!m || !/^data:image\//i.test(String(url || ''))) return 0;
  // base64 体积估算法：字符数 * 0.75
  const s = String(url);
  return s.length * 0.75;
};

/* ---------- 校验器：verifyUgc(raw) -> { ok, item, errors } ---------- */
function verifyUgc(raw) {
  const errors = [];
  // 兼容对象输入（内置示例 ugcSample 直接传对象）
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = JSON.stringify(raw);
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, item: null, errors: [{ where: '输入', msg: '内容为空' }] };
  }
  // 容错解析：剥掉 markdown 代码块包裹与首尾空白
  let text = raw.trim();
  const f = text.indexOf('```');
  if (f >= 0) {
    let s = text.slice(f + 3).replace(/^json\s*/i, '');
    const g = s.indexOf('```');
    if (g >= 0) s = s.slice(0, g);
    text = s.trim();
  }
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const pos = /position (\d+)/i.exec(e.message);
    return {
      ok: false, item: null,
      errors: [{ where: 'JSON', msg: '不是有效的 JSON' + (pos ? '（第 ' + pos[1] + ' 个字符附近）' : '') }],
    };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, item: null, errors: [{ where: '结构', msg: '顶层应是对象 { title, lenM, plan, ... }' }] };
  }

  // 基础字段：超范围一律 clamp（创作自由，不再拒绝）
  const title = String(obj.title || '我的创造').slice(0, 20) || '我的创造';
  const lenM = clamp(toNum(obj.lenM, 300), UGC_LENM[0], UGC_LENM[1]);
  const speed = clamp(toNum(obj.speed, 350), UGC_SPEED[0], UGC_SPEED[1]);
  const difficulty = ['simple', 'normal', 'hard'].includes(obj.difficulty) ? obj.difficulty : 'normal';
  const desc = String(obj.desc || '').slice(0, 60);

  // plan：能解析就收。格式坏的条目静默跳过；未知类型 = 自定义机关实体，直接放行。
  // 数字参数只做物理兜底 clamp（防负宽负高这类真崩坏），不做范围拒绝。
  const warnings = [];
  const plan = [];
  (Array.isArray(obj.plan) ? obj.plan : []).forEach((it, i) => {
    if (!Array.isArray(it) || it.length < 2) return;
    const type = String(it[1]);
    const opt = (it[2] && typeof it[2] === 'object') ? it[2] : {};
    const m = toNum(it[0], NaN);
    if (!isFinite(m) || m < 0) return;
    const lim = UGC_LIMITS[type];
    if (lim) {
      for (const k in lim) {
        const v = toNum(opt[k], undefined);
        if (v === undefined) continue;
        const L = lim[k];
        opt[k] = Array.isArray(L) ? clamp(v, L[0], L[1]) : clamp(v, 0, L);
      }
    }
    if (plan.length < UGC_MAX_PLAN) plan.push([m, type, clampOpt(opt, ken0s(type))]);
  });

  // mods：JS 完全放开（死循环/语法都不拦），语法坏的只警告——装进去跑不起来时游戏内会自动复制报错。
  const mods = [];
  const seen = new Set();
  (Array.isArray(obj.mods) ? obj.mods : []).slice(0, UGC_MAX_MODS).forEach((m, i) => {
    const nm = ugcNormMod(m, i, warnings, seen);
    if (nm) mods.push(nm);
  });

  // assets：坏 src 静默跳过；单张超大只丢该图（软提示）
  const assets = [];
  (Array.isArray(obj.assets) ? obj.assets : []).slice(0, 8).forEach((a) => {
    if (!a || !a.id || !a.src) return;
    const src = String(a.src);
    if (!(/^data:image\//i.test(src) || /^https?:\/\//i.test(src))) return;
    if (/^data:/.test(src) && imgBytes(src) > UGC_MAX_ASSET_MB * 1024 * 1024) {
      warnings.push({ where: '素材 ' + a.id, msg: '单张图片超过 ' + UGC_MAX_ASSET_MB + 'MB，已丢弃' });
      return;
    }
    assets.push({ id: String(a.id).slice(0, 20), name: String(a.name || '图' + (a.id || '').slice(0, 2)).slice(0, 12), src, srcType: /^data:/.test(src) ? 'data' : 'url' });
  });
  const bgAsset = obj.bgAsset && assets.find(a => a.id === obj.bgAsset) ? obj.bgAsset : null;

  if (!plan.length) return { ok: false, item: null, errors: [{ where: 'plan', msg: '没有可用的 plan 条目（至少给一条 [米数, 类型]）' }] };

  return {
    ok: true,
    item: {
      id: obj.id || ugcUid(),
      title, desc, difficulty, lenM, speed, plan,
      mods, assets, bgAsset,
      ver: 1,
      createdAt: obj.createdAt || Date.now(),
      ratingStrs: obj.ratingStrs || { reach: 0, noHit: 0, coin70: 0 },
    },
    errors: [],
    warnings: warnings.slice(0, 10),
  };
}

/* 单个 mod 清洗：字段收敛。JS 完全放开——死循环/任何语法都不拦（语法坏的装进去也不生效，
   只给警告提示）。不合法结构返回 null（软丢弃，其余内容照常导入）。tag: trap=机关 mech=机制 ui=界面 fun=整活 */
function ugcNormMod(m, i, warnings, seen) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || 'mod' + (i + 1)).replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 16);
  if (!id || (seen && seen.has(id))) return null;
  if (seen) seen.add(id);
  const src = (a, b) => typeof a === 'string' ? a : typeof b === 'string' ? b : '';
  const onSpawn = src(m.onSpawn, m.spawn);
  const onUpdate = src(m.onUpdate, m.update);
  if (!onSpawn && !onUpdate) return null;
  // 语法预检：只提醒不拦截（装进去跑不起来时，游戏内会自动复制报错）
  for (const [hook, code] of [['onSpawn', onSpawn], ['onUpdate', onUpdate]]) {
    if (!code) continue;
    try { new Function('api', '"use strict";' + code); }
    catch (e) {
      warnings.push({ where: 'mod「' + id + '」', msg: hook + ' 语法有误：' + e.message + '（已照常安装，但跑不起来）' });
    }
  }
  return {
    id, name: String(m.name || id).slice(0, 12), desc: String(m.desc || '').slice(0, 40),
    tag: ['trap', 'mech', 'ui', 'fun'].includes(m.tag) ? m.tag : 'trap',
    onSpawn, onUpdate, img: m.img || null,
  };
}

/* ---------- 无尽模式 mod 包校验：verifyModsPack(raw) -> { ok, mods, packName, warnings, errors } ---------- */
/* 接受 { name, mods: [...] } / mod 数组 / 单个 mod 对象。JS 完全放开不拦代码内容，语法坏只警告 */
function verifyModsPack(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = JSON.stringify(raw);
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, mods: [], packName: '', warnings: [], errors: [{ where: '输入', msg: '内容为空' }] };
  }
  let text = raw.trim();
  const f = text.indexOf('```');
  if (f >= 0) {
    let s = text.slice(f + 3).replace(/^json\s*/i, '');
    const g = s.indexOf('```');
    if (g >= 0) s = s.slice(0, g);
    text = s.trim();
  }
  let obj = null;
  try { obj = JSON.parse(text); }
  catch (e) {
    const pos = /position (\d+)/i.exec(e.message);
    return { ok: false, mods: [], packName: '', warnings: [], errors: [{ where: 'JSON', msg: '不是有效的 JSON' + (pos ? '（第 ' + pos[1] + ' 个字符附近）' : '') }] };
  }
  const arr = Array.isArray(obj) ? obj
    : (obj && Array.isArray(obj.mods)) ? obj.mods
    : (obj && (obj.onSpawn || obj.onUpdate || obj.spawn || obj.update)) ? [obj]
    : null;
  if (!arr) {
    return { ok: false, mods: [], packName: '', warnings: [], errors: [{ where: '结构', msg: '应是 { "name": "包名", "mods": [ ... ] }' }] };
  }
  const warnings = [];
  const mods = [];
  const seen = new Set();
  arr.slice(0, UGC_MAX_MODS).forEach((m, i) => {
    const nm = ugcNormMod(m, i, warnings, seen);
    if (nm) mods.push(nm);
  });
  if (!mods.length) {
    return { ok: false, mods: [], packName: '', warnings: warnings.slice(0, 10), errors: [{ where: 'mods', msg: '没有可用的 mod（每个 mod 需要有 onSpawn 或 onUpdate）' }] };
  }
  return { ok: true, mods, packName: String((obj && obj.name) || '').slice(0, 16), warnings: warnings.slice(0, 10), errors: [] };
}

function ken0s(type) {
  // 该类型 buildLevel 会读取的参数白名单（吸收未知字段，防脏数据）
  // 返回 null = 自定义 mod 机关，参数原样保留（由 mod 代码自解释）
  return {
    coins: ['n', 'high'], fakeCoins: ['n'], gap: ['w', 'noArc'],
    fakeFloor: ['w'], spikeTrap: ['w', 'phase'], hiddenSpike: ['w'],
    trapSpring: ['w', 'low'], crumble: ['w', 'h'], crusher: ['w', 'high', 'travel', 'spd'],
    chaseRock: ['rel'], lowBar: ['w', 'gapH'], spikeCeil: ['w', 'low'],
    bouncePad: ['w'], booster: ['w'], pendulum: ['pivotY', 'len', 'r', 'amp', 'spd'],
    rollingRock: ['vx'], fallingRock: ['r'], movingPlatform: ['w', 'h', 'amp', 'spd'],
    platform: ['w', 'level', 'coins'], bait: ['w'],
  }[type] || null;
}
function clampOpt(opt, keys) {
  if (!keys) {
    // 自定义机关：保留基础类型参数（数组/对象引用不安全，丢弃）
    const out = {};
    for (const k in opt) {
      const v = opt[k];
      if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'number' && isFinite(v)) out[k] = v;
    }
    return out;
  }
  const out = {};
  for (const k of keys) if (opt[k] !== undefined) out[k] = opt[k];
  return out;
}
function toNum(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : d;
}

/* ---------- 图片缓存：按 src 复用 Image，加载完成后才可用于绘制 ---------- */
const ugcImgCache = new Map();
function ugcImg(src) {
  if (!src) return null;
  let rec = ugcImgCache.get(src);
  if (!rec) {
    const im = new Image();
    rec = { im, ok: false };
    im.onload = () => { rec.ok = true; };
    im.onerror = () => { rec.ok = false; };
    im.src = src;
    ugcImgCache.set(src, rec);
  }
  return rec.ok ? rec.im : null;
}

/* ---------- 全局背景：localStorage 存 src，所有模式通用（单关背景优先） ---------- */
function globalBgGet() {
  try { return localStorage.getItem('jiling_globalbg') || ''; } catch (e) { return ''; }
}
function globalBgSet(src) {
  try {
    if (src) localStorage.setItem('jiling_globalbg', src);
    else localStorage.removeItem('jiling_globalbg');
  } catch (e) {}
  GLOBAL_BG.src = src || '';
  GLOBAL_BG.img = null;
  if (src) {
    const im = new Image();
    im.onload = () => { GLOBAL_BG.img = im; };
    im.onerror = () => { GLOBAL_BG.img = null; };
    im.src = src;
  }
}

/* ---------- 分享码 ---------- */
const UGC_SHARE_PREFIX = 'UGC1:';
function shareEncode(item) {
  try {
    const s = JSON.stringify(item);
    return UGC_SHARE_PREFIX + btoa(unescape(encodeURIComponent(s)));
  } catch (e) {
    return null;
  }
}
function shareEncodeFmt(item) {
  const code = shareEncode(item);
  if (!code) return { code: null, mb: 0 };
  return { code, mb: code.length / (1024 * 1024) };
}
function shareDecode(text) {
  let t = String(text || '').trim();
  if (t.indexOf(UGC_SHARE_PREFIX) !== 0) {
    return { ok: false, raw: t, error: '不是 UGC1: 分享码（你可能只贴了 JSON，可以直接粘贴 AI 结果）' };
  }
  const b64 = t.slice(UGC_SHARE_PREFIX.length);
  let json = '';
  try { json = decodeURIComponent(escape(atob(b64))); }
  catch (e) { return { ok: false, raw: t, error: '分享码解码失败（可能被截断）' }; }
  return { ok: true, raw: json, error: null };
}

/* ---------- mod 包分享码（MOD1: 前缀，结构与关卡分享同款 base64） ---------- */
const MOD_SHARE_PREFIX = 'MOD1:';
function modShareEncode(pack) {
  try {
    return MOD_SHARE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(pack))));
  } catch (e) { return null; }
}
function modShareDecode(text) {
  let t = String(text || '').trim();
  if (t.indexOf(MOD_SHARE_PREFIX) !== 0) {
    return { ok: false, raw: t, error: '不是 MOD1: 分享码（你可能只贴了 JSON，可以直接粘贴 AI 结果）' };
  }
  const b64 = t.slice(MOD_SHARE_PREFIX.length);
  let json = '';
  try { json = decodeURIComponent(escape(atob(b64))); }
  catch (e) { return { ok: false, raw: t, error: '分享码解码失败（可能被截断）' }; }
  return { ok: true, raw: json, error: null };
}

/* ---------- AI 提示词工厂 ---------- */
const UGC_DIFF = {
  simple: { name: '简单', speed: '330', gapMax: '150', desc: '坑不宽、台不高、给足反应时间，随便跳就能过。' },
  normal: { name: '普通', speed: '360', gapMax: '185', desc: '常规跑酷难度，坑、刺、平台合理搭配。' },
  hard:   { name: '硬核', speed: '420', gapMax: '230', desc: '大坑、连续刺、顶刺+弹簧连段，给老玩家上强度。' },
};

/* ---------- 引擎全量内部文档：给 AI 的"游戏所有情况 + 对内/对外函数"总览 ----------
   两个提示词（关卡 ugcPrompt / mod 包 ugcModPrompt）共用；内容与 engine.js/game.js 真实实现一一对应 */
function ugcEngineDoc() {
  return `【游戏引擎全量文档：全局对象、常量、对内函数——mod 代码与引擎同作用域，以下全部可直接读写/调用】

■ 坐标系与关键常量（engine.js）
- 逻辑分辨率：W（宽度，随屏幕比例伸缩，竖屏基准 540）× H=960；y 向下为正；地面 y=GROUND_Y=700
- 横向滚动：world.x 是世界滚动偏移；屏幕坐标 = 世界坐标 - world.x；玩家固定在屏幕 PLAYER_X（152~560 自适应）
- 1 米 = PX_PER_M=50 像素；GRAVITY=2900；JUMP_V=-1350（满跳约 314px 高）；BASE_SPEED=330；MAX_SPEED=820
- ENERGY_MAX=100（冲刺能量）；DASH_TIME=2.6s；AIR_JUMP_MAX=2（固有空中补跳）；PLAYER_H=168

■ 全局状态 G（读写即生效）
- G.mode：'endless' 无尽 / 'level' 官方关 / 'ugc' 自定义关；游戏进行中 = G.state === 'playing'（其它值=菜单/暂停/结算）
- G.coins 金币；G.combo 连击；G.best 最高分；G.runTime 本局秒数；G.jumpCount/G.slideCount 统计
- G.shield 护盾层数(0~2)；G.revive 剩余复活次数；G.buff = { magnet, invinc, djump, x2, slow, sprint, frenzy } 各项为剩余秒数（直接改，如 G.buff.invinc = 5）
- G.feverT/G.feverNeed 狂热值；G.energy 冲刺能量(0~100)；G.dashT 冲刺剩余时间；G.airJump 剩余补跳；G.airCd 补跳CD
- G.holdJump/G.holdSlide 按键按住状态（true 时按满跳/按住滑铲）
- G.chiyou 蚩尤：bx 屏幕x；y/vy/onGround/sliding 物理；hurtT 踉跄剩余秒（写>0 即踉跄闪烁）；skillT（>=0 施法中，<0 空闲）；skillCd 下次技能倒计时；kind 当前技能 'trap'/'fireball'/'claw'/'quake'/'meteor'；waitT>0 = 距玩家过近停下等待中
- G.boss 非空 = BOSS 战进行中

■ 世界 world（数组直接 push 即生效，各系统每帧扫描）
- world.x 滚动偏移；world.speed 当前速度(px/s)；world.genCursor 生成游标（米×50）
- 机关数组：gaps 坑 / spikeTraps 伸缩刺 / hiddenSpikes 暗刺 / lowBars 低杆 / ceilSpikes 顶刺 / fakeFloors 假地面 / fakeCoins 假币 / trapSprings 弹簧 / crumbles 塌陷台 / crushers 压制板 / pendulums 摆锤 / rollingRocks 滚石 / fallingRocks 落石 / boosters 加速带 / bouncePads 弹跳板 / platforms+movingPlatforms 平台 / bait 类走 gaps
- 实体数组：coins 金币 / powers 道具 / crates 箱子 / gates 命运之门 / enemies 敌人 / bullets 子弹 / flames 火焰 / firePits 地刺坑 / meteors 陨石 / quakes 刺浪 / ugcHazards 自定义机关
- world.pTune 玩家参数改写 / world.cyTune 蚩尤改写 / world.genTune 原版机关生成参数 / world.ugcHud 自定义UI / world.ugcHooks 事件钩子 / world.tstop 时停剩余秒数（>0 时蚩尤与 BOSS 弹幕冻结）/ world.tsMul·tsT 全局时间流速（api.timeScale）（一般用 api.* 封装，别裸改）

■ 玩家 player（直接读写物理量）
- player.y/vy（vy=-1350 起跳）、player.onGround、player.sliding、player.jumps 已跳段数、player.coyote 土狼时间、player.jumpBuf 输入缓冲

■ 画布 ctx（全局 canvas 2D 上下文）
- api.on('draw') 钩子里直接用 ctx 画任意图形/渐变/贴图；实体用屏幕坐标 = 世界坐标 - world.x；画完自己 save/restore

■ 对内函数（全局直接调用）
- 行为：doJump() 触发跳跃；doSlide() 滑铲；doDash() 冲刺（需能量）
- 判死：die('gap'|'spike'|'claw'|'fall'...) 走完整死亡流程（含死亡钩子/复活判定）
- 增益：applyBuff('magnet'|'invinc'|'djump'|'x2'|'slow'|'sprint'|'shield'|'ghost'|'rain'|'revive'|'frenzy') 带全屏特效
- 生成：spawnGate(x) 命运之门；addArcCoins(世界x, 宽) 拱形金币串
- 查询：playerBox() 玩家碰撞盒 { l, r, t, b, h }（世界坐标）；groundSupport() 脚下支撑；pendulumHead(pd) 摆锤锤头位置
- 特效 FX：FX.burst(世界x, y, 数量, { vx0, vx1, vy0, vy1, life0, life1, size0, size1, color, grav }) 粒子；FX.sburst(屏幕坐标版)；FX.float(世界x, y, '文字', { color, size, life }) 飘字；FX.sfloat(屏幕x, y, '文字')；FX.ring(x, y, { r0, r1, max, color, width }) 冲击环；FX.flashScreen('#ff5a4a', 0.12) 全屏闪色；FX.addShake(0.3) 震屏；FX.slowMo(时长, 倍率) 慢动作
- 音效 Snd：Snd.jump() / Snd.coin(连击数) / Snd.click() / Snd.crack() / Snd.whoosh() / Snd.dash() / Snd.fever() / Snd.nearMiss() / Snd.airJump() / Snd.gate(isRisk) / Snd.bounce() / Snd.stomp() / Snd.spikeOut() / Snd.breakFloor() / Snd.milestone() / Snd.clear() / Snd.star(i) / Snd.fail()
- 工具：clamp(v, min, max)；rnd(a, b) 区间随机；lerpColor(c1, c2, t)；hexA('#rrggbb', 透明度)
- 流程（谨慎调用，会切场景）：startEndless() 开无尽；startLevel(关卡序号)；restartCurrent() 重开本局；pauseGame() / resumeGame()

【对外 api（mod 沙箱封装，跨模式安全，优先用这套）】
- 状态：api.x / api.y 玩家位置；api.dt 帧时长(秒)；api.worldX 世界偏移；api.speed 当前速度；api.time() 游戏时间；api.rand(a,b) 随机数；api.mode 模式
- api.stats()：{ x, y, vy, onGround, sliding, jumps, coins, combo, speed, time }
- api.dist()：蚩尤距离（像素）
- 实体：api.make(type, obj) 生成；api.hazards(type) 取回数组；e.dead=true 销毁；e.x/e.y/w/h/dx/img 自由读写（img 可换实体贴图）
- 判定：api.hitPlayer(e) 命中玩家；api.kill() 判死；api.give(n) 加金币
- 状态/经济：api.buff('sprint', 秒?, quiet?) 直给任意增益（键：magnet/invinc/djump/x2/slow/sprint/frenzy/shield/ghost/rain/revive）；api.coin(n) 加/扣金币（负数=消费，做商店）；api.energy(v) 加/扣能量（0~100）
- 全局演出：api.timeScale(倍率, 秒) 真·子弹时间（0.2~2.5 倍，玩家/蚩尤/机关一起变速，倒计时走真实时间）；api.msg('大字', '小字?') 屏幕中央公告；api.snd('名字') 播任意内置音效（Snd.名字，如 'jump'/'fever'/'crack'）；api.spawn('coin'|'power', { x?, gy?, vy?, ptype? }) 运行时投放金币/道具球（x 世界坐标默认玩家前方 600px；vy=下落金币雨式；ptype 默认随机）
- 特效：api.fx.burst(x, y, n, { color }) 粒子；api.fx.float(x, y, '文字') 飘字
- 改写：api.player(...) / api.chiyou(...) / api.tune(类型, {字段:值}) / api.bg(url) / api.hud(key, 内容) / api.revive(n) / api.timestop(秒)
- 事件：api.on('jump'|'coin'|'death'|'key'|'tap'|'draw', (api, info) => {...})
  · key: 任意按键，info.code（'KeyE' 等）/info.key —— 自由键位主动技能
  · tap: 点击屏幕，info.x/info.y（屏幕坐标）—— 手机端点按交互
  · draw: 每帧在机关层之上绘制，info.worldX —— 配合全局 ctx 画任意图形
- 主动技能按钮：api.button({ label: '技', fn: (api) => {...}, x?, y?, w?, h?, color? }) —— 屏幕右下角出现可点按钮（手机可按），每帧在 onUpdate 里重新调用才持续显示；点击回调 fn(api)

【全新机制配方：创造原版没有的机制 = 触发 + 效果 + 表现 任意组合】
- 触发：api.button 主动技能按钮 / api.on('key') 自由键位 / api.on('tap') 点按 / api.on('jump','coin','death') 被动触发 / onUpdate 里帧计数定时器
- 效果：直接读写 G/player/world（如 G.buff.invinc=3、player.vy=-1800、world.speed）；或 api.make 生成自定义实体，在 onUpdate 里 api.hazards(type) 驱动移动 + api.hitPlayer(e) 判定 + e.dead=true 销毁
- 表现：api.fx 粒子飘字 / api.on('draw') + 全局 ctx 画法阵/光圈/任意图形 / api.hud 仪表盘 / Snd.* 音效
- 参考思路：按 E 召唤陨石雨（key 钩子 + make('meteor2') + draw 画火尾）；主动技「时停」按钮（button + api.timestop）；点击蓄力二段冲刺（tap + player 物理直改）；地面符文法阵（draw 画旋转法阵 + hitPlayer 判定）；金币商店（coin 钩子攒钱 + button 消费换 buff）；蚩尤狂暴条（hud 进度条 + dist() 达阈值改 world.cyTune）`;
}

function ugcPrompt(difficulty) {
  const d = UGC_DIFF[difficulty] || UGC_DIFF.normal;
  return `你是一位《寂零快跑》横版跑酷游戏的资深关卡设计师。玩家自动向前奔跑，只能控制跳跃（长按跳更高）与滑铲（按住下）。请根据下面的规则，为我设计一个节奏流畅、有张有弛的全新关卡。

【关卡设定】
- 难度档位：${d.name}（${d.desc}）
- 长度：240~400 米（lenM）；速度：${d.speed} 左右（像素/秒）；坑宽最大：${d.gapMax} 像素
- 给关卡起一个有画面感的中文标题（12 字内），desc 用一句话点出这个关卡最独特的体验。

【必须输出】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记、不要用 \`\`\`。结构如下：
{
  "title": "关卡名",
  "desc": "一句话简介",
  "difficulty": "${difficulty}",
  "lenM": 300,
  "speed": ${d.speed},
  "plan": [
    [24, "coins", { "n": 3 }],
    [52, "gap", { "w": 150 }],
    ...更多条目...
  ]
}

【plan 规则（自由创作）】
- 每一行是 [米数, 机关类型, 参数]，米数是从起点算的米数。游戏不做硬性限制（越难越好！），你可以完全自由地安排。
- 建议节奏（非强制）：15~30 米一个机关最流畅；金币可以贴着机关放当路线指引。
- 机关类型可以直接用下面的内置类型，也可以用你在 mods 里自创的类型——不认识的类型游戏会自动生成一个可交互的实体（默认画成旋转刀锋），由你的 mod 代码驱动它。敢想敢写。

【节奏设计（专业关卡结构）】
- 开场（0~50 米）：温和。用金币 + 单个宽坑让玩家热身，建立信心。
- 发展（50~150 米）：引入本关核心机关，形成 2~3 组"组合招"。例如：金币引导起跳 → 空中越过伸缩刺 → 落上浮空平台。
- 高潮（150~最后 50 米）：难度达到顶点，可以有一段 3~4 个机关的连续段（间隔仍要 ≥12 米），速度感拉满。
- 收尾（最后 50 米）：放缓，用一串金币冲刺收尾，让玩家"爽"着到终点。
- 有张有弛：连续 2~3 个机关后留一段金币缓冲，别全程高压。

【机关实战指南（怎么用才好玩）】
- gap 坑：最基础。宽度决定难度（90~120 轻松跳过；170+ 需要长按满跳）。坑边放 1 枚金币当起跳提示。
- lowBar 低横杆 / spikeCeil 顶刺：教玩家滑铲/矮跳。第一次出现前保证玩家已有缓冲。
- spikeTrap 伸缩刺 / hiddenSpike 暗刺：刺有伸出手感，暗刺无预警——两者交替制造"观察-反应"循环，别连放 3 个以上。
- platform 浮空平台：level="mid" 配 coins=3~5，是理想的缓冲节奏点；平台前后地面可以留坑。
- bouncePad 弹跳板：弹得高，常用来衔接 spikeCeil 上方路线或空中金币（coins 的 high 参数）。
- movingPlatform 移动台：amp 振幅 60~120，放在高潮段制造时机判断。
- bait 诱饵金币：故意把金币放坑上方诱惑玩家——高手会识别并绕开，是给进阶玩家的"陷阱幽默"。每关最多 1~2 个。
- fakeCoins 假币 / fakeFloor 假地面 / trapSpring 弹簧：负面奖励机关，克制使用（各 1 个以内），别让玩家觉得被恶意针对。
- pendulum 摆锤 / rollingRock 滚石 / fallingRock 落石：动态压力机关，适合高潮段；出现前最好有 20 米以上纯金币缓冲。
- crusher 压制板 / chaseRock 追石：压迫感强，一关 1 个即可。
- booster 加速带：放缓冲段开头，让玩家瞬间提速追金币，爽点。

【常见错误（务必避免）】
- 输出 markdown 代码块或解释文字（只要 JSON）。
- 只会用 gap 和 coins：请至少用 4 种不同机关让关卡有个性。

【可用机关类型与参数】
${ugcTypeDoc()}

【进阶：自定义机关（mod）——真正自由的创作】
mod 是一小段由游戏真实执行的 JS 代码，你可以用它创造任何机关：飞行道具、追踪物、移动炮台、事件陷阱……随你想象。玩法两步：
1. 定义 mod（onSpawn 开场执行一次；onUpdate 每帧执行）：
"mods": [{
  "id": "blade",
  "name": "旋转刀锋",
  "desc": "贴地滚过来的旋转刀锋，跳过它",
  "onSpawn": "api.fx.float(api.x + 320, api.y - 40, '刀锋出鞘！');",
  "onUpdate": "for (const e of api.hazards('blade')) { e.x += e.dx * api.dt; if (e.x < api.worldX - 260) e.dead = true; if (api.hitPlayer(e)) { api.fx.burst(e.x, e.y, 8, {}); api.kill(); return; } }"
}]
2. 在 plan 里放置实体：[130, "blade", { "gy": 40, "dx": -260, "w": 64, "h": 64 }]
   游戏会自动在 130 米处生成刀锋实体，参数含义：
   - gy: 离地高度（像素，默认 96；y = 地面 - gy；gy=40 是贴地滚刀，跳过它）
   - x: 由米数决定（实体中心），不要在参数里写
   - dx/dy: 每秒移动速度（交给 onUpdate 用 e.dx 驱动）
   - w/h: 碰撞盒宽高（默认 52）
   - spd: 贴图/图形自转速度（默认 7），phase: 初始角度
   - img: 引用 assets 里的图片 id（如 "img": "bg1"），实体就用你的图渲染；PNG/JPG/SVG 都行（SVG 建议写上 width/height 或 viewBox）
可用能力：mod 代码与游戏引擎同作用域——下面这份引擎全量文档里的所有全局对象（G / world / player / FX / Snd）和函数都能直接用；api.* 是官方封装的对外接口，优先用 api，需要底层控制时直接操作全局对象。
${ugcEngineDoc()}
【机制改写速查（api 封装版）】本关内临时生效（与无尽 mod 同一套 API，全都能用）：
- api.player({ jumpMul, gravMul, speedMul, airJumps, magnet, dashSpd, startShield, revive })：改玩家跳跃力/重力/速度/固有空中跳/金币磁吸范围(0~800)/冲刺倍率(1~3)/开局护盾(0~2)/开局复活次数(0~9)
- api.chiyou({ gap, speed, skills, stun })：改蚩尤跟随距离（越小越凶）/追速/技能频率/眩晕秒数
- api.tune('gap', { w: 260 })：改原版机关参数（类型见下方文档，写过的字段之后生成时生效）
- api.bg('图片URL')：换本关背景
- api.revive(n)：立刻给玩家 n 次复活机会；api.on('jump'|'coin'|'death'|'key'|'tap'|'draw', (api, info) => {...})：事件钩子（death 里 api.revive(1) 自动复活；key 自由键位；tap 点按；draw 每帧用全局 ctx 自定义绘制）
- api.timestop(秒)：时停！冻结蚩尤/BOSS 与弹幕（0~10 秒），玩家照常跑跳——做「时间静止」类机制的现成接口
- api.timeScale(倍率, 秒)：真·子弹时间（0.2~2.5 倍全场景变速，倒计时按真实秒走）；api.buff('sprint', 秒?) 直给任意增益；api.coin(n) / api.energy(v) 加扣金币与能量（负数=消费）；api.msg('大字', '小字?') 屏幕公告；api.snd('jump') 播任意音效；api.spawn('coin'|'power', { x?, gy?, ptype? }) 运行时投放金币/道具球
- api.button({ label, fn, x?, y?, w?, h?, color? })：屏幕主动技能按钮（手机可按），onUpdate 里每帧重调才持续显示
- api.hud(key, '文字' | { text, color, size } | { label, val, max, color })：注册屏幕左侧自定义 UI，每帧重写
【JS 使用规则（已完全放开）】
1. 不限制任何 JS 语法与写法：while/for/递归/闭包/直接改全局对象，全部允许。
2. 语法写错了 mod 跑不起来（导入时会提示），写完在脑子里过一遍括号与引号。
3. while(true) 这类真死循环会冻结游戏页面（引擎不再拦截，作者自负）——需要反复执行的逻辑放 onUpdate 每帧跑，或用有限次数/帧计数退出循环。
其他没有任何限制。写真正有创意的机关吧！
另外：创造中心还有独立的「机关mod库」——安装进去的机制/陷阱 mod 会在无尽模式全局生效，玩家/蚩尤/原版机关都能改。

【图片素材（可选）】
想要自定义背景就加：
"assets": [ { "id": "bg1", "name": "我的背景", "src": "这里贴图片的 dataURL 或 http(s) 链接" } ],
"bgAsset": "bg1"
PNG/JPG/SVG（base64 dataURL 如 data:image/svg+xml;base64,...）都支持；机关贴图（plan 里 img 字段引用）和背景共用 assets。图片超过 2MB 就放不下，SVG 矢量图体积小效果佳，优先推荐。

【示例（简单档小样，仅作格式参考）】
{"title":"晨光小径","desc":"轻松的金币小跑","difficulty":"${difficulty}","lenM":240,"speed":330,"plan":[[20,"coins",{"n":3}],[45,"gap",{"w":120}],[70,"coins",{"n":4}],[95,"gap",{"w":140}],[125,"coins",{"n":3}],[150,"platform",{"w":180,"level":"mid","coins":3}],[185,"gap",{"w":120}],[215,"coins",{"n":5}]]}

请直接输出 JSON。`;
}

function ugcTypeDoc() {
  return `- coins      金币(一串)：{ n: 数量3~6, high: 高空金币 }
- fakeCoins  假币陷阱(吃了挨砸)：{ n: 数量 }
- gap        坑(跳过去)：{ w: 宽度像素 }
- fakeFloor  假地面(踩上塌)：{ w: 宽, h: 塌台高度 }
- spikeTrap  伸缩刺(有节奏伸缩)：{ w: 宽 }
- hiddenSpike 暗刺(无预警弹出)：{ w: 宽 }
- trapSpring 陷阱弹簧(踩上被弹飞)：{ w: 宽 }
- crumble    塌陷台(站上开始碎)：{ w: 宽, h: 台高 }
- crusher    压制板(上下压)：{ w: 宽, travel: 下压距离 }
- chaseRock  背后追石(催你加速)：{}
- lowBar     低横杆(按住↓滑铲钻)：{ w: 宽, gapH: 离地间隙 }
- spikeCeil  顶刺(轻点跳=矮跳钻过)：{ w: 宽, low: 288-330 }
- bouncePad  弹跳板(踩上高弹)：{ w: 宽 }
- booster    加速带(瞬间提速)：{ w: 宽 }
- pendulum   摆锤(抓时机过)：{ len: 摆长 }
- rollingRock 滚石(迎面滚来)：{}
- fallingRock 落石(头顶砸落)：{ r: 半径 }
- movingPlatform 移动平台：{ w: 宽, h: 台高, amp: 振幅 }
- platform   浮空平台(可站)：{ w: 宽, level: "low"/"mid"/"high", coins: 台上金币数 }
- bait       诱饵金币(金币下方是坑)：{ w: 坑宽 }
- 自定义机关  你在 mods 里定义的 id：{ gy: 离地高度, dx/dy: 速度, w/h: 碰撞盒, spd: 自转 }`;
}

/* ---------- 内置示例项目（调试 ?ugc= 与新手引导用） ---------- */
function ugcSample() {
  const bg = sampleBgDataURL();
  return verifyUgc({
    title: '示例：旋转刀锋',
    desc: '来自示例：贴地滚来的旋转刀锋机关',
    difficulty: 'normal',
    lenM: 260,
    speed: 350,
    plan: [
      [20, 'coins', { n: 3 }],
      [40, 'gap', { w: 140 }],
      [62, 'coins', { n: 4 }],
      [78, 'platform', { w: 180, level: 'mid', coins: 3 }],
      [110, 'gap', { w: 160 }],
      [130, 'blade', { gy: 44, dx: -260, w: 64, h: 64, spd: 7 }],
      [145, 'gap', { w: 140 }],
      [165, 'coins', { n: 4 }],
      [195, 'blade', { gy: 44, dx: -310, w: 64, h: 64, spd: 9 }],
      [208, 'gap', { w: 150 }],
      [235, 'coins', { n: 5 }],
    ],
    mods: [{
      id: 'blade',
      name: '旋转刀锋',
      desc: '贴地滚来的旋转刀锋，看准跳过它',
      onSpawn: 'api.fx.float(api.x + 320, api.y - 40, "刀锋出鞘！");',
      onUpdate: 'for (const e of api.hazards("blade")) { e.x += e.dx * api.dt; if (e.x < api.worldX - 260) e.dead = true; if (api.hitPlayer(e)) { api.fx.burst(e.x, e.y, 10, { color: "rgba(255,120,90,0.9)" }); api.kill(); return; } }',
    }],
    assets: bg ? [{ id: 'bg1', name: '示例天空', src: bg }] : [],
    bgAsset: bg ? 'bg1' : null,
  }).item;
}

/* 生成一张小尺寸渐变天空图，演示自定义背景 */
function sampleBgDataURL() {
  try {
    const cv2 = document.createElement('canvas');
    cv2.width = 160; cv2.height = 360;
    const c = cv2.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 360);
    g.addColorStop(0, '#ffd9a0');
    g.addColorStop(0.55, '#ffb0b8');
    g.addColorStop(1, '#8fc7f2');
    c.fillStyle = g;
    c.fillRect(0, 0, 160, 360);
    c.fillStyle = 'rgba(255,255,255,0.65)';
    c.beginPath(); c.arc(42, 64, 20, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < 7; i++) {
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.arc(20 + i * 24, 150 + (i % 3) * 18, 14 - (i % 3) * 3, 0, Math.PI * 2);
      c.fill();
    }
    for (let i = 0; i < 6; i++) {
      c.fillStyle = 'rgba(90,180,255,0.45)';
      c.beginPath();
      c.arc((i * 47 + 10) % 170, 300 - (i % 2) * 22, 34 - i * 2, 0, Math.PI * 2);
      c.fill();
    }
    return cv2.toDataURL('image/png');
  } catch (e) { return null; }
}

/* ---------- 无尽模式 mod 专用提示词：机制/陷阱/界面，玩家·蚩尤·原版机关全能改 ---------- */
function ugcModPrompt() {
  return `你是一位《寂零快跑》横版跑酷游戏的 mod 工程师。玩家自动向前奔跑，只能控制跳跃（长按跳更高）与滑铲（按住下），身后蚩尤穷追不舍。请为我设计一组会真实执行的 mod，装进「机关mod库」后在无尽模式全局生效。

【必须输出】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块标记。结构：
{
  "name": "mod包名",
  "mods": [
    { "id": "fireball", "name": "火焰弹", "desc": "迎面飞来的火球，跳过它", "tag": "trap",
      "onUpdate": "for (const e of api.hazards('fireball')) { e.x += e.dx * api.dt; if (e.x < api.worldX - 200) e.dead = true; if (api.hitPlayer(e)) { api.fx.burst(e.x, e.y, 12, {}); api.kill(); } }" },
    ...更多 mod...
  ]
}

【mod 字段】
- id: 英文唯一名（也是陷阱实体类型名，无尽跑道会随机生成该类型实体交给你的 onUpdate 驱动）
- name: 中文名（8 字内）；desc: 一句话说明玩法（30 字内）；tag: trap=机关 / mech=机制 / ui=界面 / fun=整活
- onSpawn: 开局执行一次（注册机制、初始化参数）；onUpdate: 每帧执行（驱动实体、更新 UI）
- img: 可选，陷阱实体贴图。支持 PNG/JPG/SVG（base64 dataURL 或 http 链接）。SVG 记得带 viewBox 与宽高。默认画成旋转刀锋

【三类 mod，至少各来一个】
1. 陷阱/机关（tag: trap）：无尽跑道每隔一段距离自动生成一个你的实体（离地 40~210px、带初速度），你在 onUpdate 里驱动它移动、攻击。用 api.hazards('你的id') 遍历。
2. 机制改写（tag: mech）：onSpawn 里一次性改规则，也可以在 onUpdate 里做动态机制（低血量触发、连击奖励、按距离变难……用 api.stats() 自由发挥）：
   - api.player({ jumpMul: 1.25 }) 跳更高；{ gravMul: 0.8 } 月球重力；{ speedMul: 1.15 } 跑更快；{ airJumps: 1 } 空中二段跳
   - api.player({ magnet: 260 }) 金币磁吸半径(像素)；{ dashSpd: 2 } 冲刺更快；{ startShield: 1 } 开局护盾；{ revive: 1 } 开局复活次数
   - api.chiyou({ gap: 180 }) 蚩尤贴更近更凶；{ skills: 1.5 } 技能更频繁；{ stun: 2 } 立即踉跄 2 秒
   - api.tune('gap', { w: 300 }) 之后生成的坑更宽；api.tune('spikeTrap', { w: 200 }) 刺更宽
   - api.bg('图片URL') 换背景；api.revive(1) 立刻加一次复活
   - 事件钩子（在 onSpawn 里注册）：api.on('jump', (api, info) => {...}) 每次起跳；api.on('coin', (api, info) => {...}) 每次吃金币（info.x/y/combo）；api.on('death', (api, info) => {...}) 玩家死亡时（info.cause 是死因，可在钩子里 api.revive(1) 实现自动复活）
3. 自定义 UI（tag: ui）：onUpdate 里用 api.hud(key, 内容) 在屏幕左侧注册显示：
   - 文本：api.hud('tip', '反伤护盾已开启')
   - 带样式：api.hud('tip', { text: '危险！', color: '#ff8f7e', size: 22 })
   - 进度条：api.hud('bar', { label: '蚩尤狂暴', val: api.dist() > 200 ? 30 : 90, max: 100, color: '#ff8f7e' })
   key 相同每帧覆盖；每帧都要重写（不写就不显示）。

【完整 api + 引擎全量文档】
mod 代码与游戏引擎同作用域——下面文档里的所有全局对象（G / world / player / FX / Snd）和函数都能直接用；api.* 是官方封装的对外接口，优先用 api，需要底层控制时直接操作全局对象。
${ugcEngineDoc()}

【可 tune 的原版机关字段】
gap.w 坑宽 / spikeTrap.w 刺宽 / hiddenSpike.w 暗刺宽 / fakeFloor.w 假地面宽 / lowBar.w·gapH 低杆 / spikeCeil.low 顶刺高 / platform.h 平台高 / bouncePad.pow 弹力 / crusher.travel 压程 / pendulum.len·amp·spd 摆锤 / rollingRock.vx 滚石速 / movingPlatform.amp 移动台

【JS 使用规则（已完全放开）】
1. 不限制任何 JS 语法与写法：while/for/递归/闭包/直接改全局对象，全部允许。
2. 语法写错了 mod 跑不起来（导入时会提示），字符串里的引号要用 \\' 或 \" 转义好。
3. while(true) 这类真死循环会冻结游戏页面（引擎不再拦截，作者自负）——需要反复执行的逻辑放 onUpdate 每帧跑，或用有限次数/帧计数退出循环。
其余完全自由：追踪导弹、弹簧鞋、时间减速、蚩尤狂暴条、boss 召唤……敢想就写。

【示例输出（3 个 mod 的最小包，仅作格式参考）】
{"name":"新手包","mods":[{"id":"fireball","name":"火焰弹","desc":"迎面飞来的火球，跳过它","tag":"trap","onUpdate":"for (const e of api.hazards('fireball')) { e.x += e.dx * api.dt; if (e.x < api.worldX - 200) e.dead = true; if (api.hitPlayer(e)) { api.fx.burst(e.x, e.y, 12, {}); api.kill(); } }"},{"id":"boots","name":"疾风之靴","desc":"跑得更快跳得更高","tag":"mech","onSpawn":"api.player({ jumpMul: 1.15, speedMul: 1.1 });"},{"id":"danger","name":"危险仪表","desc":"实时显示蚩尤距离","tag":"ui","onUpdate":"const d = api.dist(); api.hud('danger', { label: '蚩尤距离', val: Math.max(0, 600 - d), max: 600, color: d < 180 ? '#ff5a4a' : '#ffd34d' });"}]}

请直接输出 JSON。`;
}

/* ---------- 内置示例 mod 包（机关mod库「载入示例」用） ---------- */
function ugcModSample() {
  return verifyModsPack({
    name: '官方示例包',
    mods: [
      {
        id: 'fireball', name: '火焰弹', desc: '迎面飞来的火球，看准跳过它', tag: 'trap',
        onSpawn: 'api.fx.float(api.x + 320, api.y - 60, "火焰弹上膛！");',
        onUpdate: 'for (const e of api.hazards("fireball")) { e.x += e.dx * api.dt; e.y += Math.sin(api.time() * 5 + (e.phase || 0)) * 46 * api.dt; if (e.x < api.worldX - 220) e.dead = true; if (api.hitPlayer(e)) { api.fx.burst(e.x, e.y, 14, { color: "#ff9a5a" }); api.fx.float(e.x, e.y - 40, "烧到了！"); api.kill(); } }',
      },
      {
        id: 'boots', name: '疾风之靴', desc: '跑得更快、跳得更高', tag: 'mech',
        onSpawn: 'api.player({ jumpMul: 1.15, speedMul: 1.1 }); api.fx.float(api.x + 200, api.y - 80, "疾风之靴：已生效！");',
        onUpdate: 'api.hud("boots", { text: "疾风之靴 · 跳跃力/速度 +15%", color: "#8ce8ff", size: 17 });',
      },
      {
        id: 'danger', name: '危险仪表', desc: '实时显示与蚩尤的距离', tag: 'ui',
        onUpdate: 'const d = api.dist(); api.hud("danger", { label: "蚩尤距离", val: Math.max(0, 600 - d), max: 600, color: d < 180 ? "#ff5a4a" : "#ffd34d" }); if (d < 150) api.hud("warn", { text: "危险！蚩尤逼近！", color: "#ff5a4a", size: 20 });',
      },
      {
        id: 'widegap', name: '深渊裂隙', desc: '坑都变得更宽更吓人', tag: 'mech',
        onSpawn: 'api.tune("gap", { w: 320 });',
      },
      {
        id: 'timestop', name: '时停术', desc: '按 E 或点右下按钮：冻结蚩尤 2.5 秒', tag: 'fun',
        onSpawn: 'const go = () => { if ((G._tsCd || 0) > 0) return; G._tsCd = 6; api.timestop(2.5); FX.flashScreen("#8cd0ff", 0.15); FX.sfloat(W / 2, 300, "时停！", { color: "#8cd0ff", size: 34, life: 1.2 }); Snd.fever(); }; G._tsGo = go; api.on("key", (a, i) => { if (i.code === "KeyE") go(); });',
        onUpdate: 'if ((G._tsCd || 0) > 0) { G._tsCd -= api.dt; api.hud("ts", { label: "时停冷却", val: 6 - G._tsCd, max: 6, color: "#8cd0ff" }); } api.button({ label: "时停", color: "#2c6199", fn: () => G._tsGo && G._tsGo() });',
      },
      {
        id: 'bullettime', name: '子弹时间', desc: '按 B 或点右下按钮：全世界慢放 3 秒', tag: 'fun',
        onSpawn: 'const go = () => { if ((G._btCd || 0) > 0) return; G._btCd = 9; api.timeScale(0.4, 3); api.msg("子弹时间", "世界慢放 3 秒"); FX.flashScreen("#9fd8ff", 0.18); Snd.fever(); }; G._btGo = go; api.on("key", (a, i) => { if (i.code === "KeyB") go(); });',
        onUpdate: 'if ((G._btCd || 0) > 0) { G._btCd -= api.dt; api.hud("bt", { label: "慢放冷却", val: 9 - G._btCd, max: 9, color: "#9fd8ff" }); } api.button({ label: "慢放", color: "#2c6199", fn: () => G._btGo && G._btGo() });',
      },
    ],
  });
}