/**
 * B站弹幕宠物挂机 - 精简版
 * 每10分钟执行：签到 → 修炼 → 突破（每个弹幕间隔2秒）
 * v3: 对齐开源项目 Koziu-233/Bili-danmu-pet-auto 的请求参数
 */

const https = require('https');
const http = require('http');
const tls = require('tls');

// ==============================
// 配置
// ==============================
const COOKIE = process.env.BILIBILI_COOKIE || '';
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '';
const CYCLE_MINUTES = parseInt(process.env.CYCLE_MINUTES || '10', 10);
const MAX_RUNTIME_MINUTES = parseInt(process.env.MAX_RUNTIME_MINUTES || '30', 10);
const MAIL_USER = process.env.QQ_MAIL_USER || '';
const MAIL_PASS = process.env.QQ_MAIL_PASS || '';

// 边界AI签到配置
const YYAI_TOKEN = process.env.YYAI_TOKEN || '';
const YYAI_ACCESS_TOKEN = process.env.YYAI_ACCESS_TOKEN || '';
const YYAI_UID = process.env.YYAI_UID || '';

// 已验证有弹幕宠物的备用直播间（2026-04-17 扫描）
// 关播后自动轮换：优先检查列表前面的房间，找到开播且有蛋宠的就用
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
const CSRF_TOKEN = CSRF; // csrf_token 和 csrf 值相同

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

// v3: 添加 Origin + Priority，对齐开源项目参数
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

// v3: 对齐开源项目 Koziu-233/Bili-danmu-pet-auto 的完整参数
// 关键新增：jumpfrom=84001 (手机端标识), roomtype, reply_mid, reply_attr, replay_dmid, fontsize=25
async function sendDanmu(roomId, msg) {
  const rnd = Math.floor(Date.now() / 1000);
  // 对齐开源项目参数
  const bodyParams = new URLSearchParams({
    bubble: '0',
    msg: msg,
    color: '16777215',
    mode: '1',
    roomtype: '0',
    jumpfrom: '84001',    // 关键！手机端/App端标识
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

  // 调试：打印完整响应
  if (res.code !== 0) {
    log(`弹幕 "${msg}" 失败，响应: ${JSON.stringify(res)}`);
  }
  return res.code === 0;
}

async function heartbeat(roomId) {
  const body = `visit_id=&room_id=${roomId}`;
  const res = await livePost('/xlive/web-room/v2/index/webHeartBeat', body, roomId);
  return res.code === 0;
}

// ==============================
// 宠物面板经验读取（仅用于诊断）
// ==============================

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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
  log(`[面板诊断] 获取直播间 ${roomId} 的 panel_url`);
  let html = '';
  try {
    html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
  } catch (e) {
    warn(`[面板诊断] 直播间页面请求失败: ${e.message}`);
    return null;
  }
  if (!html || html.length < 100) {
    warn(`[面板诊断] 直播间页面内容异常（${html.length} 字节）`);
    return null;
  }
  log(`[面板诊断] 直播间页面已获取（${html.length} 字节）`);

  const tagMatch = html.match(/"interactive_game_tag":\{"action":\d+,"game_id":"([^"]+)","game_name":"([^"]+)"/);
  let gameId = tagMatch ? tagMatch[1] : '';
  const gameName = tagMatch ? tagMatch[2] : '';

  if (tagMatch) {
    log(`[面板诊断] interactive_game_tag: game_id="${gameId}" game_name="${gameName}"`);
  } else {
    warn('[面板诊断] interactive_game_tag 未匹配，尝试回退 game_id 正则');
    const m = html.match(/"game_id"\s*:\s*"?(\d+)"?/);
    if (!m) {
      warn('[面板诊断] 回退 game_id 正则也未找到，该直播间可能没有弹幕宠物');
      return null;
    }
    gameId = m[1];
    log(`[面板诊断] 回退 game_id 命中: "${gameId}"`);
  }

  if (!gameId || (!gameName.includes('弹幕宠物') && tagMatch)) {
    warn(`[面板诊断] game_name="${gameName}" 不含"弹幕宠物"，可能不是目标游戏`);
  }

  log(`[面板诊断] 请求 getAppCustomPanel，game_id="${gameId}"`);
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
    warn(`[面板诊断] getAppCustomPanel 请求异常: ${e.message}`);
    return null;
  }

  if (!res || res.code !== 0) {
    warn(`[面板诊断] getAppCustomPanel 返回错误: code=${res?.code} msg=${res?.message || ''}`);
    return null;
  }

  const url = res?.data?.panel_url || res?.data?.list?.[0]?.panel_url;
  if (!url) {
    warn(`[面板诊断] panel_url 为空，data 片段: ${JSON.stringify(res?.data).slice(0, 200)}`);
    return null;
  }
  if (!url.includes('heikeyun')) {
    warn(`[面板诊断] panel_url 不含 heikeyun，跳过: ${url.slice(0, 120)}`);
    return null;
  }

  log(`[面板诊断] panel_url: ${url.slice(0, 120)}`);
  return { gameId, panelUrl: url };
}

async function getPetEnergy(roomId) {
  const meta = await getPanelUrl(roomId).catch((e) => {
    warn(`[经验诊断] getPanelUrl 异常: ${e.message}`);
    return null;
  });
  if (!meta) { warn('[经验诊断] 无法获取 panel_url，跳过经验读取'); return null; }

  let panelHtml = '';
  try {
    panelHtml = await fetchHtml(meta.panelUrl, `https://live.bilibili.com/${roomId}`);
  } catch (e) {
    warn(`[经验诊断] 面板 HTML 请求失败: ${e.message}`);
    return null;
  }
  if (!panelHtml) { warn('[经验诊断] 面板 HTML 为空'); return null; }
  log(`[经验诊断] 面板 HTML 已获取（${panelHtml.length} 字节）`);

  const cur  = panelHtml.match(/id="lblUserEnergy2"[^>]*>([^<]+)</);
  const full = panelHtml.match(/id="lblUserEnergyDown"[^>]*>([^<]+)</);
  const lv   = panelHtml.match(/id="lblUserLevel"[^>]*>([^<]+)</);
  const lvN  = panelHtml.match(/id="lblUserLevelName"[^>]*>([^<]+)</);

  if (!cur || !full) {
    const lblIds = [...panelHtml.matchAll(/id="(lbl[^"]+)"/gi)].map(m => m[1]);
    if (lblIds.length > 0) {
      warn(`[经验诊断] 未找到经验字段，面板 lbl* 字段: ${lblIds.join(', ')}`);
    } else {
      warn('[经验诊断] 面板中无任何 lbl* 字段，页面结构可能已变更');
    }
    return null;
  }

  const current = parseInt(cur[1].trim(), 10);
  const total   = parseInt(full[1].trim(), 10);
  log(`[经验诊断] 经验: ${current}/${total}（Lv.${lv ? lv[1].trim() : '?'} ${lvN ? lvN[1].trim() : '?'}）`);
  return { current, total, level: lv ? lv[1].trim() : '?', levelName: lvN ? lvN[1].trim() : '?' };
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
      log(`边界AI签到: ✅ 成功`);
    } else {
      warn(`边界AI签到: ⚠️ 失败 - ${msg}`);
    }
  } catch (e) {
    warn(`边界AI签到: ❌ 异常 - ${e.message}`);
  }
}

// ==============================
// 主逻辑
// ==============================
async function runOneCycle(roomId, cycleIndex) {
  log(`========== 第 ${cycleIndex} 轮 ==========`);

  await heartbeat(roomId);

  await sleep(2000);
  const signinOk = await sendDanmu(roomId, '签到');
  log(`签到: ${signinOk ? '✅' : '❌'}`);

  await sleep(2000);

  // 修炼前读一次经验基线
  const energyBefore = await getPetEnergy(roomId).catch(() => null);
  if (energyBefore) {
    log(`[经验诊断] 修炼前经验: ${energyBefore.current}/${energyBefore.total}`);
  }

  const cultivateOk = await sendDanmu(roomId, '修炼');
  log(`修炼: ${cultivateOk ? '✅' : '❌'}`);

  // 修炼后等 15 秒再读一次，确认是否有经验增量
  if (cultivateOk) {
    log('[经验诊断] 修炼弹幕已发出，等待 15 秒后复查经验...');
    await sleep(15000);
    const energyAfter = await getPetEnergy(roomId).catch(() => null);
    if (energyAfter && energyBefore) {
      const delta = energyAfter.current - energyBefore.current;
      log(`[经验诊断] 修炼后经验: ${energyAfter.current}/${energyAfter.total}（增量 ${delta >= 0 ? '+' : ''}${delta}）`);
    } else if (energyAfter) {
      log(`[经验诊断] 修炼后经验: ${energyAfter.current}/${energyAfter.total}（无基线对比）`);
    }
  }

  await sleep(2000);
  const breakthroughOk = await sendDanmu(roomId, '突破');
  log(`突破: ${breakthroughOk ? '✅' : '❌'}`);

  log('本轮完成');
  return signinOk || cultivateOk || breakthroughOk;
}

// 检查直播间是否还在直播，如果关播则从备用蛋宠房列表中换房
async function checkAndSwitchRoom(currentRoomId) {
  const isLive = await getRoomStatus(currentRoomId);
  if (isLive) {
    return { roomId: currentRoomId, available: true };
  }

  warn(`直播间 ${currentRoomId} 已关播，开始自动换房...`);
  for (let retry = 1; retry <= 3; retry++) {
    await sleep(10000);
    const newRoomId = await findLiveRoom();
    if (newRoomId) {
      log(`[换房] 第${retry}次尝试成功，切换到房间 ${newRoomId}`);
      await enterRoom(newRoomId);
      log('[换房] 已进场新直播间');
      return { roomId: newRoomId, available: true };
    }
    warn(`[换房] 第${retry}/3次尝试：未找到可用的蛋宠房，继续等待...`);
  }

  warn('[换房] 所有尝试均失败，本轮跳过');
  return { roomId: currentRoomId, available: false };
}

async function findLiveRoom() {
  // 优先从已验证有弹幕宠物的备用房间列表中找开播的
  log(`[换房] 从 ${BACKUP_PET_ROOMS.length} 个备用蛋宠房中查找...`);
  for (const id of BACKUP_PET_ROOMS) {
    const isLive = await getRoomStatus(id).catch(() => false);
    if (isLive) {
      // 快速验证是否真的有弹幕宠物
      try {
        const html = await fetchHtml(`https://live.bilibili.com/${id}`, `https://live.bilibili.com/${id}`);
        if (html && html.includes('interactive_game_tag') && html.includes('弹幕宠物')) {
          log(`[换房] ✅ 房间 ${id} 开播且有弹幕宠物`);
          return id;
        }
        // 页面有内容但没有蛋宠标记，也试试（可能是页面结构变化）
        if (html && html.includes('heikeyun')) {
          log(`[换房] ✅ 房间 ${id} 开播且检测到 heikeyun 面板`);
          return id;
        }
        warn(`[换房] 房间 ${id} 开播但无弹幕宠物标记，跳过`);
      } catch (e) {
        warn(`[换房] 房间 ${id} 页面验证失败: ${e.message}，跳过`);
      }
    }
  }

  // 回退: 旧的固定房间（兼容）
  const fallbackRooms = ['732', '3', '5441', '1013'];
  for (const id of fallbackRooms) {
    if (await getRoomStatus(id).catch(() => false)) {
      warn(`[换房] 未找到蛋宠房，回退使用固定房 ${id}（不保证有蛋宠）`);
      return id;
    }
  }

  return null;
}

async function main() {
  log('=== B站弹幕宠物挂机启动 ===');

  if (!await checkLogin()) process.exit(1);

  await doYyaiSignin();

  let roomId = HANGUP_ROOM_ID || await findLiveRoom();
  log(`使用直播间: ${roomId}`);

  await enterRoom(roomId);
  log('已进场');

  const maxMs = MAX_RUNTIME_MINUTES * 60 * 1000;
  const cycleMs = CYCLE_MINUTES * 60 * 1000;
  const startTime = Date.now();
  let cycle = 1;

  while (Date.now() - startTime < maxMs) {
    const { roomId: targetRoom, available } = await checkAndSwitchRoom(roomId);
    roomId = targetRoom;

    if (available) {
      await runOneCycle(roomId, cycle);
    } else {
      warn('直播间不可用，本轮跳过');
    }

    cycle++;
    await sleep(cycleMs);
  }

  log('=== 挂机结束 ===');
}

main().catch(e => { err(e.message); process.exit(1); });
