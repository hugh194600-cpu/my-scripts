/**
 * 探测蛋宠面板中的"排名-直播间推荐"区域
 * 使用已知 panel_url token 直接访问面板
 */
const https = require('https');
const http = require('http');
const fs = require('fs');

function fetchHtml(targetUrl, referer) {
  return new Promise((resolve, reject) => {
    const follow = (url, hops = 0) => {
      if (hops > 4) return reject(new Error('too many hops'));
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': referer || url, 'Accept': 'text/html,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        }
      };
      const req = lib.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return follow(new URL(res.headers.location, url).toString(), hops + 1);
        }
        let html = '';
        res.on('data', c => { html += c; });
        res.on('end', () => {
          const m = html.match(/Object moved to <a href="([^"]+)"/i);
          if (m && hops < 4) return follow(new URL(m[1], url).toString(), hops + 1);
          resolve(html);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy());
      req.end();
    };
    follow(targetUrl);
  });
}

async function main() {
  const roomId = '1788399444';
  // 从 GitHub Actions 日志中提取的 panel_url token
  const panelUrl = 'https://petpanel.heikeyun.com/Main.aspx?token=6dfc7bfae73cf7f04ab519fdc9aaa1b8';

  console.log('=== 访问蛋宠面板 ===');
  const panelHtml = await fetchHtml(panelUrl, 'https://live.bilibili.com/' + roomId);
  console.log('面板大小:', panelHtml.length);

  fs.writeFileSync('panel_debug.html', panelHtml, 'utf8');
  console.log('已保存到 panel_debug.html');

  // 搜索关键词
  const keywords = ['推荐', '排名', 'recommend', 'rank', '直播间', 'room_id', 'roomid', 'anchor', 'uid', 'live.bilibili'];
  console.log('\n--- 关键词统计 ---');
  for (const kw of keywords) {
    const count = (panelHtml.match(new RegExp(kw, 'gi')) || []).length;
    if (count > 0) console.log(`  "${kw}" 出现 ${count} 次`);
  }

  // 所有 live.bilibili.com 链接
  const liveLinks = [...panelHtml.matchAll(/live\.bilibili\.com\/(\d+)/g)].map(m => m[1]);
  const uniqueLinks = [...new Set(liveLinks)];
  console.log('\n面板中直播间链接 (' + uniqueLinks.length + '个):');
  for (const id of uniqueLinks) console.log('  房间', id);

  // "排名"附近
  let idx = panelHtml.indexOf('排名');
  if (idx >= 0) {
    console.log('\n--- "排名"附近 ---');
    console.log(panelHtml.slice(Math.max(0, idx - 200), Math.min(panelHtml.length, idx + 1500)));
  }

  // "推荐"附近
  idx = panelHtml.indexOf('推荐');
  if (idx >= 0) {
    console.log('\n--- "推荐"附近 ---');
    console.log(panelHtml.slice(Math.max(0, idx - 200), Math.min(panelHtml.length, idx + 1500)));
  }

  // 所有 a 标签
  console.log('\n--- 所有 a 标签 href ---');
  const hrefs = [...panelHtml.matchAll(/<a[^>]+href="([^"]+)"/gi)].map(m => m[1]);
  for (const h of hrefs) console.log(' ', h.slice(0, 200));

  // 搜索所有 onclick / 函数调用里的房间信息
  console.log('\n--- 包含 room 的脚本片段 ---');
  const roomSnippets = [...panelHtml.matchAll(/room[_i][di][^'"}]{0,100}/gi)].map(m => m[0]);
  const uniqueSnippets = [...new Set(roomSnippets)];
  for (const s of uniqueSnippets) console.log(' ', s);

  // 搜索 src 包含 .js 的脚本
  console.log('\n--- 面板加载的 JS 脚本 ---');
  const scripts = [...panelHtml.matchAll(/src="([^"]+\.js[^"]*)"/gi)].map(m => m[1]);
  for (const s of scripts) console.log(' ', s);
}

main().catch(e => console.error(e));
