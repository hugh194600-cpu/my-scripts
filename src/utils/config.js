require('dotenv').config();

class Config {
  constructor() {
    this.bilibili = {
      cookie: process.env.BILIBILI_COOKIE || '',
      uid: process.env.BILIBILI_UID || ''
    };

    this.signin = {
      enabled: process.env.AUTO_SIGNIN === 'true',
      time: process.env.SIGNIN_TIME || '08:00'
    };

    this.hangup = {
      enabled: process.env.AUTO_HANGUP === 'true',
      roomId: process.env.HANGUP_ROOM_ID || '732',
      duration: parseInt(process.env.HANGUP_DURATION || '3600', 10)
    };

    this.pet = {
      enabled: process.env.AUTO_PET_GROWTH === 'true',
      name: process.env.PET_NAME || '我的弹幕宠物'
    };

    this.notifications = {
      enabled: process.env.ENABLE_NOTIFICATIONS === 'true',
      webhookUrl: process.env.WEBHOOK_URL || ''
    };

    this.github = {
      schedule: process.env.RUN_SCHEDULE || '0 8 * * *'
    };

    this.debug = process.env.DEBUG === 'true';
    this.logLevel = process.env.LOG_LEVEL || 'info';
  }

  // 验证必要配置
  validate() {
    const errors = [];

    if (!this.bilibili.cookie) {
      errors.push('BILIBILI_COOKIE 未配置');
    }

    if (!this.bilibili.uid) {
      errors.push('BILIBILI_UID 未配置');
    }

    if (errors.length > 0) {
      throw new Error(`配置错误: ${errors.join(', ')}`);
    }

    return true;
  }

  // 获取B站Cookie
  getCookie() {
    return this.bilibili.cookie;
  }

  // 获取请求头
  getHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': this.bilibili.cookie,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Origin': 'https://www.bilibili.com',
      'Referer': 'https://www.bilibili.com/'
    };
  }
}

module.exports = Config;
