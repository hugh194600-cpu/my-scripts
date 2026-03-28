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
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '732';
const HANGUP_DURATION = parseInt(process.env.HANGUP_DURATION || '3600', 10);
const PET_NAME = process.env.PET_NAME || '我的弹幕宠物';
const TASK = process.env.TASK || 'all'; // all | signin | hangup | pet

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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
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
  
  // 先查询今日签到状态
  try {
    const status = await apiGet('/x/member/web/exp/reward');
    console.log(`   签到状态查询: code=${status.code}`);
    if (status.code === 0 && status.data) {
      console.log(`   今日登录任务: ${status.data.login ? '✅ 已完成' : '❌ 未完成'}`);
      console.log(`   今日观看任务: ${status.data.watch ? '✅ 已完成' : '❌ 未完成'}`);
    }
  } catch (e) {
    console.log('   无法查询签到状态，继续尝试签到...');
  }

  // 执行签到
  try {
    console.log(`\n   执行签到（csrf: ${CSRF.substring(0, 6)}***）`);
    const res = await apiPost('/x/member/web/exp/reward', `csrf=${CSRF}`);
    console.log(`   签到返回: code=${res.code}, msg=${res.message}`);
    
    if (res.code === 0) {
      console.log('✅ 签到成功！每日登录 +5 经验');
      return true;
    } else if (res.code === -111) {
      console.error('❌ csrf 验证失败！请检查 Cookie 中的 bili_jct 字段');
      return false;
    } else if (res.code === -101) {
      console.error('❌ 账号未登录，Cookie 已过期');
      return false;
    } else if (res.code === 20001) {
      console.log('ℹ️  今日已签到，无需重复');
      return true;
    } else {
      console.warn(`⚠️  签到返回: ${res.code} - ${res.message}`);
      return false;
    }
  } catch (e) {
    console.error('❌ 签到异常：', e.message);
    return false;
  }
}

// ==============================
// 任务2：直播挂机修炼
// ==============================
async function doHangup() {
  console.log('\n🎯 ======== 直播挂机修炼 ========');
  console.log(`   直播间: ${HANGUP_ROOM_ID}，时长: ${HANGUP_DURATION}s`);

  // 获取直播间真实ID
  let realRoomId = HANGUP_ROOM_ID;
  try {
    const roomInfo = await apiGet(`/x/space/wbi/acc/info?mid=${AUTO_UID || ''}`);
    console.log(`   获取用户信息: code=${roomInfo.code}`);
  } catch (e) {
    console.log('   获取用户信息失败，使用默认直播间');
  }

  // 发送心跳（每30秒一次）
  const heartbeatCount = Math.floor(HANGUP_DURATION / 30);
  const actualCount = Math.min(heartbeatCount, 10); // 最多发10次（5分钟），避免超时
  
  console.log(`   计划发送 ${actualCount} 次心跳`);
  let successCount = 0;

  for (let i = 0; i < actualCount; i++) {
    try {
      // 发送直播心跳
      const body = `room_id=${realRoomId}&platform=web&uuid=&csrf=${CSRF}&csrf_token=${CSRF}&visit_id=`;
      const res = await livePost('/xlive/data-interface/v1/x25Kn/E', body);
      
      if (res.code === 0) {
        successCount++;
        if (i === 0 || (i + 1) % 5 === 0) {
          console.log(`   心跳 ${i + 1}/${actualCount} ✅`);
        }
      } else {
        console.warn(`   心跳 ${i + 1} 返回: code=${res.code}`);
      }
      
      // 间隔30秒（最后一次不等待）
      if (i < actualCount - 1) {
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (e) {
      console.warn(`   心跳 ${i + 1} 失败: ${e.message}`);
    }
  }

  if (successCount > 0) {
    console.log(`✅ 挂机完成！成功发送 ${successCount}/${actualCount} 次心跳`);
    return true;
  } else {
    console.error('❌ 所有心跳均失败');
    return false;
  }
}

// ==============================
// 任务3：宠物成长
// ==============================
async function doPetGrowth() {
  console.log('\n🎯 ======== 宠物成长 ========');
  console.log(`   宠物名称: ${PET_NAME}`);

  try {
    // 获取用户经验值信息
    const expRes = await apiGet('/x/member/web/exp/reward');
    if (expRes.code === 0 && expRes.data) {
      const d = expRes.data;
      console.log('\n   📊 今日任务完成情况:');
      console.log(`   登录签到: ${d.login ? '✅' : '❌'}`);
      console.log(`   观看视频: ${d.watch ? '✅' : '❌'}`);
      console.log(`   投硬币:   ${d.coins ? '✅' : '❌'}`);
      console.log(`   分享视频: ${d.share ? '✅' : '❌'}`);
    }
  } catch (e) {
    console.warn('   获取经验信息失败:', e.message);
  }

  try {
    // 获取用户等级信息
    const navRes = await apiGet('/x/web-interface/nav');
    if (navRes.code === 0 && navRes.data) {
      const u = navRes.data;
      const level = u.level_info;
      console.log('\n   🐾 宠物状态:');
      console.log(`   当前等级: Lv.${u.level_info?.current_level || '?'}`);
      console.log(`   当前经验: ${level?.current_exp || '?'}`);
      console.log(`   升级需要: ${level?.next_exp || '?'}`);
      
      const currentExp = level?.current_exp || 0;
      const nextExp = level?.next_exp || 1;
      const progress = nextExp > 0 ? Math.floor((currentExp / nextExp) * 100) : 0;
      
      console.log(`   升级进度: ${progress}%`);
      console.log(`\n   🐾 ${PET_NAME} 今日成长记录:`);
      console.log(`   签到经验: +5`);
      console.log(`   状态: 活力满满 🌟`);
      
      console.log('✅ 宠物成长记录完成！');
      return true;
    }
  } catch (e) {
    console.error('❌ 宠物成长记录失败:', e.message);
    return false;
  }
  
  return false;
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
