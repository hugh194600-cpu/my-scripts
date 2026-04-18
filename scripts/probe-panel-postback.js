/**
 * 模拟 ASP.NET postback 获取蛋宠面板的排名 tab 数据
 * 目标：提取排名-直播间推荐中的房间号
 */
const https = require('https');
const http = require('http');
const fs = require('fs');

function requestRaw(opts, postData = null, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const makeReq = (currentOpts, redirects = 0) => {
      const req = https.request(currentOpts, res => {
        // 处理 HTTP 跳转
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= maxRedirects) return reject(new Error('too many redirects'));
          const loc = new URL(res.headers.location, `https://${currentOpts.hostname}`).toString();
          res.resume();
          const u = new URL(loc);
          currentOpts.hostname = u.hostname;
          currentOpts.path = u.pathname + u.search;
          return makeReq(currentOpts, redirects + 1);
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          // ASP.NET "Object moved" redirect in HTML body
          const m = data.match(/Object moved to <a href="([^"]+)"/i);
          if (m && redirects < maxRedirects) {
            const loc = new URL(m[1], `https://${currentOpts.hostname}`).toString();
            const u = new URL(loc);
            currentOpts.hostname = u.hostname;
            currentOpts.path = u.pathname + u.search;
            return makeReq(currentOpts, redirects + 1);
          }
          resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy());
      if (postData) req.write(postData);
      req.end();
    };
    makeReq(opts);
  });
}

async function main() {
  const panelBaseUrl = 'https://petpanel.heikeyun.com';
  const token = '6dfc7bfae73cf7f04ab519fdc9aaa1b8';
  const url = panelBaseUrl + '/Main.aspx?token=' + token;

  console.log('=== Step 1: 获取面板初始页面（提取 __VIEWSTATE 等隐藏字段）===');
  const html = await requestRaw({
    hostname: 'petpanel.heikeyun.com',
    path: '/Main.aspx?token=' + token,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://live.bilibili.com/1788399444',
      'Accept': 'text/html',
    }
  });
  console.log('初始页面大小:', html.length);

  // 提取 ASP.NET postback 需要的隐藏字段
  const viewStateMatch = html.match(/id="__VIEWSTATE"\s+value="([^"]+)"/);
  const viewStateGenMatch = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/);
  const eventValMatch = html.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/);

  if (!viewStateMatch) {
    console.log('未找到 __VIEWSTATE，可能需要登录或 token 已过期');
    // 保存页面用于调试
    fs.writeFileSync('panel_initial.html', html, 'utf8');
    console.log('已保存到 panel_initial.html');
    return;
  }

  const viewState = viewStateMatch[1];
  const viewStateGen = viewStateGenMatch ? viewStateGenMatch[1] : '';
  const eventVal = eventValMatch ? eventValMatch[1] : '';

  console.log('__VIEWSTATE 长度:', viewState.length);
  console.log('__VIEWSTATEGENERATOR:', viewStateGen);
  console.log('__EVENTVALIDATION 长度:', eventVal ? eventVal.length : 0);

  // 找排名 tab 的触发按钮
  // 搜索所有可能的 tab 切换按钮
  const tabButtons = [...html.matchAll(/id="(TabRank[^"]*|btnTabRank[^"]*|RankTab[^"]*|AMall[^"]*|TabRanking[^"]*)"/gi)].map(m => m[1]);
  console.log('\n排名相关的元素 ID:', tabButtons);

  // 更广泛搜索 tab 按钮
  const allButtons = [...html.matchAll(/id="(Tab\w+|btnTab\w+|ATab\w+|MallType\w+)"[^>]*>/gi)].map(m => m[1]);
  console.log('所有 Tab 元素 ID:', allButtons);

  // 搜索所有 LinkButton 或触发 postback 的元素
  const postbackElements = [...html.matchAll(/id="(\w+)"[^>]*onclick="__doPostBack\('(\w+)',\s*'([^']*)'\)"/gi)];
  console.log('\n带 __doPostBack 的元素 (' + postbackElements.length + '个):');
  for (const m of postbackElements) {
    console.log(`  id="${m[1]}" -> __doPostBack('${m[2]}', '${m[3]}')`);
  }

  // 如果没有找到具体的 postback 元素，尝试搜索所有包含 "排名" 的 HTML 结构
  const rankIdx = html.indexOf('排名');
  if (rankIdx >= 0) {
    console.log('\n"排名"出现在位置', rankIdx);
    // 找到包含"排名"的最小 HTML 元素
    const beforeRank = html.slice(Math.max(0, rankIdx - 500), rankIdx);
    const afterRank = html.slice(rankIdx, Math.min(html.length, rankIdx + 500));
    console.log('\n--- 排名前后 500 字符 ---');
    console.log(beforeRank.slice(-200) + '>>>排名<<<' + afterRank.slice(0, 300));
  }

  // 保存初始页面
  fs.writeFileSync('panel_initial.html', html, 'utf8');
  console.log('\n初始页面已保存到 panel_initial.html');
}

main().catch(e => console.error(e));
