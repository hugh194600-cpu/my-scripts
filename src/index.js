/**
 * B站弹幕宠物挂机 - 精简版
 * 每10分钟执行：签到 → 修炼 → 突破（每个弹幕间隔2秒）
 * v3: 对齐开源项目 Koziu-233/Bili-danmu-pet-auto 的请求参数
 */

const https = require('https');
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
  const cultivateOk = await sendDanmu(roomId, '修炼');
  log(`修炼: ${cultivateOk ? '✅' : '❌'}`);

  await sleep(2000);
  const breakthroughOk = await sendDanmu(roomId, '突破');
  log(`突破: ${breakthroughOk ? '✅' : '❌'}`);

  log('本轮完成');
  return signinOk || cultivateOk || breakthroughOk;
}

// 检查直播间是否还在直播，如果关播则重试切换（最多等30秒）
async function checkAndSwitchRoom(currentRoomId) {
  const isLive = await getRoomStatus(currentRoomId);
  if (isLive) {
    return { roomId: currentRoomId, available: true };
  }

  warn(`直播间 ${currentRoomId} 已关播，等待重试...`);
  for (let retry = 1; retry <= 3; retry++) {
    await sleep(10000); // 等10秒
    const newRoomId = await findLiveRoom();
    if (newRoomId) {
      log(`重试 ${retry}：找到新直播间 ${newRoomId}`);
      await enterRoom(newRoomId);
      log('已进场新直播间');
      return { roomId: newRoomId, available: true };
    }
    warn(`重试 ${retry}/3：仍未找到直播中的房间，继续等待...`);
  }

  warn('所有重试均失败，本轮弹幕跳过');
  return { roomId: currentRoomId, available: false };
}

async function findLiveRoom() {
  const rooms = ['732', '3', '5441', '1013'];
  for (const id of rooms) {
    if (await getRoomStatus(id)) return id;
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
