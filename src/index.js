/**
 * B站弹幕宠物挂机 - 单房间修炼版 v6
 * 核心逻辑：同一时间只在一个房间修炼，关播后才切换到下一个房间
 * 每轮对当前房间执行：
 *   - 签到（每天一次）
 *   - 修炼（每轮都发，12秒后校验经验增量）
 *   - 突破（仅当前经验 >= 满经验时才发）
 * 等待期间每60秒发一次心跳保活，维持直播间在线状态
 */

const https = require('https');
const http = require('http');
const tls = require('tls');

// ==============================
// 配置
// ==============================
const COOKIE = process.env.BILIBILI_COOKIE || '';
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '';  // 首选房间；为空则自动扫房
const CYCLE_MINUTES = parseInt(process.env.CYCLE_MINUTES || '6', 10);       // 修炼间隔（默认6分钟，贴近冷却期）
const MAX_RUNTIME_MINUTES = parseInt(process.env.MAX_RUNTIME_MINUTES || '55', 10); // 最大运行时长（默认55分钟）
const MAIL_USER = process.env.QQ_MAIL_USER || '';
const MAIL_PASS = process.env.QQ_MAIL_PASS || '';

// 边界AI签到配置
const YYAI_TOKEN = process.env.YYAI_TOKEN || '';
const YYAI_ACCESS_TOKEN = process.env.YYAI_ACCESS_TOKEN || '';
const YYAI_UID = process.env.YYAI_UID || '';

// 已验证有弹幕宠物的备用直播间（2026-04-17 扫描）
// 关播后自动轮换：依次尝试列表中的房间，找到开播且有蛋宠的就用
const BACKUP_PET_ROOMS = [
  '1788399444',  // 24小时弹幕宠物，乱斗经验房
  '5456135',     // 【弹幕宠物】听雨助眠养宠物修仙
  '1944499601',  // 弹幕宠物修仙24小时玩法
  '1775716505',  // 随缘接调音混音编曲 24小时挂宠物
  '31117119',    // 七宝粉丝狂欢节
  '58748',       // 修炼房
  '22715338',    // 日常
  '1962484529',  // 日常
  '1993208412',  // 日常
  '1786984737',  // 日常
  '1827737362',  // 日常
  '1733584032',  // 日常
  '1895286111',  // 日常
];

const CSRF = (COOKIE.match(/bili_jct=([^;]+)/) || [])[1] || '';
const CSRF_TOKEN = CSRF;

// ==============================
// 状态
// ==============================
const signedRooms = new Set();        // 今天已签到的房间
let lastSigninDate = getTodayCST();   // 上次签到日期（北京时间）
const roomPanelCache = new Map();     // roomId -> { gameId, panelUrl, energy } 面板缓存

function getTodayCST() {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, '0')}-${String(cst.getUTCDate()).padStart(2, '0')}`;
}

// ==============================
// 工具函数
// ==============================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const log = msg => console.log(`[${now()}] ${msg}`);
const warn = msg => console.warn(`[${now()}] ⚠️  ${msg}`);
const err = msg => console.error(`[${now()}] ❌  ${msg}`);

// ==============================
// HTTP 请求
// ==============================
function request(opts, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data, code: -999 }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy());
    if (postData) req.write(postData);
    req.end();
  });
}

function apiGet(path) {
  return request({ hostname: 'api.bilibili.com', path, method: 'GET', headers: { 'Cookie': COOKIE, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
}

function liveGet(path) {
  return request({
    hostname: 'api.live.bilibili.com', path, method: 'GET',
    headers: {
      'Cookie': COOKIE,
      'Referer': 'https://live.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
}

function livePost(path, body, roomId) {
  return request({
    hostname: 'api.live.bilibili.com', path, method: 'POST',
    headers: {
      'Cookie': COOKIE,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://live.bilibili.com',
      'Priority': 'u=1, i',
      'Referer': `https://live.bilibili.com/${roomId}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  }, body);
}

// ==============================
// 邮件通知
// ==============================
async function sendMail(subject, body) {
  if (!MAIL_USER || !MAIL_PASS) return warn('未配置邮件');
  const boundary = '----=_NodeMailer_' + Date.now();
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  const msg = [
    `From: =?UTF-8?B?${Buffer.from('B站挂机').toString('base64')}?= <${MAIL_USER}>`,
    `To: ${MAIL_USER}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyB64, `--${boundary}--`
  ].join('\r\n');

  return new Promise(resolve => {
    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {
      let step = 0, buf = '';
      const send = cmd => socket.write(cmd + '\r\n');
      socket.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\r\n'); buf = lines.pop();
        for (const line of lines) {
          if (step === 0 && line.startsWith('220')) { send('EHLO smtp.qq.com'); step = 1; }
          else if (step === 1 && line.includes('250')) { send(`AUTH PLAIN ${Buffer.from('\0' + MAIL_USER + '\0' + MAIL_PASS).toString('base64')}`); step = 2; }
          else if (step === 2 && line.startsWith('235')) { send(`MAIL FROM:<${MAIL_USER}>`); step = 3; }
          else if (step === 3 && line.startsWith('250')) { send(`RCPT TO:<${MAIL_USER}>`); step = 4; }
          else if (step === 4 && line.startsWith('250')) { send('DATA'); step = 5; }
          else if (step === 5 && line.startsWith('354')) { send(msg + '\r\n.'); step = 6; }
          else if (step === 6 && line.startsWith('250')) { send('QUIT'); socket.destroy(); resolve(true); }
          else if (line.startsWith('5') || line.startsWith('4')) { warn('SMTP错误: ' + line); socket.destroy(); resolve(false); }
        }
      });
      socket.setTimeout(15000, () => { socket.destroy(); resolve(false); });
    });
  });
}

async function notifyCookieInvalid(reason) {
  await sendMail('B站挂机Cookie失效', `时间：${now()}\n原因：${reason}\n请更新GitHub Secrets中的BILIBILI_COOKIE`);
}

// ==============================
// B站操作
// ==============================
async function checkLogin() {
  if (!COOKIE || !CSRF) { await notifyCookieInvalid('Cookie未配置'); return false; }
  const res = await apiGet('/x/web-interface/nav').catch(() => ({ code: -1 }));
  if (res.code === 0 && res.data?.isLogin) { log(`已登录: ${res.data.uname}`); return true; }
  await notifyCookieInvalid(`code=${res.code}`);
  return false;
}

async function getRoomStatus(roomId) {
  const res = await liveGet(`/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`);
  return res.code === 0 ? res.data?.room_info?.live_status === 1 : false;
}

async function enterRoom(roomId) {
  const body = `room_id=${roomId}&csrf=${CSRF}&csrf_token=${CSRF_TOKEN}`;
  return (await livePost('/xlive/web-room/v1/index/roomEntryAction', body, roomId)).code === 0;
}

async function sendDanmu(roomId, msg) {
  const rnd = Math.floor(Date.now() / 1000);
  const bodyParams = new URLSearchParams({
    bubble: '0',
    msg: msg,
    color: '16777215',
    mode: '1',
    roomtype: '0',
    jumpfrom: '84001',
    reply_mid: '0',
    reply_attr: '0',
    replay_dmid: '',
    fontsize: '25',
    rnd: rnd.toString(),
    roomid: roomId,
    csrf: CSRF,
    csrf_token: CSRF_TOKEN
  });
  const body = bodyParams.toString();
  const res = await livePost('/msg/send', body, roomId);

  if (res.code !== 0) {
    log(`弹幕 "${msg}" 失败，响应: ${JSON.stringify(res)}`);
  }
  return res.code === 0;
}

// 心跳保活间隔（动态更新，首次默认60秒）
let nextHeartbeatInterval = 60;

async function heartbeat(roomId) {
  // B站直播心跳接口：GET live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat
  // hb 参数 = base64("{interval}|{真实房间号}|1|0")
  const hbRaw = `${nextHeartbeatInterval}|${roomId}|1|0`;
  const hbEncoded = Buffer.from(hbRaw).toString('base64');
  const path = `/xlive/rdata-interface/v1/heartbeat/webHeartBeat?hb=${encodeURIComponent(hbEncoded)}&pf=web`;
  try {
    const res = await request({
      hostname: 'live-trace.bilibili.com',
      path: path,
      method: 'GET',
      headers: {
        'Cookie': COOKIE,
        'Referer': `https://live.bilibili.com/${roomId}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (res.code === 0 && res.data?.next_interval) {
      nextHeartbeatInterval = res.data.next_interval;
    }
    return res.code === 0;
  } catch (e) {
    return false;
  }
}

// ==============================
// 宠物面板 - 经验读取
// ==============================

function fetchHtml(targetUrl, referer = '', noCache = false) {
  return new Promise((resolve, reject) => {
    const follow = (url, hops = 0) => {
      if (hops > 4) return reject(new Error('跳转次数过多'));
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      let path = u.pathname + u.search;
      if (noCache) {
        path += (u.search ? '&' : '?') + '_t=' + Date.now();
      }
      const opts = {
        hostname: u.hostname,
        path: path,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': referer || url,
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        }
      };
      const req = lib.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return follow(next, hops + 1);
        }
        let html = '';
        res.on('data', c => { html += c; });
        res.on('end', () => {
          const m = html.match(/Object moved to <a href="([^"]+)"/i);
          if (m && hops < 4) {
            const next = new URL(m[1], url).toString();
            return follow(next, hops + 1);
          }
          resolve(html);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('fetchHtml 超时')));
      req.end();
    };
    follow(targetUrl);
  });
}

async function getPanelUrl(roomId) {
  const cached = roomPanelCache.get(roomId);
  if (cached?.panelUrl) {
    log(`[面板] 房间 ${roomId} 使用缓存 panel_url`);
    return cached;
  }

  log(`[面板] 获取房间 ${roomId} 的 panel_url`);
  let html = '';
  try {
    html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
  } catch (e) {
    warn(`[面板] 房间页面请求失败: ${e.message}`);
    return null;
  }
  if (!html || html.length < 100) {
    warn(`[面板] 房间页面内容异常（${html.length} 字节）`);
    return null;
  }

  const tagMatch = html.match(/"interactive_game_tag":\{"action":\d+,"game_id":"([^"]+)","game_name":"([^"]+)"/);
  let gameId = tagMatch ? tagMatch[1] : '';
  const gameName = tagMatch ? tagMatch[2] : '';

  if (tagMatch) {
    log(`[面板] game_id="${gameId}" game_name="${gameName}"`);
  } else {
    warn('[面板] interactive_game_tag 未匹配');
    return null;
  }

  if (!gameName.includes('弹幕宠物') && !gameName.includes('蛋宠')) {
    warn(`[面板] game_name="${gameName}" 不含弹幕宠物/蛋宠，跳过`);
    return null;
  }

  let res;
  try {
    res = await request({
      hostname: 'api.live.bilibili.com',
      path: `/xlive/open-platform/v1/game/getAppCustomPanel?game_id=${encodeURIComponent(gameId)}`,
      method: 'GET',
      headers: {
        'Cookie': COOKIE,
        'Referer': `https://live.bilibili.com/${roomId}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
  } catch (e) {
    warn(`[面板] getAppCustomPanel 异常: ${e.message}`);
    return null;
  }

  if (!res || res.code !== 0) {
    warn(`[面板] getAppCustomPanel 错误: code=${res?.code}`);
    return null;
  }

  const url = res?.data?.panel_url || res?.data?.list?.[0]?.panel_url;
  if (!url || !url.includes('heikeyun')) {
    warn(`[面板] panel_url 无效`);
    return null;
  }

  log(`[面板] panel_url: ${url.slice(0, 120)}`);
  const meta = { gameId, panelUrl: url, energy: null };
  roomPanelCache.set(roomId, meta);
  return meta;
}

async function getPetEnergy(roomId) {
  const meta = await getPanelUrl(roomId);
  if (!meta) return null;

  let panelHtml = '';
  try {
    panelHtml = await fetchHtml(meta.panelUrl, `https://live.bilibili.com/${roomId}`, true);
  } catch (e) {
    warn(`[经验] 面板请求失败: ${e.message}`);
    return null;
  }
  if (!panelHtml) return null;

  const cur  = panelHtml.match(/id="lblUserEnergy2"[^>]*>([^<]+)</);
  const full = panelHtml.match(/id="lblUserEnergyDown"[^>]*>([^<]+)</);
  const lv   = panelHtml.match(/id="lblUserLevel"[^>]*>([^<]+)</);
  const lvN  = panelHtml.match(/id="lblUserLevelName"[^>]*>([^<]+)</);

  if (!cur || !full) {
    warn('[经验] 未找到经验字段');
    return null;
  }

  const current = parseInt(cur[1].trim(), 10);
  const total   = parseInt(full[1].trim(), 10);
  const result = { current, total, level: lv ? lv[1].trim() : '?', levelName: lvN ? lvN[1].trim() : '?' };
  log(`[经验] 房间 ${roomId}: ${current}/${total}（Lv.${result.level} ${result.levelName}）`);

  meta.energy = result;
  return result;
}

// ==============================
// 边界AI签到
// ==============================
async function doYyaiSignin() {
  if (!YYAI_TOKEN || !YYAI_ACCESS_TOKEN || !YYAI_UID) {
    log('边界AI签到: 未配置，跳过');
    return;
  }
  log('=== 边界AI每日签到 ===');
  const body = '{}';
  try {
    const res = await request({
      hostname: 'api.ai1foo.com',
      path: '/api/v2/user/signin/do',
      method: 'POST',
      headers: {
        'access-token': YYAI_ACCESS_TOKEN,
        'app-name': 'bianjie',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'origin': 'https://yyai8.com',
        'referer': 'https://yyai8.com/',
        'token': YYAI_TOKEN,
        'uid': YYAI_UID,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    }, body);
    const msg = res.msg || res.message || '';
    if (msg.includes('已签到') || msg.includes('already')) {
      log('边界AI签到: 今日已签到');
    } else if (res.code === 0 || res.success) {
      log('边界AI签到: ✅ 成功');
    } else {
      warn(`边界AI签到: ⚠️ 失败 - ${msg}`);
    }
  } catch (e) {
    warn(`边界AI签到: ❌ 异常 - ${e.message}`);
  }
}

// ==============================
// 房间查找
// ==============================

async function roomHasPetTag(roomId) {
  try {
    const html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
    if (!html || html.length < 500) return false;
    if (html.includes('interactive_game_tag') && html.includes('弹幕宠物')) return true;
    if (html.includes('interactive_game_tag') && html.includes('蛋宠')) return true;
    return false;
  } catch {
    return false;
  }
}

// 找到第一个开播且有蛋宠的房间（优先使用配置的首选房间）
async function findFirstAvailableRoom() {
  const candidates = HANGUP_ROOM_ID ? [HANGUP_ROOM_ID, ...BACKUP_PET_ROOMS] : [...BACKUP_PET_ROOMS];
  const unique = [...new Set(candidates)];

  log(`[找房] 依次检测 ${unique.length} 个候选房间，找到第一个可用即停...`);

  for (const id of unique) {
    try {
      const isLive = await getRoomStatus(id);
      if (!isLive) {
        log(`[找房] 房间 ${id} 未开播，跳过`);
        continue;
      }

      // HANGUP_ROOM_ID 信任为有蛋宠，跳过页面验证
      if (id === HANGUP_ROOM_ID) {
        log(`[找房] ✅ 房间 ${id}（配置房）开播，使用此房间`);
        return id;
      }

      const hasPet = await roomHasPetTag(id);
      if (hasPet) {
        log(`[找房] ✅ 房间 ${id} 开播且有蛋宠，使用此房间`);
        return id;
      } else {
        log(`[找房] 房间 ${id} 开播但无蛋宠，跳过`);
      }
    } catch (e) {
      warn(`[找房] 房间 ${id} 检测异常: ${e.message}`);
    }

    await sleep(1000);
  }

  return null;
}

// ==============================
// 单房间单轮执行
// ==============================
async function runOneCycle(roomId, cycleIndex) {
  log(`--- 房间 ${roomId} 第 ${cycleIndex} 轮 ---`);

  await heartbeat(roomId);

  // 检查日期，跨天重置签到记录
  const today = getTodayCST();
  if (today !== lastSigninDate) {
    signedRooms.clear();
    lastSigninDate = today;
    log(`[签到] 新的一天（${today}），重置签到记录`);
  }

  await sleep(2000);

  // 签到：每天每房间只一次
  if (signedRooms.has(roomId)) {
    log(`[房间 ${roomId}] 签到: 今日已签到，跳过`);
  } else {
    const signinOk = await sendDanmu(roomId, '签到');
    log(`[房间 ${roomId}] 签到: ${signinOk ? '✅' : '❌'}`);
    if (signinOk) signedRooms.add(roomId);
    await sleep(2000);
  }

  // 修炼：先读当前经验，再发弹幕，等 12 秒后复查经验增量
  let cultivateOk = false;
  let energyBefore = await getPetEnergy(roomId).catch(() => null);
  if (energyBefore) {
    log(`[房间 ${roomId}] 修炼前经验: ${energyBefore.current}/${energyBefore.total}（Lv.${energyBefore.level} ${energyBefore.levelName}）`);
  }

  cultivateOk = await sendDanmu(roomId, '修炼');
  log(`[房间 ${roomId}] 修炼弹幕: ${cultivateOk ? '✅' : '❌'}`);

  if (cultivateOk) {
    log(`[房间 ${roomId}] 等待 12 秒后校验经验增量...`);
    await sleep(12000);
    const energyAfter = await getPetEnergy(roomId).catch(() => null);
    if (energyAfter && energyBefore) {
      const delta = energyAfter.current - energyBefore.current;
      if (delta > 0) {
        log(`[房间 ${roomId}] ✅ 修炼成功！经验 ${energyBefore.current} → ${energyAfter.current}（增量 +${delta}）`);
      } else {
        warn(`[房间 ${roomId}] 修炼后经验无增长（增量 ${delta}），可能处于冷却期`);
      }
    } else if (energyAfter) {
      log(`[房间 ${roomId}] 修炼后经验: ${energyAfter.current}/${energyAfter.total}（Lv.${energyAfter.level} ${energyAfter.levelName}）`);
    }
  } else {
    await sleep(2000);
  }

  // 突破：使用修炼后已读取的经验，满经验才发
  let breakthroughSent = false;
  const energy = await getPetEnergy(roomId).catch(() => null);
  if (energy) {
    if (energy.current >= energy.total) {
      log(`[房间 ${roomId}] 经验已满 (${energy.current}/${energy.total})，发送突破`);
      const btOk = await sendDanmu(roomId, '突破');
      log(`[房间 ${roomId}] 突破: ${btOk ? '✅' : '❌'}`);
      breakthroughSent = btOk;

      if (btOk) {
        log(`[房间 ${roomId}] 等待 12 秒后复查突破结果...`);
        await sleep(12000);
        const energyAfter = await getPetEnergy(roomId).catch(() => null);
        if (energyAfter) {
          const delta = energyAfter.current - energy.current;
          log(`[房间 ${roomId}] 突破后经验: ${energyAfter.current}/${energyAfter.total}（变化 ${delta >= 0 ? '+' : ''}${delta}）`);
          if (energyAfter.total !== energy.total || energyAfter.level !== energy.level) {
            log(`[房间 ${roomId}] ✅ 突破确认生效！等级 ${energy.level} → ${energyAfter.level}，上限 ${energy.total} → ${energyAfter.total}`);
            roomPanelCache.delete(roomId);
          }
        }
      }
    } else {
      log(`[房间 ${roomId}] 经验未满 (${energy.current}/${energy.total})，跳过突破`);
    }
  } else {
    log(`[房间 ${roomId}] 无法读取经验，跳过突破`);
  }

  return { signinOk: signedRooms.has(roomId), cultivateOk, breakthroughSent, energy };
}

// ==============================
// 主逻辑：单房间修炼，关播换房
// ==============================
async function main() {
  log('=== B站弹幕宠物挂机 v6 单房间修炼+心跳保活版启动 ===');

  if (!await checkLogin()) process.exit(1);

  await doYyaiSignin();

  const maxMs = MAX_RUNTIME_MINUTES * 60 * 1000;
  const cycleMs = CYCLE_MINUTES * 60 * 1000;
  const startTime = Date.now();

  const stats = {
    totalCycles: 0,
    totalSignin: 0,
    totalCultivate: 0,
    totalBreakthrough: 0,
    roomsUsed: 0,
    roomSwitches: 0,
  };

  // 当前修炼的房间
  let currentRoomId = null;
  let cycle = 1;

  while (Date.now() - startTime < maxMs) {
    log(`\n${'='.repeat(50)}`);
    log(`第 ${cycle} 轮 | 已运行 ${Math.floor((Date.now() - startTime) / 60000)} 分钟 / 上限 ${MAX_RUNTIME_MINUTES} 分钟`);
    log(`${'='.repeat(50)}`);

    // ── 如果还没有当前房间，或者当前房间关播了，就找新房 ──
    if (!currentRoomId) {
      const found = await findFirstAvailableRoom();
      if (!found) {
        warn('没有找到任何可用的蛋宠房间');
        // 等待一个周期后再试
        const remaining = maxMs - (Date.now() - startTime);
        if (remaining <= cycleMs) { log('剩余时间不足，结束'); break; }
        log(`等待 ${CYCLE_MINUTES} 分钟后重新找房...`);
        await sleep(cycleMs);
        cycle++;
        continue;
      }
      currentRoomId = found;
      stats.roomsUsed++;
      log(`[换房] ✅ 进入房间 ${currentRoomId} 开始修炼`);
      await enterRoom(currentRoomId);
      await sleep(2000);
    }

    // ── 检查当前房间是否还开播 ──
    const isLive = await getRoomStatus(currentRoomId).catch(() => false);
    if (!isLive) {
      warn(`[换房] 房间 ${currentRoomId} 已关播！寻找下一个房间...`);
      currentRoomId = null;
      roomPanelCache.clear(); // 换房清缓存
      stats.roomSwitches++;
      continue; // 立即重新找房，不等周期
    }

    // ── 在当前房间执行一轮修炼 ──
    try {
      const result = await runOneCycle(currentRoomId, cycle);

      if (result.cultivateOk) stats.totalCultivate++;
      if (result.breakthroughSent) stats.totalBreakthrough++;
      if (result.signinOk) stats.totalSignin++;
    } catch (e) {
      warn(`[房间 ${currentRoomId}] 本轮异常: ${e.message}`);
    }

    stats.totalCycles++;
    cycle++;

    // ── 检查剩余时间 ──
    const remaining = maxMs - (Date.now() - startTime);
    if (remaining <= cycleMs) {
      log('剩余时间不足一个周期，结束挂机');
      break;
    }

    log(`等待 ${CYCLE_MINUTES} 分钟后进入下一轮（期间心跳保活）...`);
    // 在等待期间按服务器返回的间隔发心跳，维持直播间在线状态
    const waitStart = Date.now();
    const waitMs = cycleMs;
    let hbCount = 0;
    while (Date.now() - waitStart < waitMs) {
      const hbIntervalMs = nextHeartbeatInterval * 1000;
      const remaining = waitMs - (Date.now() - waitStart);
      if (remaining <= hbIntervalMs) {
        await sleep(remaining);
        break;
      }
      await sleep(hbIntervalMs);
      // 心跳保活
      if (currentRoomId) {
        const hbOk = await heartbeat(currentRoomId).catch(() => false);
        hbCount++;
        if (hbOk) {
          log(`[心跳] 房间 ${currentRoomId} 保活 ✅（下次间隔 ${nextHeartbeatInterval}s）`);
        } else {
          warn(`[心跳] 房间 ${currentRoomId} 保活失败`);
        }
        // 每3次心跳检查一次房间是否关播（避免请求太频繁）
        if (hbCount % 3 === 0) {
          const stillLive = await getRoomStatus(currentRoomId).catch(() => true);
          if (!stillLive) {
            warn(`[换房] 房间 ${currentRoomId} 已关播！立即切换...`);
            currentRoomId = null;
            roomPanelCache.clear();
            stats.roomSwitches++;
            break;
          }
        }
      }
    }
  }

  // 最终汇总
  log(`\n${'='.repeat(50)}`);
  log('=== 挂机结束 ===');
  log(`总轮次: ${stats.totalCycles}`);
  log(`使用房间数: ${stats.roomsUsed}`);
  log(`换房次数: ${stats.roomSwitches}`);
  log(`修炼成功: ${stats.totalCultivate}`);
  log(`签到成功: ${stats.totalSignin}`);
  log(`突破次数: ${stats.totalBreakthrough}`);
  log(`总运行: ${Math.floor((Date.now() - startTime) / 60000)} 分钟`);
  log(`${'='.repeat(50)}`);

  return stats;
}

main().catch(e => { err(e.message); process.exit(1); });
