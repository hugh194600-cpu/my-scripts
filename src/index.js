/**
 * B站弹幕宠物挂机 - 精简版
 * 逻辑：进入直播间 → 每10分钟循环（签到 → 修炼 → 突破检测）
 *       直播间关播后自动换房继续
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
// 弹幕间隔（毫秒），避免发送太快被忽略
const DANMU_GAP_MS  = Math.max(2000, parseInt(process.env.DANMU_GAP_MS || '3000', 10));
const MAIL_USER     = process.env.QQ_MAIL_USER || '';
const MAIL_PASS     = process.env.QQ_MAIL_PASS || '';


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
    const lib = opts.hostname && opts.hostname.endsWith('.bilibili.com') ? https : https;
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

// 获取 panel_url
async function getPanelUrl(roomId) {
  // 从直播间页面提取 game_id
  const html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
  const tagMatch = html.match(/"interactive_game_tag":\{"action":\d+,"game_id":"([^"]+)","game_name":"([^"]+)"/);
  let gameId = tagMatch ? tagMatch[1] : '';
  const gameName = tagMatch ? tagMatch[2] : '';

  if (!gameId || !gameName.includes('弹幕宠物')) {
    const m = html.match(/"game_id"\s*:\s*"?(\d+)"?/);
    if (!m) return null;
    gameId = m[1];
  }

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
  const promptReady = /当前可突破[，,]?请发送突破指令/.test(normalizedHtml);

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
  // 复用 energy 里已拿到的面板 HTML，避免重复请求
  const panelHtml = energy?.panelHtml || '';
  const serverUrl     = extractInput(panelHtml, 'serverurl');
  const isPetMsg      = extractInput(panelHtml, 'lblIsPetMsg');
  const commandMode   = extractInput(panelHtml, 'PetCmdMt') || '2';
  const commandPayload = extractInput(panelHtml, inputId);

  if (!serverUrl || isPetMsg !== 'True' || !commandPayload) {
    return false;
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
  }, body).catch(() => null);

  const code = res?.Code ?? res?.code ?? -1;
  return code === 0;
}

// 判断突破就绪
function isBreakthroughReady(energy) {
  return energy && energy.breakthroughReady === true;
}

// 突破（面板优先，失败回退弹幕）
async function doBreakthrough(roomId, energy) {
  log(`🎉 命中突破条件 (${energy.current}/${energy.total})，尝试宠物面板突破...`);
  const panelOk = await sendPanelCommand(roomId, 'lblTpMsg', energy);
  if (panelOk) {
    ok('宠物面板突破指令已发出，等待 15 秒复查...');
    await sleep(15000);
    const after = await getPetEnergy(roomId).catch(() => null);
    const upgraded = after && (after.level !== energy.level || after.levelName !== energy.levelName || after.current < energy.current || after.total !== energy.total);
    if (upgraded) {
      ok(`突破成功！${energy.level} ${energy.levelName} → ${after.level} ${after.levelName}`);
      return true;
    }
    warn('面板突破后复查未确认升级，改用弹幕兜底...');
  } else {
    warn('宠物面板突破失败，改用弹幕兜底...');
  }

  await sleep(DANMU_GAP_MS);
  const danmuOk = await sendDanmu(roomId, '突破');
  if (danmuOk) {
    ok('弹幕「突破」已发出，等待 15 秒复查...');
    await sleep(15000);
    const after = await getPetEnergy(roomId).catch(() => null);
    const upgraded = after && (after.level !== energy.level || after.levelName !== energy.levelName || after.current < energy.current || after.total !== energy.total);
    if (upgraded) {
      ok(`弹幕突破成功！${energy.level} ${energy.levelName} → ${after.level} ${after.levelName}`);
      return true;
    }
    warn('弹幕突破后复查未确认升级');
  } else {
    warn('弹幕「突破」发送失败');
  }
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
// 单轮循环：签到 + 修炼 + 突破检测
// ==============================
async function runOneCycle(roomId, roomInfo, cycleIndex) {
  log(`\n========== 第 ${cycleIndex} 轮循环（直播间 ${roomId}） ==========`);

  // 1. 心跳（保活）
  const hbOk = await sendHeartbeat(roomInfo).catch(() => false);
  log(`心跳: ${hbOk ? '✅ 成功' : '⚠️ 失败（继续）'}`);

  // 2. 签到（每日，重复签到接口自己会返回"已签到"）
  await sleep(DANMU_GAP_MS);
  const signin = await doLiveSignin().catch(() => ({ ok: false, msg: '异常' }));
  log(`签到: ${signin.ok ? '✅' : '⚠️'} ${signin.msg}`);

  // 3. 弹幕「签到」（宠物系统的每日签到指令）
  await sleep(DANMU_GAP_MS);
  const signinDanmuOk = await sendDanmu(roomId, '签到').catch(() => false);
  log(`弹幕「签到」: ${signinDanmuOk ? '✅ 已发出' : '⚠️ 失败'}`);

  // 4. 弹幕「修炼」
  await sleep(DANMU_GAP_MS);
  const cultivOk = await sendDanmu(roomId, '修炼').catch(() => false);
  log(`弹幕「修炼」: ${cultivOk ? '✅ 已发出' : '⚠️ 失败'}`);

  // 5. 等 5 秒再读经验（让经验结算）
  await sleep(5000);
  const energy = await getPetEnergy(roomId).catch(() => null);
  if (energy) {
    log(`宠物经验: ${energy.current}/${energy.total}（Lv.${energy.level} ${energy.levelName}）`);
    if (energy.breakthroughReady) {
      await doBreakthrough(roomId, energy);
    }
  } else {
    warn('读取宠物经验失败（直播间可能无弹幕宠物或面板暂不可用）');
  }

  log('本轮完成');
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
