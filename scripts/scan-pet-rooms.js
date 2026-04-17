/**
 * 扫描有弹幕宠物的开播直播间
 * 策略: 通过 B 站直播搜索页搜索"弹幕宠物"，提取房间号，逐个验证
 * 用法: node scripts/scan-pet-rooms.js
 */

const https = require('https');
const http = require('http');

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

function fetchHtml(targetUrl, referer = '') {
  return new Promise((resolve, reject) => {
    const follow = (url, hops = 0) => {
      if (hops > 3) return reject(new Error('跳转次数过多'));
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': referer || url,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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
          if (m && hops < 3) {
            const next = new URL(m[1], url).toString();
            return follow(next, hops + 1);
          }
          resolve(html);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('fetchHtml 超时')));
      req.end();
    };
    follow(targetUrl);
  });
}

// 检查直播间页面是否有弹幕宠物
async function checkPetRoom(roomId) {
  try {
    const html = await fetchHtml(`https://live.bilibili.com/${roomId}`, `https://live.bilibili.com/${roomId}`);
    if (!html || html.length < 1000) return null;

    // 主要检测方式: interactive_game_tag
    const tagMatch = html.match(/"interactive_game_tag":\{"action":\d+,"game_id":"([^"]+)","game_name":"([^"]+)"/);
    if (tagMatch) {
      const gameId = tagMatch[1];
      const gameName = tagMatch[2];
      if (gameName.includes('弹幕宠物') || gameName.includes('蛋宠')) {
        // 提取直播间标题
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/-.*?哔哩哔哩.*/, '').trim() : '';
        return { roomId, title, gameId, gameName, source: 'tag' };
      }
    }

    // 回退: 检查 heikeyun
    if (html.includes('heikeyun') && (html.includes('弹幕宠物') || html.includes('蛋宠'))) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/-.*?哔哩哔哩.*/, '').trim() : '';
      return { roomId, title, gameId: 'unknown', gameName: '检测到蛋宠', source: 'keyword' };
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('=== 扫描有弹幕宠物的开播直播间 ===\n');
  console.log('策略: 通过 B 站直播搜索"弹幕宠物"获取直播间列表，逐个验证\n');

  // 搜索关键词列表
  const keywords = ['弹幕宠物', '蛋宠修炼', '蛋宠挂机'];

  const allRoomIds = new Set();

  for (const keyword of keywords) {
    console.log(`--- 搜索: "${keyword}" ---`);
    // B 站直播搜索 API
    try {
      const encoded = encodeURIComponent(keyword);
      const res = await request({
        hostname: 'api.live.bilibili.com',
        path: `/xlive/web-interface/search/type?search_type=live&keyword=${encoded}&page=1&page_size=30`,
        method: 'GET',
        headers: {
          'Referer': `https://search.bilibili.com/live?keyword=${encoded}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.code === 0 && res.data?.result) {
        for (const r of res.data.result) {
          const roomId = String(r.roomid || r.room_id);
          allRoomIds.add(roomId);
        }
        console.log(`  API 返回 ${res.data.result.length} 个房间`);
      } else {
        console.log(`  API: code=${res.code}, 尝试 web 页面`);
      }
    } catch (e) {
      console.log(`  API 失败: ${e.message}`);
    }

    // 回退: 抓搜索页面
    try {
      const encoded = encodeURIComponent(keyword);
      const searchHtml = await fetchHtml(
        `https://search.bilibili.com/live?keyword=${encoded}&order=online`,
        'https://www.bilibili.com'
      );
      const links = [...searchHtml.matchAll(/live\.bilibili\.com\/(\d{4,})/g)].map(m => m[1]);
      for (const id of links) allRoomIds.add(id);
      console.log(`  Web 页面提取 ${links.length} 个房间链接`);
    } catch (e) {
      console.log(`  Web 搜索失败: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // 额外: 已知常开蛋宠的直播间
  const knownPetRooms = ['1788399444'];
  for (const id of knownPetRooms) allRoomIds.add(id);

  // 额外: 直播间指数扫描 — 从推荐接口取房间
  console.log('\n--- 从直播推荐获取更多房间 ---');
  try {
    const recRes = await request({
      hostname: 'api.live.bilibili.com',
      path: '/xlive/web-interface/v1/index/getRoomList?platform=web&page=1&page_size=100',
      method: 'GET',
      headers: {
        'Referer': 'https://live.bilibili.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (recRes.code === 0 && recRes.data?.list) {
      for (const r of recRes.data.list) {
        const roomId = String(r.roomid || r.room_id);
        allRoomIds.add(roomId);
      }
      console.log(`  推荐列表: ${recRes.data.list.length} 个房间`);
    } else {
      console.log(`  推荐列表: code=${recRes.code}`);
    }
    // 第二页
    const recRes2 = await request({
      hostname: 'api.live.bilibili.com',
      path: '/xlive/web-interface/v1/index/getRoomList?platform=web&page=2&page_size=100',
      method: 'GET',
      headers: {
        'Referer': 'https://live.bilibili.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (recRes2.code === 0 && recRes2.data?.list) {
      for (const r of recRes2.data.list) {
        const roomId = String(r.roomid || r.room_id);
        allRoomIds.add(roomId);
      }
      console.log(`  推荐列表第2页: ${recRes2.data.list.length} 个房间`);
    }
  } catch (e) {
    console.log(`  推荐列表失败: ${e.message}`);
  }

  // 手游分区（弹幕宠物最常见）
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await request({
        hostname: 'api.live.bilibili.com',
        path: `/xlive/web-interface/v1/second/getListByArea?platform=web&parent_area_id=9&area_id=0&sort_type=online&page=${page}&page_size=30`,
        method: 'GET',
        headers: {
          'Referer': 'https://live.bilibili.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.code === 0 && res.data?.list) {
        for (const r of res.data.list) {
          const roomId = String(r.roomid || r.room_id);
          allRoomIds.add(roomId);
        }
        console.log(`  手游分区第${page}页: ${res.data.list.length} 个房间`);
      } else {
        console.log(`  手游分区第${page}页: code=${res.code}`);
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    console.log(`  手游分区失败: ${e.message}`);
  }

  console.log(`\n共 ${allRoomIds.size} 个待检查房间，开始逐个验证弹幕宠物...\n`);

  const petRooms = [];
  const roomArr = [...allRoomIds];
  let checked = 0;

  for (const roomId of roomArr) {
    checked++;
    const result = await checkPetRoom(roomId);
    if (result) {
      petRooms.push(result);
      console.log(`✅ [${checked}/${roomArr.length}] 房间 ${result.roomId} "${result.title}" [${result.gameName}]`);
    }
    if (checked % 20 === 0) {
      console.log(`  进度: ${checked}/${roomArr.length}，已找到 ${petRooms.length} 个蛋宠房`);
    }
    // 并发 1 个，避免触发限流
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n=========== 扫描结果 ===========');
  console.log(`检查了 ${checked} 个房间，找到 ${petRooms.length} 个有弹幕宠物的直播间\n`);

  const output = {
    scanTime: new Date().toISOString(),
    checked,
    total: petRooms.length,
    rooms: petRooms.map(r => ({
      roomId: r.roomId,
      title: r.title,
      gameName: r.gameName,
      source: r.source
    }))
  };

  console.log(JSON.stringify(output, null, 2));

  const roomIds = petRooms.map(r => r.roomId);
  console.log(`\n--- 可用于代码的备用房间数组 ---`);
  console.log(`const BACKUP_PET_ROOMS = ${JSON.stringify(roomIds, null, 2)};`);
}

main().catch(e => { console.error(e); process.exit(1); });
