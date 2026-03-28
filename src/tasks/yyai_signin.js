/**
 * 边界AI平台 (yyai8.com) 每日签到
 * API: POST https://api.ai1foo.com/api/v2/user/signin/do
 */

const https = require('https');

const YYAI_TOKEN       = process.env.YYAI_TOKEN;        // token（短）
const YYAI_ACCESS_TOKEN = process.env.YYAI_ACCESS_TOKEN; // access-token（长）
const YYAI_UID         = process.env.YYAI_UID;           // uid

function request(options, body = '') {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data, statusCode: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function doSignin() {
  console.log('\n🎯 ======== 边界AI 每日签到 ========');

  if (!YYAI_TOKEN || !YYAI_ACCESS_TOKEN || !YYAI_UID) {
    console.error('❌ 缺少配置: YYAI_TOKEN / YYAI_ACCESS_TOKEN / YYAI_UID');
    process.exit(1);
  }

  const body = '{}';

  try {
    const res = await request({
      hostname: 'api.ai1foo.com',
      path: '/api/v2/user/signin/do',
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'access-token': YYAI_ACCESS_TOKEN,
        'app-name': 'bianjie',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'origin': 'https://yyai8.com',
        'referer': 'https://yyai8.com/',
        'token': YYAI_TOKEN,
        'uid': YYAI_UID,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
      }
    }, body);

    console.log('   返回数据:', JSON.stringify(res));

    // 判断签到结果
    if (res.code === 0 || res.code === 200 || res.success === true) {
      const points = res.data?.points || res.data?.score || res.data?.coin || '';
      console.log(`   ✅ 签到成功！${points ? '获得积分: ' + points : ''}`);
      return true;
    } else if (
      res.code === 1 ||
      (res.msg && (res.msg.includes('已签到') || res.msg.includes('already') || res.msg.includes('重复')))
    ) {
      console.log('   ℹ️  今日已签到，跳过');
      return true;
    } else {
      console.warn(`   ⚠️  签到失败: code=${res.code}, msg=${res.msg || res.message || JSON.stringify(res)}`);
      return false;
    }
  } catch (e) {
    console.error('   ❌ 签到异常:', e.message);
    return false;
  }
}

doSignin().then(ok => {
  process.exit(ok ? 0 : 1);
});
