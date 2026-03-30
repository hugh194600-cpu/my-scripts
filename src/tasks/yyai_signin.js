/**
 * 边界AI平台 (yyai8.com) 每日签到
 * API: POST https://api.ai1foo.com/api/v2/user/signin/do
 * 签到失败（含token失效）时发送QQ邮件通知
 */

const https = require('https');
const tls   = require('tls');

const YYAI_TOKEN        = process.env.YYAI_TOKEN;         // token（短）
const YYAI_ACCESS_TOKEN = process.env.YYAI_ACCESS_TOKEN;  // access-token（长）
const YYAI_UID          = process.env.YYAI_UID;           // uid
const MAIL_USER         = process.env.QQ_MAIL_USER || ''; // QQ邮箱地址
const MAIL_PASS         = process.env.QQ_MAIL_PASS || ''; // QQ邮箱授权码

// ==============================
// QQ邮件通知
// ==============================
function sendMail(subject, body) {
  return new Promise((resolve) => {
    if (!MAIL_USER || !MAIL_PASS) {
      console.log('   ℹ️  未配置邮件通知（QQ_MAIL_USER / QQ_MAIL_PASS）');
      return resolve(false);
    }

    const boundary = '----=_NodeMailer_' + Date.now();
    const bodyB64  = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
    const message  = [
      `From: =?UTF-8?B?${Buffer.from('边界AI签到助手').toString('base64')}?= <${MAIL_USER}>`,
      `To: ${MAIL_USER}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
      `--${boundary}--`,
    ].join('\r\n');

    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {});
    let step = 0;
    let buf  = '';

    const send = (cmd) => { socket.write(cmd + '\r\n'); };

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (step === 0 && line.startsWith('220')) {
          send('EHLO smtp.qq.com'); step = 1;
        } else if (step === 1 && line.includes('250')) {
          const auth = Buffer.from('\0' + MAIL_USER + '\0' + MAIL_PASS).toString('base64');
          send(`AUTH PLAIN ${auth}`); step = 2;
        } else if (step === 2 && line.startsWith('235')) {
          send(`MAIL FROM:<${MAIL_USER}>`); step = 3;
        } else if (step === 3 && line.startsWith('250')) {
          send(`RCPT TO:<${MAIL_USER}>`); step = 4;
        } else if (step === 4 && line.startsWith('250')) {
          send('DATA'); step = 5;
        } else if (step === 5 && line.startsWith('354')) {
          send(message + '\r\n.'); step = 6;
        } else if (step === 6 && line.startsWith('250')) {
          send('QUIT'); socket.destroy(); resolve(true);
        } else if (line.startsWith('5') || line.startsWith('4')) {
          console.warn(`   ⚠️  SMTP错误: ${line}`);
          socket.destroy(); resolve(false);
        }
      }
    });
    socket.on('error', (e) => { console.warn('   邮件连接错误:', e.message); resolve(false); });
    socket.setTimeout(15000, () => { socket.destroy(); resolve(false); });
  });
}

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

    const msg = res.msg || res.message || '';

    // 判断签到结果
    // 成功：code 0/1/200，或 success=true，或 msg 含"成功"/"sign"
    const isSuccess =
      res.code === 0 || res.code === 1 || res.code === 200 ||
      res.success === true ||
      (typeof msg === 'string' && (msg.includes('成功') || msg.toLowerCase().includes('success')));

    // 已签到：msg 含"已签到"/"already"/"重复"，或 code 为特定重复签到码
    const isAlready =
      (typeof msg === 'string' && (
        msg.includes('已签到') || msg.includes('已经签到') ||
        msg.toLowerCase().includes('already') || msg.includes('重复')
      ));

    if (isAlready) {
      console.log('   ℹ️  今日已签到，跳过');
      return true;
    } else if (isSuccess) {
      const points = res.data?.points || res.data?.score || res.data?.coin ||
                     res.data?.integral || res.data?.exp || '';
      console.log(`   ✅ 签到成功！${points ? '获得积分: ' + points : ''}`);
      return true;
    } else {
      const failMsg = msg || JSON.stringify(res);
      console.warn(`   ⚠️  签到失败: code=${res.code}, msg=${failMsg}`);

      // 判断是否 token 失效（401 / unauthorized / token相关错误）
      const isTokenExpired =
        res.code === 401 ||
        (typeof failMsg === 'string' && (
          failMsg.includes('token') || failMsg.includes('未登录') ||
          failMsg.includes('登录') || failMsg.toLowerCase().includes('unauthorized') ||
          failMsg.toLowerCase().includes('invalid') || failMsg.toLowerCase().includes('expire')
        ));

      if (isTokenExpired) {
        console.error('   🚨 access-token 已失效，发送邮件提醒...');
        await sendMail(
          '【边界AI签到】⚠️ access-token 已失效，请及时更新',
          `边界AI平台 (yyai8.com) 自动签到失败，原因：access-token 已过期。\n\n请按以下步骤更新：\n1. 打开浏览器，登录 https://yyai8.com/signIn\n2. F12 → Network → 点击"立即签到"\n3. 找到 POST do 请求 → Request Headers\n4. 复制 access-token 的值\n5. 前往 GitHub 仓库 → Settings → Secrets → 更新 YYAI_ACCESS_TOKEN\n\n错误信息：${failMsg}\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
        );
      } else {
        // 普通失败也发邮件
        await sendMail(
          '【边界AI签到】⚠️ 今日签到失败',
          `边界AI平台 (yyai8.com) 自动签到失败。\n\n错误信息：code=${res.code}, msg=${failMsg}\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
        );
      }
      return false;
    }
  } catch (e) {
    console.error('   ❌ 签到异常:', e.message);
    await sendMail(
      '【边界AI签到】❌ 签到脚本异常',
      `边界AI平台签到脚本发生异常：${e.message}\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    );
    return false;
  }
}

doSignin().then(ok => {
  process.exit(ok ? 0 : 1);
});
