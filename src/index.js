/**
 * B站弹幕宠物挂机 - 精简版
 * 每10分钟执行：签到 → 修炼 → 突破（每个弹幕间隔2秒）
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
  return request({ hostname: 'api.bilibili.com', path, method: 'GET', headers: { 'Cookie': COOKIE, 'User-Agent': 'Mozilla/5.0' } });
}

function liveGet(path) {
  return request({
    hostname: 'api.live.bilibili.com', path, method: 'GET',
    headers: { 'Cookie': COOKIE, 'Referer': 'https://live.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
  });
}

function livePost(path, body, roomId) {
  return request({
    hostname: 'api.live.bilibili.com', path, method: 'POST',
    headers: { 'Cookie': COOKIE, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `https://live.bilibili.com/${roomId}`, 'User-Agent': 'Mozilla/5.0' }
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
  const body = `room_id=${roomId}&csrf=${CSRF}`;
  return (await livePost('/xlive/web-room/v1/index/roomEntryAction', body, roomId)).code === 0;
}

async function sendDanmu(roomId, msg) {
  const body = `bubble=0&msg=${encodeURIComponent(msg)}&color=16777215&mode=1&fontsize=50&rnd=${Math.floor(Date.now()/1000)}&roomid=${roomId}&csrf=${CSRF}`;
  const res = await livePost('/msg/send', body, roomId);
  return res.code === 0;
}

async function heartbeat(roomId) {
  const body = `visit_id=&room_id=${roomId}`;
  return (await livePost('/xlive/web-room/v2/index/webHeartBeat', body, roomId)).code === 0;
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
        'user-agent': 'Mozilla/5.0'
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
  
  // 心跳保活
  await heartbeat(roomId);
  
  // 发送签到 → 修炼 → 突破，每个间隔2秒
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
}

async function findLiveRoom() {
  const rooms = ['732', '3', '5441', '1013'];
  for (const id of rooms) {
    if (await getRoomStatus(id)) return id;
  }
  return rooms[0];
}

async function main() {
  log('=== B站弹幕宠物挂机启动 ===');
  
  if (!await checkLogin()) process.exit(1);
  
  // 边界AI签到
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
    await runOneCycle(roomId, cycle);
    cycle++;
    await sleep(cycleMs);
  }
  
  log('=== 挂机结束 ===');
}

main().catch(e => { err(e.message); process.exit(1); });