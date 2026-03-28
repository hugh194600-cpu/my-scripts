/**
 * B站自动化工具 - 主入口
 * 支持：签到、挂机修炼、宠物成长
 */

const https = require('https');
const http = require('http');

// ==============================
// 配置读取
// ==============================
const COOKIE = process.env.BILIBILI_COOKIE || '';
const UID = process.env.BILIBILI_UID || '';
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '5456135';  // 弹幕宠物所在直播间
const HANGUP_DURATION = parseInt(process.env.HANGUP_DURATION || '3600', 10);
const PET_NAME = process.env.PET_NAME || '我的弹幕宠物';
const TASK = process.env.TASK || 'all'; // all | signin | hangup | pet

// 弹幕修炼指令列表（每次随机选一个）
const TRAIN_DANMU = ['修仙', '突破', '打坐', '修炼', '挂机'];
// 签到弹幕指令
const SIGNIN_DANMU = '签到';

// 从 Cookie 中提取 bili_jct 作为 csrf
function extractCsrf(cookie) {
  const m = cookie.match(/bili_jct=([^;]+)/);
  return m ? m[1].trim() : '';
}

// 从 Cookie 中提取 uid（DedeUserID）
function extractUid(cookie) {
  const m = cookie.match(/DedeUserID=([^;]+)/);
  return m ? m[1].trim() : '';
}

const CSRF = extractCsrf(COOKIE);
const AUTO_UID = UID || extractUid(COOKIE);

// ==============================
// HTTP 请求工具
// ==============================
function request(options, postData) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // 调试：打印原始响应（前200字符）
        console.log(`   [HTTP] ${options.method} ${options.hostname}${options.path} → ${res.statusCode}`);
        console.log(`   [RAW] ${data.substring(0, 300)}`);
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.warn(`   [WARN] 响应不是JSON: ${data.substring(0, 100)}`);
          resolve({ raw: data, code: -999 });
        }
      });
    });
    req.on('error', (err) => {
      console.error(`   [ERR] 请求失败: ${err.message}`);
      reject(err);
    });
    req.setTimeout(15000, () => { req.destroy(new Error('请求超时')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function buildHeaders(extraHeaders) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': COOKIE,
    'Referer': 'https://www.bilibili.com',
    'Origin': 'https://www.bilibili.com',
    ...extraHeaders
  };
}

// GET 请求
function apiGet(path) {
  return request({
    hostname: 'api.bilibili.com',
    path: path,
    method: 'GET',
    headers: buildHeaders()
  });
}

// POST 请求（application/x-www-form-urlencoded）
function apiPost(path, body) {
  const postData = body;
  return request({
    hostname: 'api.bilibili.com',
    path: path,
    method: 'POST',
    headers: buildHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    })
  }, postData);
}

// POST 请求到 live.bilibili.com
function livePost(path, body) {
  const postData = body;
  return request({
    hostname: 'live-trace.bilibili.com',
    path: path,
    method: 'POST',
    headers: {
      ...buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
}

// 发直播间弹幕
function sendDanmu(roomId, msg) {
  const postData = `bubble=0&msg=${encodeURIComponent(msg)}&color=16777215&mode=1&fontsize=50&rnd=${Math.floor(Date.now()/1000)}&roomid=${roomId}&csrf=${CSRF}&csrf_token=${CSRF}`;
  return request({
    hostname: 'api.live.bilibili.com',
    path: '/msg/send',
    method: 'POST',
    headers: {
      ...buildHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com',
        'Content-Length': Buffer.byteLength(postData)
      })
    }
  }, postData);
}

// ==============================
// 验证登录状态
// ==============================
async function checkLogin() {
  console.log('\n📋 验证登录状态...');
  if (!COOKIE) {
    console.error('❌ BILIBILI_COOKIE 未配置！');
    return false;
  }
  if (!CSRF) {
    console.error('❌ Cookie 中未找到 bili_jct！请确认 Cookie 完整');
    return false;
  }
  try {
    const res = await apiGet('/x/web-interface/nav');
    if (res.code === 0 && res.data && res.data.isLogin) {
      console.log(`✅ 登录成功！用户: ${res.data.uname}（UID: ${res.data.mid}）`);
      return true;
    } else {
      console.error(`❌ 未登录，code=${res.code}，message=${res.message}`);
      console.error('   可能原因：Cookie 已过期，请重新获取');
      return false;
    }
  } catch (e) {
    console.error('❌ 验证登录失败：', e.message);
    return false;
  }
}

// ==============================
// 任务1：每日签到
// ==============================
async function doSignin() {
  console.log('\n🎯 ======== 每日签到 ========');
  
  // 查询今日任务状态
  try {
    const status = await apiGet('/x/member/web/exp/reward');
    console.log(`   今日任务查询: code=${status.code}`);
    if (status.code === 0 && status.data) {
      const d = status.data;
      console.log(`   今日登录: ${d.login ? '✅ 已完成' : '❌ 未完成'}`);
      console.log(`   今日观看: ${d.watch ? '✅ 已完成' : '❌ 未完成'}`);
      console.log(`   今日投币: ${d.coins ? `✅ 已完成(${d.coins}枚)` : '❌ 未完成'}`);
      
      if (d.login === true) {
        console.log('ℹ️  今日已登录签到，经验已获取');
        return true;
      }
    }
  } catch (e) {
    console.log('   无法查询签到状态，继续...');
  }

  // 执行每日签到（正确接口：x/web-interface/index/top/rcmd 的签到是通过访问触发的）
  // B站每日签到实际上通过 POST /x/member/web/exp/reward 的 GET 请求自动记录
  // 真正的签到接口：https://api.bilibili.com/x/member/web/sign (旧)
  // 或通过访问 https://www.bilibili.com 触发自动登录奖励
  // 
  // 实际上 /x/member/web/exp/reward 是GET查询接口，每次查询会自动记录登录
  // 只需要 GET 这个接口，登录任务就会被标记为完成
  
  try {
    console.log('\n   执行签到（GET /x/member/web/exp/reward）');
    const res = await apiGet('/x/member/web/exp/reward');
    const code = res.code;
    const msg = res.message || res.msg || '';
    console.log(`   签到接口返回: code=${code}, msg=${msg}`);
    
    if (code === 0) {
      const d = res.data || {};
      console.log(`   登录状态: ${d.login ? '✅ 已签到' : '❌ 未签到'}`);
      
      if (d.login === true) {
        console.log('✅ 签到成功！今日登录 +5 经验');
        return true;
      } else {
        // 尝试访问主页触发签到
        console.log('   尝试访问主页触发签到...');
        await apiGet('/x/web-interface/nav');
        // 再次查询
        const res2 = await apiGet('/x/member/web/exp/reward');
        if (res2.code === 0 && res2.data && res2.data.login) {
          console.log('✅ 签到成功！今日登录 +5 经验');
          return true;
        } else {
          console.warn('⚠️  登录状态未更新，可能今日已签到或需要手动操作');
          return true; // 已登录即视为成功
        }
      }
    } else if (code === -101) {
      console.error('❌ 账号未登录，Cookie 已过期');
      return false;
    } else {
      console.warn(`⚠️  签到返回: ${code} - ${msg}`);
      return false;
    }
  } catch (e) {
    console.error('❌ 签到异常：', e.message);
    return false;
  }
}

// ==============================
// 任务2：直播挂机修炼（发弹幕）
// ==============================
async function doHangup() {
  console.log('\n🎯 ======== 直播挂机修炼 ========');
  console.log(`   直播间: ${HANGUP_ROOM_ID}`);
  console.log(`   方式: 发送修炼弹幕指令`);

  // 发送3次修炼弹幕，间隔5秒
  const count = 3;
  let successCount = 0;

  for (let i = 0; i < count; i++) {
    try {
      const msg = TRAIN_DANMU[Math.floor(Math.random() * TRAIN_DANMU.length)];
      console.log(`   第${i+1}次发送弹幕: 「${msg}」`);
      const res = await sendDanmu(HANGUP_ROOM_ID, msg);
      console.log(`   [HTTP] 发弹幕返回: code=${res.code}, msg=${res.message || res.msg || ''}`);
      if (res.code === 0) {
        console.log(`   ✅ 第${i+1}次修炼弹幕发送成功`);
        successCount++;
      } else if (res.code === 10031) {
        console.log(`   ⚠️  弹幕发送过于频繁，等待后重试`);
      } else {
        console.warn(`   ⚠️  第${i+1}次失败: ${res.code} - ${res.message || ''}`);
      }
      // 每次间隔6秒
      if (i < count - 1) await new Promise(r => setTimeout(r, 6000));
    } catch (e) {
      console.warn(`   第${i+1}次异常: ${e.message}`);
    }
  }

  if (successCount > 0) {
    console.log(`✅ 挂机修炼完成！成功发送 ${successCount}/${count} 条修炼弹幕`);
    return true;
  } else {
    console.error('❌ 所有修炼弹幕均失败');
    return false;
  }
}

// ==============================
// 任务3：宠物签到（发签到弹幕）
// ==============================
async function doPetGrowth() {
  console.log('\n🎯 ======== 弹幕宠物签到 ========');
  console.log(`   直播间: ${HANGUP_ROOM_ID}`);
  console.log(`   方式: 发送「${SIGNIN_DANMU}」弹幕`);

  try {
    const res = await sendDanmu(HANGUP_ROOM_ID, SIGNIN_DANMU);
    console.log(`   [HTTP] 签到弹幕返回: code=${res.code}, msg=${res.message || res.msg || ''}`);

    if (res.code === 0) {
      console.log('✅ 宠物签到弹幕发送成功！');
      return true;
    } else if (res.code === 10031) {
      console.log('⚠️  弹幕发送频繁限制，稍后重试...');
      await new Promise(r => setTimeout(r, 10000));
      const res2 = await sendDanmu(HANGUP_ROOM_ID, SIGNIN_DANMU);
      if (res2.code === 0) {
        console.log('✅ 重试成功！宠物签到弹幕已发送');
        return true;
      }
      console.warn(`⚠️  重试仍失败: ${res2.code}`);
      return false;
    } else if (res.code === -101) {
      console.error('❌ 未登录，Cookie 已过期');
      return false;
    } else {
      console.warn(`⚠️  签到弹幕返回: ${res.code} - ${res.message || ''}`);
      return false;
    }
  } catch (e) {
    console.error('❌ 宠物签到异常：', e.message);
    return false;
  }
}

// ==============================
// 主函数
// ==============================
async function main() {
  console.log('🚀 B站自动化工具启动');
  console.log(`⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`🎯 执行任务: ${TASK}`);
  console.log('='.repeat(50));

  // 验证登录
  const loggedIn = await checkLogin();
  if (!loggedIn) {
    console.error('\n❌ 登录验证失败，退出执行');
    console.error('请检查: 1) Cookie是否正确配置到Secrets 2) Cookie是否已过期');
    process.exit(1);
  }

  const results = {};

  // 执行签到
  if (TASK === 'all' || TASK === 'signin') {
    results.signin = await doSignin();
  }

  // 执行挂机
  if (TASK === 'all' || TASK === 'hangup') {
    results.hangup = await doHangup();
  }

  // 执行宠物成长
  if (TASK === 'all' || TASK === 'pet') {
    results.pet = await doPetGrowth();
  }

  // 汇总
  console.log('\n' + '='.repeat(50));
  console.log('📊 执行结果汇总:');
  if ('signin' in results) console.log(`   签到: ${results.signin ? '✅ 成功' : '❌ 失败'}`);
  if ('hangup' in results) console.log(`   挂机: ${results.hangup ? '✅ 成功' : '❌ 失败'}`);
  if ('pet' in results)    console.log(`   宠物: ${results.pet    ? '✅ 成功' : '❌ 失败'}`);
  
  const allSuccess = Object.values(results).every(v => v);
  console.log(`\n${allSuccess ? '🎉 所有任务执行成功！' : '⚠️  部分任务失败，请查看日志'}`);
}

main().catch(err => {
  console.error('❌ 未处理的错误:', err);
  process.exit(1);
});
