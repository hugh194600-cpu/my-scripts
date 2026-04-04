﻿/**
 * B站弹幕宠物挂机 - 精简版
 * 逻辑：进入直播间 → 每10分钟循环（弹幕签到 → 弹幕修炼 → 突破检测）
 *       经验与升级结果仍通过蛋宠面板复查，直播间关播后自动换房继续
 */



const net = require('net');
const tls = require('tls');
const https = require('https');
const http  = require('http');

// ==============================
// 配置
// ==============================
const COOKIE        = process.env.BILIBILI_COOKIE || '';
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '';
const CYCLE_MINUTES = Math.max(1, parseInt(process.env.CYCLE_MINUTES || '10', 10));
// 总运行时长（分钟），GitHub Actions 默认 350 分钟留 10 分钟余量
const MAX_RUNTIME_MINUTES = Math.max(5, parseInt(process.env.MAX_RUNTIME_MINUTES || '350', 10));
// 操作间隔（毫秒），沿用旧变量名兼容现有 workflow / secrets
const DANMU_GAP_MS  = Math.max(2000, parseInt(process.env.DANMU_GAP_MS || '3000', 10));

const MAIL_USER     = process.env.QQ_MAIL_USER || '';
const MAIL_PASS     = process.env.QQ_MAIL_PASS || '';

// 【新增】突破前最多连续修炼次数（防止低等级永远等不满）
const BREAKTHROUGH_MAX_CULTIVATIONS = Math.max(3, parseInt(process.env.BREAKTHROUGH_MAX_CULTIVATIONS || '8', 10));
// 【新增】每次修炼后等待秒数（给面板刷新时间）
const CULTIVATION_WAIT_SECONDS = Math.max(10, parseInt(process.env.CULTIVATION_WAIT_SECONDS || '14', 10));

// 边界AI签到配置
const YYAI_TOKEN        = process.env.YYAI_TOKEN || '';
const YYAI_ACCESS_TOKEN = process.env.YYAI_ACCESS_TOKEN || '';
const YYAI_UID          = process.env.YYAI_UID || '';


const CSRF     = extractCsrf(COOKIE);
const AUTO_UID = extractUid(COOKIE);

function extractCsrf(cookie) {
  const m = cookie.match(/bili_jct=([^;]+)/);
  return m ? m[1].trim() : '';
}
function extractUid(cookie) {
  const m = cookie.match(/DedeUserID=([^;]+)/);
  return m ? m[1].trim() : '';
}

// ==============================
// 工具
// ==============================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function now() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function log(msg)  { console.log(`[${now()}] ${msg}`); }
function warn(msg) { console.warn(`[${now()}] ⚠️  ${msg}`); }
function err(msg)  { console.error(`[${now()}] ❌ ${msg}`); }
function ok(msg)   { console.log(`[${now()}] ✅ ${msg}`); }

// ==============================
// 邮件通知
// ==============================
function sendMail(subject, body) {
  return new Promise((resolve) => {
    if (!MAIL_USER || !MAIL_PASS) {
      warn('未配置 QQ 邮件通知（QQ_MAIL_USER / QQ_MAIL_PASS）');
      return resolve(false);
    }

    const boundary = '----=_NodeMailer_' + Date.now();
    const bodyB64 = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
    const message = [
      `From: =?UTF-8?B?${Buffer.from('B站挂机助手').toString('base64')}?= <${MAIL_USER}>`,
      `To: ${MAIL_USER}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
      `--${boundary}--`,
    ].join('\r\n');

    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {});
    let step = 0;
    let buf = '';

    const send = (cmd) => { socket.write(cmd + '\r\n'); };

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (step === 0 && line.startsWith('220')) {
          send('EHLO smtp.qq.com'); step = 1;
        } else if (step === 1 && line.includes('250')) {
          const auth = Buffer.from('\0' + MAIL_USER + '\0' + MAIL_PASS).toString('base64');
          send(`AUTH PLAIN ${auth}`); step = 2;
        } else if (step === 2 && line.startsWith('235')) {
          send(`MAIL FROM:<${MAIL_USER}>`); step = 3;
        } else if (step === 3 && line.startsWith('250')) {
          send(`RCPT TO:<${MAIL_USER}>`); step = 4;
        } else if (step === 4 && line.startsWith('250')) {
          send('DATA'); step = 5;
        } else if (step === 5 && line.startsWith('354')) {
          send(message + '\r\n.'); step = 6;
        } else if (step === 6 && line.startsWith('250')) {
          send('QUIT'); socket.destroy(); resolve(true);
        } else if (line.startsWith('5') || line.startsWith('4')) {
          warn(`SMTP错误: ${line}`);
          socket.destroy(); resolve(false);
        }
      }
    });

    socket.on('error', (e) => {
      warn(`邮件连接错误: ${e.message}`);
      resolve(false);
    });
    socket.setTimeout(15000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function notifyCookieInvalid(reason) {
  const subject = 'B站挂机 Cookie 失效通知';
  const body = [
    '检测到当前 GitHub Actions 挂机任务无法通过 B站登录校验。',
    '',
    `时间：${now()}`,
    `原因：${reason}`,
    '处理建议：更新 GitHub Secrets 中的 BILIBILI_COOKIE 后重新运行 hangup workflow。',
  ].join('\n');

  const mailed = await sendMail(subject, body);
  log(mailed ? 'Cookie 失效通知邮件已发送' : 'Cookie 失效通知邮件未发送成功');
}

// ==============================
// HTTP 请求
// ==============================

function request(opts, postData = null) {
  return new Promise((resolve, reject) => {
    const lib = opts.hostname && opts.hostname.includes('bilibili') ? https : http;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve({ raw: data, code: -999 });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    if (postData) req.write(postData);
    req.end();
  });
}

function baseHeaders(extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': COOKIE,
    'Referer': 'https://www.bilibili.com',
    'Origin': 'https://www.bilibili.com',
    ...extra
  };
}

function liveHeaders(roomId, extra = {}) {
  return {
    ...baseHeaders(extra),
    'Referer': `https://live.bilibili.com/${roomId}`,
    'Origin': 'https://live.bilibili.com',
  };
}

function apiGet(path) {
  return request({
    hostname: 'api.bilibili.com',
    path,
    method: 'GET',
    headers: baseHeaders()
  });
}

function liveGet(path) {
  return request({
    hostname: 'api.live.bilibili.com',
    path,
    method: 'GET',
    headers: liveHeaders('')
  });
}

function livePost(path, body, roomId = '') {
  return request({
    hostname: 'api.live.bilibili.com',
    path,
    method: 'POST',
    headers: liveHeaders(roomId, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    })
  }, body);
}

// 带跳转的 HTTP/HTTPS GET，返回 HTML
function fetchHtml(targetUrl, referer = '') {
  return new Promise((resolve, reject) => {
    const follow = (url, hops = 0) => {
      if (hops > 4) return reject(new Error('跳转次数过多'));
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': referer || url
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
          // ASP.NET Object moved 跳转
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

// ==============================
// B站接口封装
// ==============================

// 验证登录
async function checkLogin() {
  if (!COOKIE || !CSRF) {
    const reason = 'BILIBILI_COOKIE 未配置或格式不完整（缺少 bili_jct）';
    err(reason);
    await notifyCookieInvalid(reason);
    return false;
  }

  const res = await apiGet('/x/web-interface/nav').catch((e) => ({ code: -1, message: e.message }));
  if (res.code === 0 && res.data && res.data.isLogin) {
    ok(`登录验证成功，用户: ${res.data.uname}（UID: ${res.data.mid}）`);
    return true;
  }

  const reason = `Cookie 已失效或未登录，code=${res.code}${res.message ? `, message=${res.message}` : ''}`;
  err(reason);
  await notifyCookieInvalid(reason);
  return false;
}


// 获取直播间状态
async function getRoomStatus(roomId) {
  const res = await liveGet(`/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`);
  if (res.code === 0 && res.data && res.data.room_info) {
    const ri = res.data.room_info;
    const ai = res.data.anchor_info;
    return {
      roomId: String(ri.room_id || roomId),
      isLive: ri.live_status === 1,
      liveStatus: ri.live_status,
      title: ri.title || '',
      anchorName: ai ? ai.base_info.uname : '',
      anchorUid: String(ri.uid || ''),
      parentAreaId: Number(ri.parent_area_id || 0),
      areaId: Number(ri.area_id || 0),
      online: ri.online || 0
    };
  }
  return null;
}

// 进入直播间
async function enterRoom(roomId) {
  const body = `room_id=${roomId}&platform=pc&csrf=${CSRF}&csrf_token=${CSRF}`;
  const res  = await livePost('/xlive/web-room/v1/index/roomEntryAction', body, roomId);
  return res.code === 0;
}

// 心跳（三路回退）
async function sendHeartbeat(roomInfo) {
  const roomId = String(roomInfo.roomId || roomInfo);
  // 1. webHeartBeat
  try {
    const res = await livePost('/xlive/web-room/v2/index/webHeartBeat', `visit_id=&room_id=${roomId}`, roomId);
    if (res.code === 0) return true;
  } catch (_) {}

  // 2. UserOnlineHeartBeat
  const anchorUid = Number(roomInfo.anchorUid || 0);
  if (anchorUid > 0) {
    try {
      const body = JSON.stringify({
        room_id: Number(roomId),
        parent_id: roomInfo.parentAreaId || 1,
        area_id: roomInfo.areaId || 1,
        ruid: anchorUid,
        csrf_token: CSRF,
        csrf: CSRF,
        visit_id: ''
      });
      const res = await request({
        hostname: 'api.live.bilibili.com',
        path: '/xlive/web-ucenter/v1/sign/UserOnlineHeartBeat',
        method: 'POST',
        headers: liveHeaders(roomId, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      }, body);
      if (res.code === 0) return true;
    } catch (_) {}
  }

  // 3. Feed.heartBeat（稳定兜底）
  try {
    const body = `room_id=${roomId}&csrf_token=${CSRF}&csrf=${CSRF}`;
    const res  = await livePost('/relation/v1/Feed/heartBeat', body, roomId);
    return res.code === 0;
  } catch (_) {}

  return false;
}

// 发弹幕
async function sendDanmu(roomId, msg) {
  const postData = `bubble=0&msg=${encodeURIComponent(msg)}&color=16777215&mode=1&fontsize=50&rnd=${Math.floor(Date.now() / 1000)}&roomid=${roomId}&csrf=${CSRF}&csrf_token=${CSRF}`;
  const res = await request({
    hostname: 'api.live.bilibili.com',
    path: '/msg/send',
    method: 'POST',
    headers: liveHeaders(roomId, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    })
  }, postData);
  return res.code === 0;
}

// 粉丝勋章每日签到
async function doLiveSignin() {
  const body = `csrf=${CSRF}&csrf_token=${CSRF}`;
  const res  = await request({
    hostname: 'api.live.bilibili.com',
    path: '/xlive/web-ucenter/v1/sign/DoSign',
    method: 'POST',
    headers: liveHeaders('', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    })
  }, body);
  if (res.code === 0) return { ok: true, msg: res.data?.text || '签到成功' };
  if (res.code === 1011040) return { ok: true, msg: '今日已签到' };
  return { ok: false, msg: res.message || `code=${res.code}` };
}

// ==============================
// 宠物面板
// ==============================

function extractInput(html, id) {
  const m = String(html || '').match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

const PANEL_ACTION_LABELS = {
  signin: '签到',
  cultivate: '修仙',
  breakthrough: '突破'
};

function extractPanelCommandIds(html) {
  const ids = [];
  const seen = new Set();
  const regex = /id="([^"]+Msg)"[^>]*value="([^"]*)"/ig;

  for (const match of String(html || '').matchAll(regex)) {
    const inputId = match[1];
    const value = match[2] || '';
    if (!inputId || !value || seen.has(inputId)) continue;
    seen.add(inputId);
    ids.push(inputId);
  }

  return ids;
}

function formatPanelCommandIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return '面板未解析到任何 *Msg 指令字段';
  }
  return `面板可见指令字段: ${ids.join(', ')}`;
}

function calculateEnergyDelta(fromEnergy, toEnergy) {
  if (!fromEnergy || !toEnergy) return null;
  const fromCurrent = Number(fromEnergy.current);
  const toCurrent = Number(toEnergy.current);
  if (!Number.isFinite(fromCurrent) || !Number.isFinite(toCurrent)) return null;
  return toCurrent - fromCurrent;
}

function isIdleLikeGain(delta) {
  return Number.isFinite(delta) && delta >= 14 && delta % 14 === 0;
}

function evaluateCultivationGain(beforeEnergy, afterEnergy, options = {}) {
  const round = Math.max(1, Number(options.round || 1));
  const maxRounds = Math.max(round, Number(options.maxRounds || 1));
  const waitSeconds = Math.max(1, Math.round(Number(options.waitMs || 12000) / 1000));
  const totalWaitSeconds = waitSeconds * round;
  const previousEnergy = options.previousEnergy || beforeEnergy;
  const windowDelta = calculateEnergyDelta(previousEnergy, afterEnergy);
  const base = {
    verified: false,
    delta: null,
    windowDelta,
    round,
    maxRounds,
    waitSeconds,
    totalWaitSeconds,
    expectedActiveGain: 19,
    expectedIdleGain: 14,
    idleLike: false,
    delayedLike: false,
    needsAnotherCheck: round < maxRounds,
    reason: ''
  };

  if (!beforeEnergy || !afterEnergy) {
    return {
      ...base,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查未拿到完整经验，继续再查一次，排除面板显示滞后`
        : `连续 ${maxRounds} 次、累计 ${totalWaitSeconds} 秒复查后仍未拿到完整经验，无法确认修炼是否真实生效`
    };
  }

  const delta = calculateEnergyDelta(beforeEnergy, afterEnergy);
  if (!Number.isFinite(delta)) {
    return {
      ...base,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查读到的经验格式异常，继续再查一次`
        : `连续 ${maxRounds} 次、累计 ${totalWaitSeconds} 秒复查后经验格式仍异常，无法确认修炼是否真实生效`
    };
  }

  if (delta >= 19 && !isIdleLikeGain(delta)) {
    return {
      ...base,
      verified: true,
      delta,
      needsAnotherCheck: false,
      reason: `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，且不是 +14 的倍数，可确认修炼加成已生效`
    };
  }

  if (delta >= 19 && isIdleLikeGain(delta)) {
    return {
      ...base,
      delta,
      idleLike: true,
      delayedLike: true,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，但仍是 +14 的倍数，更像基础收益显示滞后，继续再查一次`
        : `连续 ${maxRounds} 次、累计 ${totalWaitSeconds} 秒复查后经验 +${delta} 仍是 +14 的倍数，更像基础收益或显示滞后，未确认修炼真正生效`
    };
  }

  if (delta >= 14) {
    return {
      ...base,
      delta,
      idleLike: true,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，更像基础在线收益，继续再查一次`
        : `连续 ${maxRounds} 次、累计 ${totalWaitSeconds} 秒复查后经验 +${delta}，仍未达到修炼成功应有的有效增量`
    };
  }

  return {
    ...base,
    delta,
    reason: round < maxRounds
      ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，继续再查一次确认是否存在显示滞后`
      : `连续 ${maxRounds} 次、累计 ${totalWaitSeconds} 秒复查后经验 +${delta}，未达到修炼成功应有的有效增量`
  };
}

function resolvePanelCommandInputId(panelHtml, action) {
  const commandIds = extractPanelCommandIds(panelHtml);
  const exactCandidates = {
    signin: ['lblQdMsg', 'lblSignMsg', 'lblQiandaoMsg', 'lblCheckinMsg'],
    cultivate: ['lblXxMsg', 'lblXiuxianMsg', 'lblCultivateMsg'],
    breakthrough: ['lblTpMsg', 'lblTupoMsg', 'lblBreakthroughMsg']
  };
  const keywordCandidates = {
    signin: ['qd', 'sign', 'qiandao', 'checkin'],
    cultivate: ['xx', 'xiuxian', 'cultivate', 'xiulian'],
    breakthrough: ['tp', 'tupo', 'breakthrough', 'upgrade']
  };
  const lowerIds = commandIds.map((id) => ({ original: id, lower: id.toLowerCase() }));

  for (const candidate of exactCandidates[action] || []) {
    const matched = lowerIds.find((item) => item.lower === candidate.toLowerCase());
    if (matched) {
      return { inputId: matched.original, commandIds, strategy: 'exact' };
    }
  }

  for (const keyword of keywordCandidates[action] || []) {
    const matched = lowerIds.find((item) => item.lower.includes(keyword));
    if (matched) {
      return { inputId: matched.original, commandIds, strategy: 'heuristic' };
    }
  }

  return { inputId: '', commandIds, strategy: 'missing' };
}

// 获取 panel_url


// 【增强】获取 panel_url，支持多套正则备用，防止 B站页面改版导致 game_id 提取失败
async function getPanelUrl(roomId) {
  let html;
  try {
    html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
  } catch(_) { return null; }
  if (!html) return null;

  const norm = html.replace(/\s+/g, '');
  let gameId = '';
  let gameName = '';

  // 方案1：interactive_game_tag（最新格式）
  {
    const m = norm.match(/"interactive_game_tag"\s*:\s*\{[^}]*?"game_id"\s*:\s*"?([^",}]+)"?[^}]*?"game_name"\s*:\s*"?([^",}]+)"?/);
    if (m) { gameId = m[1].replace(/"/g, ''); gameName = m[2].replace(/"/g, ''); }
  }

  // 方案2：从 norm 匹配带引号的 game_id
  if (!gameId) {
    const m = norm.match(/"game_id"\s*:\s*"?(\d+)"?/);
    if (m) gameId = m[1];
  }

  // 方案3：从原始 html 匹配（兼容性更好）
  if (!gameId) {
    const m = html.match(/"game_id"\s*[=:]\s*"?(\d+)"?/);
    if (m) gameId = m[1];
  }

  // 方案4：弹幕宠物的其他特征
  if (!gameId || !gameName.includes('弹幕宠物')) {
    const m = html.match(/弹幕宠物.*?"game_id"\s*[=:]\s*"?(\d+)"?/i) ||
              html.match(/interactive_game_tag.*?"game_id"\s*[=:]\s*"?(\d+)"?/i);
    if (m) gameId = m[1];
  }

  if (!gameId) return null;

  // 拿 panel_url
  const res = await request({
    hostname: 'api.live.bilibili.com',
    path: `/xlive/open-platform/v1/game/getAppCustomPanel?game_id=${encodeURIComponent(gameId)}`,
    method: 'GET',
    headers: liveHeaders(roomId)
  });
  const url = res?.data?.panel_url || res?.data?.list?.[0]?.panel_url;
  if (!url || !url.includes('heikeyun')) return null;
  return { gameId, panelUrl: url };
}

// 读取宠物经验
async function getPetEnergy(roomId) {
  const meta = await getPanelUrl(roomId).catch(() => null);
  if (!meta) return null;

  const panelHtml = await fetchHtml(meta.panelUrl, `https://live.bilibili.com/${roomId}`).catch(() => '');
  if (!panelHtml) return null;

  const cur  = panelHtml.match(/id="lblUserEnergy2"[^>]*>([^<]+)</);
  const full = panelHtml.match(/id="lblUserEnergyDown"[^>]*>([^<]+)</);
  const lv   = panelHtml.match(/id="lblUserLevel"[^>]*>([^<]+)</);
  const lvN  = panelHtml.match(/id="lblUserLevelName"[^>]*>([^<]+)</);
  if (!cur || !full) return null;

  const current  = parseInt(cur[1].trim(), 10);
  const total    = parseInt(full[1].trim(), 10);
  const isFull   = Number.isFinite(current) && Number.isFinite(total) && current >= total;
  const normalizedHtml = panelHtml.replace(/\s+/g, '');
  // 【增强】突破就绪判断：支持更多种面板文字提示，防止 B站改版文字变化导致漏判
  const breakthroughKeywords = [
    '当前可突破', '可以突破', '请发送突破', '发送突破',
    'tupo', 'breakthrough', '突破指令',
    '能量已满', '已满', '待突破'
  ];
  const promptReady = breakthroughKeywords.some(kw =>
    normalizedHtml.toLowerCase().includes(kw.toLowerCase())
  );

  return {
    current,
    total,
    isFull,
    level:     lv  ? lv[1].trim()  : '?',
    levelName: lvN ? lvN[1].trim() : '?',
    panelMeta: meta,
    panelHtml,
    breakthroughReady: isFull || promptReady
  };
}

// 通过宠物面板发送指令
async function sendPanelCommand(roomId, inputId, energy) {
  const panelHtml = energy?.panelHtml || '';
  const serverUrl = extractInput(panelHtml, 'serverurl');
  const isPetMsg = extractInput(panelHtml, 'lblIsPetMsg');
  const commandMode = extractInput(panelHtml, 'PetCmdMt') || '2';
  const commandPayload = extractInput(panelHtml, inputId);
  const commandIds = extractPanelCommandIds(panelHtml);

  if (!serverUrl || isPetMsg !== 'True' || !commandPayload || !energy?.panelMeta?.panelUrl) {
    return {
      available: false,
      success: false,
      response: { code: -1, message: '当前直播间宠物面板未提供可用指令通道' },
      reason: `当前直播间宠物面板未提供可用指令通道；${formatPanelCommandIds(commandIds)}`,
      panelCommandMeta: {
        inputId,
        commandIds,
        serverUrl,
        isPetMsg,
        commandMode
      }
    };
  }

  const body = `j=${encodeURIComponent(commandPayload)}`;
  const panelUrlObj = new URL(energy.panelMeta.panelUrl);
  const res = await request({
    hostname: serverUrl,
    path: `/command.ashx?t=danmu&mt=${encodeURIComponent(commandMode)}`,
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      'Referer': energy.panelMeta.panelUrl,
      'Origin': `${panelUrlObj.protocol}//${panelUrlObj.host}`
    }
  }, body).catch((error) => ({ code: -1, message: error.message }));

  const code = res?.Code ?? res?.code ?? -1;
  const message = String(res?.Msg || res?.message || res?.msg || '').trim();
  return {
    available: true,
    success: code === 0,
    response: { code, message },
    reason: code === 0 ? '宠物面板已接收指令' : (message || '宠物面板指令失败'),
    panelCommandMeta: {
      inputId,
      commandIds,
      serverUrl,
      isPetMsg,
      commandMode
    }
  };
}

async function clickPanelAction(roomId, action, energy) {
  const panelHtml = energy?.panelHtml || '';
  const resolved = resolvePanelCommandInputId(panelHtml, action);
  if (!resolved.inputId) {
    return {
      available: false,
      success: false,
      action,
      inputId: '',
      commandIds: resolved.commandIds,
      response: { code: -1, message: `面板未找到「${PANEL_ACTION_LABELS[action] || action}」指令字段` },
      reason: `面板未找到「${PANEL_ACTION_LABELS[action] || action}」指令字段；${formatPanelCommandIds(resolved.commandIds)}`,
      resolveStrategy: resolved.strategy
    };
  }

  const result = await sendPanelCommand(roomId, resolved.inputId, energy);
  return {
    ...result,
    action,
    inputId: resolved.inputId,
    commandIds: resolved.commandIds,
    resolveStrategy: resolved.strategy
  };
}

async function doPanelSignin(roomId, energy) {
  const currentEnergy = energy || await getPetEnergy(roomId).catch(() => null);
  const sent = await sendDanmu(roomId, '签到').catch(() => false);

  return {
    accepted: sent,
    verified: false,
    reason: sent
      ? '直播弹幕「签到」已发出；当前不再依赖蛋宠面板回执做到账校验'
      : '发送直播弹幕「签到」失败',
    response: null,
    inputId: '',
    commandIds: currentEnergy ? extractPanelCommandIds(currentEnergy.panelHtml) : [],
    energyAfter: currentEnergy || null
  };
}


// 【增强】连续修炼多次后再复查 - 修复 +14 问题需要连续触发才能激活加成
async function doSingleCultivation(roomId, roomInfo, beforeEnergy) {
  // 【关键修复】连续修炼 3 次，每次间隔 3 秒，确保触发修炼加成
  const CULTIVATE_COUNT = 3;
  const CULTIVATE_GAP_MS = 6000;
  
  log(`开始连续修炼 ${CULTIVATE_COUNT} 次...`);
  
  for (let i = 1; i <= CULTIVATE_COUNT; i++) {
    const sent = await sendDanmu(roomId, '修炼').catch(() => false);
    if (!sent) {
      warn(`第 ${i} 次修炼发送失败`);
      return { accepted: false, verified: false, energyAfter: null, reason: `第 ${i} 次修炼发送失败` };
    }
    log(`第 ${i}/${CULTIVATE_COUNT} 次修炼已发送`);
    
    // 修炼期间保持心跳
    const heartbeatStart = Date.now();
    const heartbeatPromise = (async () => {
      while (Date.now() - heartbeatStart < 8000) {
        await sendHeartbeat(roomInfo).catch(() => false);
        await sleep(5000);
      }
    })();
    
    // 等待一会儿再发下一次修炼
    if (i < CULTIVATE_COUNT) {
      await sleep(CULTIVATE_GAP_MS);
    }
    
    await heartbeatPromise;
  }

  // 修炼完成后等待面板刷新
  const waitMs = CULTIVATION_WAIT_SECONDS * 1000;
  log(`连续修炼完成，等待 ${waitMs/1000} 秒后读取面板...`);
  await sleep(waitMs);

  // 读取面板
  const after = await getPetEnergy(roomId).catch(() => null);
  const gainCheck = evaluateCultivationGain(beforeEnergy, after, {
    round: 1, maxRounds: 1, waitMs
  });

  return {
    accepted: true,
    verified: gainCheck.verified,
    energyAfter: after,
    gainCheck,
    reason: gainCheck.reason
  };
}

// 【新增】连续修炼直到能量满（或达到最大次数）
async function cultivateUntilFull(roomId, roomInfo, startEnergy) {
  let current = startEnergy;
  let attempt = 0;
  const maxAttempts = BREAKTHROUGH_MAX_CULTIVATIONS;

  log(`突破前连续修炼（最多 ${maxAttempts} 次），起始能量: ${current ? `${current.current}/${current.total}` : '面板不可读'}`);

  while (attempt < maxAttempts) {
    attempt++;

    if (current && current.isFull) {
      log(`连续修炼第 ${attempt} 次后能量已满（${current.current}/${current.total}），停止修炼`);
      break;
    }

    log(`连续修炼第 ${attempt}/${maxAttempts} 次...`);
    const result = await doSingleCultivation(roomId, roomInfo, current);

    const deltaStr = (result.energyAfter && current)
      ? ` (+${result.energyAfter.current - (current.current || 0)})`
      : '';

    log(`  修炼: ${result.accepted ? '✅' : '❌'} ${result.reason}${deltaStr}`);

    if (result.energyAfter) {
      current = result.energyAfter;
      log(`  当前能量: ${current.current}/${current.total}（Lv.${current.level} ${current.levelName}）`);

      if (current.isFull) {
        log(`能量已满，停止修炼`);
        break;
      }
    }
  }

  return current;
}

// 【增强】doCultivation 也改用连续修炼逻辑，确保修炼加成触发
async function doCultivation(roomId, roomInfo, energy) {
  const before = energy || await getPetEnergy(roomId).catch(() => null);
  const detail = {
    accepted: false,
    verified: false,
    reason: '',
    response: null,
    inputId: '',
    commandIds: [],
    energyBefore: before,
    energyAfter: null,
    gainCheck: null
  };

  if (before) {
    log(`弹幕「修炼」前经验: ${before.current}/${before.total}（Lv.${before.level} ${before.levelName}）`);
  } else {
    warn('当前未读到宠物面板基线经验，先直接发送弹幕「修炼」，本轮无法做真实生效校验');
  }

  // 【关键修复】连续修炼 3 次，每次间隔 6 秒（防止 B站 弹幕频率限制）
  const CULTIVATE_COUNT = 3;
  const CULTIVATE_GAP_MS = 6000;
  
  log(`开始连续修炼 ${CULTIVATE_COUNT} 次（间隔 ${CULTIVATE_GAP_MS/1000} 秒）...`);
  
  for (let i = 1; i <= CULTIVATE_COUNT; i++) {
    const sent = await sendDanmu(roomId, '修炼').catch(() => false);
    if (!sent) {
      detail.reason = `第 ${i} 次修炼发送失败`;
      return detail;
    }
    log(`第 ${i}/${CULTIVATE_COUNT} 次修炼已发出`);
    
    // 修炼期间保持心跳
    const heartbeatStart = Date.now();
    (async () => {
      while (Date.now() - heartbeatStart < 8000) {
        await sendHeartbeat(roomInfo).catch(() => false);
        await sleep(5000);
      }
    })();
    
    if (i < CULTIVATE_COUNT) {
      await sleep(CULTIVATE_GAP_MS);
    }
  }

  detail.accepted = true;
  detail.reason = '连续修炼已完成';

  if (!before) {
    return detail;
  }

  log('连续修炼完成，进入经验复查...');

  // 等待面板刷新
  await sleep(15000);

  const after = await getPetEnergy(roomId).catch(() => null);
  detail.energyAfter = after;

  detail.gainCheck = evaluateCultivationGain(before, after, {
    round: 1,
    maxRounds: 1,
    waitMs: 15000
  });
  detail.verified = detail.gainCheck.verified;
  detail.reason = detail.gainCheck.reason;

  const totalDeltaText = Number.isFinite(detail.gainCheck.delta) ? `累计 +${detail.gainCheck.delta}` : '累计增量未知';
  log(`弹幕「修炼」校验: ${detail.verified ? '✅ 已确认生效' : '⚠️ 未确认生效'} - ${totalDeltaText} - ${detail.reason}`);

  return detail;
}

// 判断突破就绪
function isBreakthroughReady(energy) {
  return energy && energy.breakthroughReady === true;
}

// 突破（改回直播弹幕触发，并继续做升级复查）
async function doBreakthrough(roomId, energy) {
  log(`🎉 命中突破条件 (${energy.current}/${energy.total})，尝试发送直播弹幕「突破」...`);
  const sent = await sendDanmu(roomId, '突破').catch(() => false);
  if (!sent) {
    warn('发送直播弹幕「突破」失败');
    return false;
  }

  ok('直播弹幕「突破」已发出，等待 15 秒复查...');
  await sleep(15000);
  const after = await getPetEnergy(roomId).catch(() => null);
  const upgraded = after && (after.level !== energy.level || after.levelName !== energy.levelName || after.current < energy.current || after.total !== energy.total);
  if (upgraded) {
    ok(`突破成功！${energy.level} ${energy.levelName} → ${after.level} ${after.levelName}`);
    return true;
  }

  warn('弹幕「突破」复查未确认升级');
  return false;
}



// ==============================
// 查找可用直播间（关播后备用）
// ==============================
async function findAnyLiveRoom(excludeRoomId) {
  const seen = new Set();
  const candidateIds = [];

  const pushCandidate = (id) => {
    const roomId = String(id || '').trim();
    if (!roomId || roomId === String(excludeRoomId) || seen.has(roomId)) return;
    seen.add(roomId);
    candidateIds.push(roomId);
  };

  // 1. 扫描当前可用的推荐直播列表
  for (const page of [1, 2]) {
    try {
      const res = await liveGet(`/xlive/web-interface/v1/index/getList?platform=web&page=${page}&page_size=30`);
      const groups = [
        ...(Array.isArray(res?.data?.room_list?.list) ? res.data.room_list.list : []),
        ...(Array.isArray(res?.data?.recommend_room_list?.list) ? res.data.recommend_room_list.list : []),
        ...(Array.isArray(res?.data?.list) ? res.data.list : []),
      ];

      for (const item of groups) {
        if (Array.isArray(item?.list)) {
          for (const room of item.list) pushCandidate(room.roomid || room.room_id);
        } else {
          pushCandidate(item.roomid || item.room_id);
        }
      }
    } catch (_) {}
  }

  // 2. 备用固定房
  for (const id of ['732', '3', '5441', '1013']) {
    pushCandidate(id);
  }

  for (const id of candidateIds) {
    const status = await getRoomStatus(id).catch(() => null);
    if (!status || !status.isLive) continue;

    const panel = await getPanelUrl(id).catch(() => null);
    if (panel?.panelUrl) {
      log(`自动命中可用弹幕宠物直播间: ${id}`);
      return id;
    }
  }

  return null;
}


// ==============================
// 单轮循环：面板签到 + 面板修仙 + 突破检测
// ==============================
async function runOneCycle(roomId, roomInfo, cycleIndex) {
  log(`\n========== 第 ${cycleIndex} 轮循环（直播间 ${roomId}） ==========`);

  // 1. 心跳（保活）
  const hbOk = await sendHeartbeat(roomInfo).catch(() => false);
  log(`心跳: ${hbOk ? '✅ 成功' : '⚠️ 失败（继续）'}`);

  // 2. 直播粉丝勋章签到（每日，重复签到接口自己会返回"已签到"）
  await sleep(DANMU_GAP_MS);
  const liveSignin = await doLiveSignin().catch(() => ({ ok: false, msg: '异常' }));
  log(`直播签到: ${liveSignin.ok ? '✅' : '⚠️'} ${liveSignin.msg}`);

  // 3. 尝试读取宠物面板，主要用于经验校验与突破判断；触发方式已改回弹幕
  await sleep(DANMU_GAP_MS);
  const panelEnergy = await getPetEnergy(roomId).catch(() => null);
  if (panelEnergy) {
    log(`当前宠物经验: ${panelEnergy.current}/${panelEnergy.total}（Lv.${panelEnergy.level} ${panelEnergy.levelName}）`);
  } else {
    warn('当前未读到宠物面板，本轮先按弹幕方式发送签到/修炼；经验与突破复查可能缺失');
  }

  // 4. 弹幕「签到」
  const panelSignin = await doPanelSignin(roomId, panelEnergy);
  log(`弹幕「签到」: ${panelSignin.accepted ? (panelSignin.verified ? '✅ 已验证' : '⚠️ 已发出未确认') : '⚠️ 未发出'} ${panelSignin.reason}`);

  // 5. 弹幕「修炼」并尽量做经验校验
  await sleep(DANMU_GAP_MS);
  const cultivation = await doCultivation(roomId, roomInfo, panelSignin.energyAfter || panelEnergy);
  log(`弹幕「修炼」: ${cultivation.accepted ? (cultivation.verified ? '✅ 已确认生效' : '⚠️ 已发出未确认') : '⚠️ 未发出'} ${cultivation.reason}`);

  const energyAfterCultivation = cultivation.energyAfter || await getPetEnergy(roomId).catch(() => null);

  if (energyAfterCultivation) {
    log(`宠物经验: ${energyAfterCultivation.current}/${energyAfterCultivation.total}（Lv.${energyAfterCultivation.level} ${energyAfterCultivation.levelName}）`);
    if (energyAfterCultivation && isBreakthroughReady(energyAfterCultivation)) {
      // 【核心修复】突破前先连续修炼刷满能量
      await sleep(DANMU_GAP_MS);
      const beforeBreakthrough = await cultivateUntilFull(roomId, roomInfo, energyAfterCultivation);
      if (beforeBreakthrough) {
        log(`突破前最终能量: ${beforeBreakthrough.current}/${beforeBreakthrough.total}（Lv.${beforeBreakthrough.level} ${beforeBreakthrough.levelName}）`);
      }
      await sleep(DANMU_GAP_MS);
      await doBreakthrough(roomId, beforeBreakthrough || energyAfterCultivation);
    }
  } else {
    // 【增强】即使面板读取失败，也尝试累积修炼次数后突破
    warn('修炼后读取宠物经验失败，尝试连续修炼后突破');
    const startEnergy = await getPetEnergy(roomId).catch(() => null);
    const cultivated = await cultivateUntilFull(roomId, roomInfo, startEnergy);
    if (cultivated && cultivated.isFull) {
      log('能量已满，尝试突破');
      await doBreakthrough(roomId, cultivated);
    } else if (cultivated) {
      log(`连续修炼后能量: ${cultivated.current}/${cultivated.total}，未达满值，等待下一轮继续`);
    }
  }

  log('本轮完成');
}



// ==============================
// 边界AI签到（yyai8.com）
// ==============================
async function doYyaiSignin() {
  if (!YYAI_TOKEN || !YYAI_ACCESS_TOKEN || !YYAI_UID) {
    log('边界AI签到: 未配置 YYAI_TOKEN / YYAI_ACCESS_TOKEN / YYAI_UID，跳过');
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
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'access-token': YYAI_ACCESS_TOKEN,
        'app-name': 'bianjie',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'origin': 'https://yyai8.com',
        'referer': 'https://yyai8.com/',
        'token': YYAI_TOKEN,
        'uid': YYAI_UID,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
      }
    }, body);

    const msg = String(res.msg || res.message || '');
    const isAlready =
      msg.includes('已签到') || msg.includes('已经签到') ||
      msg.toLowerCase().includes('already') || msg.includes('重复');
    const isSuccess =
      res.code === 0 || res.code === 1 || res.code === 200 ||
      res.success === true ||
      (msg && (msg.includes('成功') || msg.toLowerCase().includes('success')));

    if (isAlready) {
      log('边界AI签到: 今日已签到，跳过');
    } else if (isSuccess) {
      const points = res.data?.points || res.data?.score || res.data?.coin ||
                     res.data?.integral || res.data?.exp || '';
      ok(`边界AI签到: 签到成功！${points ? '获得积分: ' + points : ''}`);
    } else {
      const failMsg = msg || JSON.stringify(res);
      warn(`边界AI签到: 失败 code=${res.code}, msg=${failMsg}`);

      const isTokenExpired =
        res.code === 401 ||
        (failMsg.includes('token') || failMsg.includes('未登录') ||
         failMsg.includes('登录') || failMsg.toLowerCase().includes('unauthorized') ||
         failMsg.toLowerCase().includes('invalid') || failMsg.toLowerCase().includes('expire'));

      const mailSubject = isTokenExpired
        ? '【边界AI签到】⚠️ access-token 已失效，请及时更新'
        : '【边界AI签到】⚠️ 今日签到失败';
      const mailBody = isTokenExpired
        ? `边界AI平台自动签到失败，原因：access-token 已过期。\n\n请按以下步骤更新：\n1. 打开浏览器，登录 https://yyai8.com/signIn\n2. F12 → Network → 点击"立即签到"\n3. 找到 POST do 请求 → Request Headers\n4. 复制 access-token 的值\n5. 前往 GitHub 仓库 → Settings → Secrets → 更新 YYAI_ACCESS_TOKEN\n\n错误信息：${failMsg}\n时间：${now()}`
        : `边界AI平台签到失败。\n\n错误信息：code=${res.code}, msg=${failMsg}\n时间：${now()}`;
      await sendMail(mailSubject, mailBody).catch(() => {});
    }
  } catch (e) {
    warn(`边界AI签到: 异常 ${e.message}`);
    await sendMail('【边界AI签到】❌ 签到脚本异常',
      `边界AI平台签到脚本发生异常：${e.message}\n时间：${now()}`).catch(() => {});
  }
}

// ==============================
// 主循环
// ==============================
async function main() {
  log('=== B站弹幕宠物挂机启动 ===');
  log(`循环间隔: ${CYCLE_MINUTES} 分钟 / 最大运行时长: ${MAX_RUNTIME_MINUTES} 分钟`);

  // 登录校验
  const loggedIn = await checkLogin().catch(() => false);
  if (!loggedIn) {
    process.exit(1);
  }

  // 边界AI签到（每次挂机启动时执行一次，幂等，重复签到会直接跳过）
  await doYyaiSignin().catch(e => warn(`边界AI签到异常（不影响挂机）: ${e.message}`));

  const startTime  = Date.now();
  const maxRunMs   = MAX_RUNTIME_MINUTES * 60 * 1000;
  const cycleMs    = CYCLE_MINUTES * 60 * 1000;

  let currentRoomId = String(HANGUP_ROOM_ID || '').trim();
  let currentRoomInfo = null;
  let cycleIndex = 1;

  // 进入初始直播间
  if (!currentRoomId) {
    warn('未配置 HANGUP_ROOM_ID，尝试自动查找直播间...');
    currentRoomId = await findAnyLiveRoom('').catch(() => '');
    if (!currentRoomId) {
      err('找不到可用直播间，退出');
      process.exit(1);
    }
    log(`自动选定直播间: ${currentRoomId}`);
  }

  // 检查初始直播间是否开播
  currentRoomInfo = await getRoomStatus(currentRoomId).catch(() => null);
  if (!currentRoomInfo || !currentRoomInfo.isLive) {
    warn(`配置直播间 ${currentRoomId} 未开播，尝试切换...`);
    const alt = await findAnyLiveRoom(currentRoomId).catch(() => null);
    if (!alt) {
      err('找不到开播直播间，退出');
      process.exit(1);
    }
    currentRoomId   = alt;
    currentRoomInfo = await getRoomStatus(currentRoomId).catch(() => null);
    log(`切换到直播间: ${currentRoomId}`);
  }

  // 进场
  await enterRoom(currentRoomId).catch(() => {});
  log(`进入直播间: ${currentRoomId}（${currentRoomInfo?.title || ''}）`);

  // 主循环
  while (Date.now() - startTime < maxRunMs) {
    const cycleStart = Date.now();

    try {
      // 检查当前直播间是否还在播
      const status = await getRoomStatus(currentRoomId).catch(() => null);
      if (!status || !status.isLive) {
        warn(`直播间 ${currentRoomId} 已关播，寻找新直播间...`);
        const alt = await findAnyLiveRoom(currentRoomId).catch(() => null);
        if (!alt) {
          warn('找不到开播直播间，等待 2 分钟后重试...');
          await sleep(120000);
          continue;
        }
        currentRoomId   = alt;
        currentRoomInfo = await getRoomStatus(currentRoomId).catch(() => null);
        await enterRoom(currentRoomId).catch(() => {});
        log(`切换到直播间: ${currentRoomId}（${currentRoomInfo?.title || ''}）`);
      } else {
        currentRoomInfo = status;
      }

      await runOneCycle(currentRoomId, currentRoomInfo, cycleIndex);
    } catch (e) {
      warn(`第 ${cycleIndex} 轮异常: ${e.message}`);
    }

    cycleIndex++;

    // 等到下一轮（精确到原定间隔）
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, cycleMs - elapsed);
    const remaining = maxRunMs - (Date.now() - startTime);

    if (remaining <= 0) break;
    if (wait <= 0) continue;
    if (wait > remaining) {
      log(`剩余 ${Math.round(remaining / 1000)} 秒，不足以下一轮间隔，结束本次挂机`);
      break;
    }

    log(`等待 ${Math.round(wait / 1000)} 秒...`);
    await sleep(wait);

  }

  log(`=== 挂机结束，共执行 ${cycleIndex - 1} 轮，总耗时 ${Math.round((Date.now() - startTime) / 60000)} 分钟 ===`);
}

main().catch(e => {
  err(`主程序异常: ${e.message}`);
  process.exit(1);
});


