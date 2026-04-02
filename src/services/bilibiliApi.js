const axios = require('axios');
const Config = require('../utils/config');
const Logger = require('../utils/logger');

class BilibiliApi {
  constructor() {
    this.config = new Config();
    this.logger = new Logger(this.config.logLevel);

    // 主站client
    this.client = axios.create({
      baseURL: 'https://api.bilibili.com',
      timeout: 15000,
      headers: this.config.getHeaders()
    });

    // 直播站client
    this.liveClient = axios.create({
      baseURL: 'https://api.live.bilibili.com',
      timeout: 15000,
      headers: {
        ...this.config.getHeaders(),
        'Referer': 'https://live.bilibili.com',
        'Origin': 'https://live.bilibili.com',
      }
    });

    this.csrf = this._extractCsrf(this.config.getCookie());
    this.uid  = this._extractUid(this.config.getCookie());
  }

  _extractCsrf(cookie) {
    if (!cookie) return '';
    const match = cookie.match(/bili_jct=([^;]+)/);
    return match ? match[1].trim() : '';
  }

  _extractUid(cookie) {
    if (!cookie) return '';
    const match = cookie.match(/DedeUserID=([^;]+)/);
    return match ? match[1].trim() : '';
  }

  // =====================================================
  // 账号相关
  // =====================================================

  async validateCookie() {
    try {
      this.logger.task('验证Cookie有效性');
      const response = await this.client.get('/x/web-interface/nav');
      if (response.data.code === 0 && response.data.data.isLogin) {
        this.logger.success(`Cookie验证成功，用户: ${response.data.data.uname}`);
        return {
          valid: true,
          uid: response.data.data.mid,
          uname: response.data.data.uname,
          face: response.data.data.face
        };
      }
      this.logger.error('Cookie验证失败，未登录');
      return { valid: false };
    } catch (error) {
      this.logger.error('Cookie验证出错', error.message);
      return { valid: false, error: error.message };
    }
  }

  async getUserInfo() {
    try {
      const response = await this.client.get('/x/web-interface/nav');
      if (response.data.code === 0) return response.data.data;
      return null;
    } catch (error) {
      this.logger.error('获取用户信息失败', error.message);
      return null;
    }
  }

  async getUserExp() {
    try {
      const response = await this.client.get('/x/web-interface/nav');
      if (response.data.code === 0) return response.data.data.level_info;
      return null;
    } catch (error) {
      return null;
    }
  }

  async getCoins() {
    try {
      const response = await this.client.get('/x/web-interface/nav');
      if (response.data.code === 0) return response.data.data.money || 0;
      return 0;
    } catch (error) {
      return 0;
    }
  }

  // =====================================================
  // 每日签到
  // =====================================================

  async getSignStatus() {
    try {
      this.logger.task('获取签到状态');
      const response = await this.client.get('/x/member/web/exp/reward');
      if (response.data.code === 0) {
        const signed = response.data.data.login === true;
        this.logger.info(`今日已签到: ${signed ? '是' : '否'}`);
        return { signed, reward: response.data.data };
      }
      return { signed: false };
    } catch (error) {
      this.logger.error('获取签到状态失败', error.message);
      return { signed: false, error: error.message };
    }
  }

  async doSignin() {
    try {
      this.logger.task('执行每日签到');
      if (!this.csrf) {
        return { success: false, message: 'csrf token缺失，Cookie格式不完整' };
      }

      const response = await this.client.post(
        '/x/member/web/exp/reward',
        `csrf=${this.csrf}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      if (response.data.code === 0) {
        this.logger.success('签到成功！');
        return { success: true, exp: 5, message: '签到成功' };
      } else if (response.data.code === -111) {
        return { success: false, message: 'csrf验证失败' };
      } else if (response.data.code === -101) {
        return { success: false, message: '账号未登录或Cookie过期' };
      } else {
        // 再查一次状态
        const check = await this.getSignStatus();
        if (check.signed) return { success: true, message: '今日已签到', alreadySigned: true };
        return { success: false, message: response.data.message || `code: ${response.data.code}` };
      }
    } catch (error) {
      this.logger.error('签到出错', error.message);
      return { success: false, message: error.message };
    }
  }

  // =====================================================
  // 直播间相关
  // =====================================================

  /**
   * 获取直播间详情（含是否开播）
   */
  async getRoomInfo(roomId) {
    try {
      this.logger.task(`获取直播间信息: ${roomId}`);
      const response = await this.liveClient.get('/xlive/web-room/v1/index/getInfoByRoom', {
        params: { room_id: roomId }
      });
      if (response.data.code === 0 && response.data.data) {
        const ri = response.data.data.room_info;
        const ai = response.data.data.anchor_info;
        const info = {
          roomId: ri.room_id,
          title: ri.title,
          anchorName: ai ? ai.base_info.uname : '未知',
          anchorUid: ri.uid,
          online: ri.online,
          liveStatus: ri.live_status,
          isLive: ri.live_status === 1,
          _raw: response.data.data,
        };
        this.logger.info(`直播间: ${info.title}，开播: ${info.isLive}`);
        return info;
      }
      return null;
    } catch (error) {
      this.logger.error('获取直播间信息失败', error.message);
      return null;
    }
  }

  /**
   * 搜索一个正在直播的直播间（自动切换用）
   */
  async findLiveRoom() {
    this.logger.task('寻找开播中的直播间...');
    try {
      const response = await this.liveClient.get('/xlive/web-interface/v1/second/getList', {
        params: { platform: 'web', parent_area_id: 0, area_id: 0, sort_type: '', page: 1 }
      });
      if (response.data.code === 0 && response.data.data && response.data.data.list) {
        const rooms = response.data.data.list;
        const live = rooms.find(r => r.live_status === 1 || r.online > 0);
        if (live) {
          this.logger.success(`找到开播直播间: ${live.roomid} - ${live.uname}`);
          return { roomId: live.roomid, title: live.title, anchorName: live.uname, isLive: true };
        }
      }
    } catch(e) {}

    // 备用热门列表
    try {
      const response2 = await this.liveClient.get('/xlive/web-interface/v1/index/getList', {
        params: { platform: 'web', page: 1, page_size: 10 }
      });
      if (response2.data.code === 0 && response2.data.data && response2.data.data.list) {
        const r = response2.data.data.list[0];
        if (r) return { roomId: r.roomid, title: r.title, anchorName: r.uname, isLive: true };
      }
    } catch(e) {}

    // 最终备用
    const fallbackRooms = [732, 3, 5441, 1013, 545];
    for (const rid of fallbackRooms) {
      const info = await this.getRoomInfo(rid);
      if (info && info.isLive) return info;
    }
    return null;
  }

  /**
   * 直播签到（每日亲密度/金币）
   */
  async doLiveMedalCheckin() {
    try {
      this.logger.task('执行直播间每日签到');
      const response = await this.liveClient.post(
        '/xlive/web-ucenter/v1/sign/DoSign',
        `csrf=${this.csrf}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (response.data.code === 0) {
        this.logger.success(`直播签到成功: ${JSON.stringify(response.data.data)}`);
        return { success: true, message: `直播签到成功，获得奖励`, data: response.data.data };
      }
      if (response.data.code === 1011040) {
        this.logger.info('今日直播签到已完成');
        return { success: true, message: '今日直播签到已完成', alreadySigned: true };
      }
      return { success: false, message: response.data.message || `直播签到失败 code:${response.data.code}` };
    } catch(error) {
      this.logger.error('直播间签到失败', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 进入直播间（产生进场记录）
   */
  async enterRoom(roomId) {
    try {
      this.logger.task(`进入直播间: ${roomId}`);
      const response = await this.liveClient.post(
        '/xlive/web-room/v1/index/roomEntryAction',
        `room_id=${roomId}&csrf=${this.csrf}&csrf_token=${this.csrf}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (response.data.code === 0) {
        this.logger.success(`进场成功: 直播间 ${roomId}`);
        return { success: true, message: `进场成功` };
      }
      return { success: false, message: response.data.message };
    } catch(error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * 发送直播心跳（修炼/亲密度）
   */
  async sendRoomHeartbeat(roomId) {
    try {
      this.logger.task(`发送心跳: ${roomId}`);
      // 正式心跳
      const response = await this.liveClient.post(
        '/xlive/web-room/v2/index/webHeartBeat',
        `visit_id=&room_id=${roomId}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      if (response.data.code === 0) {
        this.logger.success('心跳发送成功');
        return { success: true, timestamp: new Date().toISOString() };
      }
      // 备用心跳
      const response2 = await this.liveClient.get('/xlive/web-room/v1/index/sendHeartBeat', {
        params: { room_id: roomId, uid: this.uid, csrf: this.csrf }
      });
      return {
        success: response2.data.code === 0,
        message: response2.data.code === 0 ? '心跳成功(备用)' : response2.data.message,
      };
    } catch (error) {
      this.logger.error('发送心跳失败', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 获取粉丝勋章列表
   */
  async getMedalList() {
    try {
      const response = await this.liveClient.get('/xlive/app-ucenter/v1/fansMedal/panel', {
        params: { page: 1, page_size: 50 }
      });
      if (response.data.code === 0 && response.data.data) {
        return (response.data.data.list || []).concat(response.data.data.special_list || []);
      }
      return [];
    } catch(error) {
      return [];
    }
  }
}

module.exports = BilibiliApi;
