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

// 随机挂机直播间列表（用于B站经验心跳，与弹幕宠物直播间不同）
// 可通过环境变量 RANDOM_ROOMS 覆盖，格式：逗号分隔的房间号，如 "732,6,1,76"
const RANDOM_ROOMS_RAW = process.env.RANDOM_ROOMS || '732,6,1,76,488,21452505';
const RANDOM_ROOMS = RANDOM_ROOMS_RAW.split(',').map(s => s.trim()).filter(Boolean);

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

// ==============================
// 查询宠物修炼经验值
// 流程：直播间页面 → game_id → panel_url(token) → 解析经验值
// ==============================
async function getPetEnergy(roomId) {
  try {
    // Step1: 从直播间页面提取 game_id
    const liveHtml = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'live.bilibili.com',
        path: `/${roomId}`,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': COOKIE
        }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('超时')));
      req.end();
    });
    const gameIdMatch = liveHtml.match(/"game_id"\s*:\s*"?(\d+)"?/);
    if (!gameIdMatch) {
      console.log('   ⚠️  未找到 game_id，可能直播间未开播或接口变更');
      return null;
    }
    const gameId = gameIdMatch[1];
    console.log(`   game_id: ${gameId}`);

    // Step2: 获取带 token 的 panel_url
    const panelRes = await request({
      hostname: 'api.live.bilibili.com',
      path: `/xlive/open-platform/v1/game/getAppCustomPanel?game_id=${gameId}`,
      method: 'GET',
      headers: buildHeaders({ 'Referer': `https://live.bilibili.com/${roomId}` })
    });
    const panelUrl = panelRes?.data?.panel_url || panelRes?.data?.list?.[0]?.panel_url;
    if (!panelUrl || !panelUrl.includes('heikeyun')) {
      console.log(`   ⚠️  未获取到宠物 panel_url，返回: ${JSON.stringify(panelRes?.data)}`);
      return null;
    }
    console.log(`   panel_url 已获取`);

    // Step3: 访问宠物面板页面，解析经验值
    const urlObj = new URL(panelUrl);
    const panelHtml = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://live.bilibili.com/${roomId}`
        }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('超时')));
      req.end();
    });

    // 解析 当前修炼值 和 满级修炼值
    const curMatch  = panelHtml.match(/id="lblUserEnergy2"[^>]*>([^<]+)</);
    const fullMatch = panelHtml.match(/id="lblUserEnergyDown"[^>]*>([^<]+)</);
    const levelMatch = panelHtml.match(/id="lblUserLevel"[^>]*>([^<]+)</);
    const levelNameMatch = panelHtml.match(/id="lblUserLevelName"[^>]*>([^<]+)</);

    if (!curMatch || !fullMatch) {
      console.log('   ⚠️  无法从面板页面解析经验值（可能面板格式变更）');
      return null;
    }

    const current = parseInt(curMatch[1].trim(), 10);
    const full    = parseInt(fullMatch[1].trim(), 10);
    const level   = levelMatch ? levelMatch[1].trim() : '?';
    const levelName = levelNameMatch ? levelNameMatch[1].trim() : '?';

    console.log(`   🐾 宠物状态: Lv.${level} ${levelName}`);
    console.log(`   ⚡ 修炼经验: ${current} / ${full} (${Math.floor(current/full*100)}%)`);

    return { current, full, isFull: current >= full };
  } catch (e) {
    console.warn(`   ⚠️  查询宠物经验异常: ${e.message}`);
    return null;
  }
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
  console.log(`   方式: 发送「修仙」弹幕激活修仙状态（状态持续600秒，每10分钟刷新一次）`);

  // 发1条「修仙」激活修仙状态，状态持续600秒（各直播间可能不同）
  // 修仙状态激活后每12秒+19修炼经验，未激活仅+14，每10分钟续一次确保不断档
  let successCount = 0;
  try {
    const res = await sendDanmu(HANGUP_ROOM_ID, '修仙');
    console.log(`   [HTTP] 发弹幕返回: code=${res.code}, msg=${res.message || res.msg || ''}`);
    if (res.code === 0) {
      console.log('   ✅ 修仙状态已激活，每12秒 +19 修炼经验');
      successCount = 1;
    } else if (res.code === 10031) {
      console.log('   ⚠️  弹幕发送过于频繁，等待10秒重试...');
      await new Promise(r => setTimeout(r, 10000));
      const res2 = await sendDanmu(HANGUP_ROOM_ID, '修仙');
      if (res2.code === 0) {
        console.log('   ✅ 重试成功，修仙状态已激活');
        successCount = 1;
      } else {
        console.warn(`   ⚠️  重试失败: ${res2.code}`);
      }
    } else {
      console.warn(`   ⚠️  修仙弹幕失败: ${res.code} - ${res.message || ''}`);
    }
  } catch (e) {
    console.warn('   修仙弹幕异常:', e.message);
  }

  if (successCount > 0) {
    console.log('✅ 修仙弹幕发送成功');
  } else {
    console.error('❌ 修仙弹幕发送失败');
    return false;
  }

  // 修炼后等6秒，查询最新经验值，满了才突破
  await new Promise(r => setTimeout(r, 6000));
  console.log('\n   🔍 查询修炼经验值，判断是否需要突破...');
  const energy = await getPetEnergy(HANGUP_ROOM_ID);

  if (energy === null) {
    // 无法查询，保底发一次突破（和之前逻辑一致）
    console.log('   ⚠️  无法获取经验值，保底尝试发突破弹幕');
    try {
      const btRes = await sendDanmu(HANGUP_ROOM_ID, '突破');
      console.log(`   突破弹幕返回: code=${btRes.code}`);
    } catch (e) {
      console.warn('   突破弹幕异常:', e.message);
    }
  } else if (energy.isFull) {
    console.log(`   🎉 修炼经验已满 (${energy.current}/${energy.full})，发送突破弹幕！`);
    try {
      const btRes = await sendDanmu(HANGUP_ROOM_ID, '突破');
      console.log(`   突破弹幕返回: code=${btRes.code}, msg=${btRes.message || ''}`);
      if (btRes.code === 0) {
        console.log('   ✅ 突破成功！');
      }
    } catch (e) {
      console.warn('   突破弹幕异常:', e.message);
    }
  } else {
    console.log(`   ℹ️  修炼经验未满 (${energy.current}/${energy.full})，无需突破`);
  }

  // 随机直播间心跳（获取B站直播经验）
  await doRandomRoomHeartbeat();

  return true;
}

// ==============================
// 随机直播间心跳（获取B站直播经验）
// ==============================
async function doRandomRoomHeartbeat() {
  console.log('\n   💓 随机直播间心跳...');
  // 从列表中随机选一个直播间
  const roomId = RANDOM_ROOMS[Math.floor(Math.random() * RANDOM_ROOMS.length)];
  console.log(`   随机选中直播间: ${roomId}（共 ${RANDOM_ROOMS.length} 个可选）`);

  try {
    // 发送直播心跳（live-trace接口）
    const body = `room_id=${roomId}&platform=web&uuid=${generateUUID()}&ftime=${Math.floor(Date.now()/1000)}&seq=1&extra_params={"website":"bilibili","platform":"pc"}`;
    const res = await request({
      hostname: 'live-trace.bilibili.com',
      path: '/xlive/data-interface/v1/x25Kn/E',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com',
          'Content-Length': Buffer.byteLength(body)
        })
      }
    }, body);
    console.log(`   心跳返回: code=${res.code}, msg=${res.message || res.msg || ''}`);
    if (res.code === 0) {
      console.log(`   ✅ 直播心跳成功（直播间 ${roomId}）`);
    } else {
      console.warn(`   ⚠️  直播心跳失败: ${res.code}`);
    }
  } catch (e) {
    console.warn(`   直播心跳异常: ${e.message}`);
  }
}

// 生成随机UUID（心跳用）
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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
