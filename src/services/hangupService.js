const BilibiliApi = require('./bilibiliApi');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

class HangupService {
  constructor() {
    this.api = new BilibiliApi();
    this.config = new Config();
    this.logger = new Logger(this.config.logLevel);
  }

  /**
   * 执行完整挂机任务（每次调用=一轮）：
   * 1. 检测目标直播间是否开播
   * 2. 关播则自动切换到开播的直播间
   * 3. 执行直播间每日签到（领金币/亲密度）
   * 4. 进场 + 发心跳（修炼）
   */
  async execute() {
    try {
      this.logger.info('========== 开始执行挂机修炼任务 ==========');

      // 验证Cookie
      const cookieValid = await this.api.validateCookie();
      if (!cookieValid.valid) {
        throw new Error('Cookie无效，请检查配置');
      }

      const preferRoomId = this.config.hangup.roomId;
      this.logger.info(`目标直播间: ${preferRoomId}`);

      // Step1: 检测目标直播间开播状态
      let roomInfo = await this.api.getRoomInfo(preferRoomId);
      let switched = false;
      let switchedFrom = null;

      if (!roomInfo || !roomInfo.isLive) {
        this.logger.warn(`直播间 ${preferRoomId} 未开播（状态: ${roomInfo ? roomInfo.liveStatus : '获取失败'}），自动寻找开播直播间...`);
        const liveRoom = await this.api.findLiveRoom();

        if (liveRoom) {
          switched = true;
          switchedFrom = preferRoomId;
          roomInfo = liveRoom;
          this.logger.success(`已切换到直播间 ${liveRoom.roomId}（${liveRoom.title || ''}）`);
        } else {
          this.logger.warn('所有直播间均未开播，跳过本次挂机');
          return {
            success: false,
            message: '所有直播间均未开播',
            skipped: true,
          };
        }
      }

      const activeRoomId = roomInfo.roomId || preferRoomId;
      this.logger.info(`当前直播间: ${activeRoomId} - ${roomInfo.title || ''} (${roomInfo.anchorName || ''})`);

      // Step2: 直播间每日签到（领金币/亲密度）
      this.logger.info('--- 执行直播间签到 ---');
      const checkin = await this.api.doLiveMedalCheckin();
      this.logger.info(`直播签到结果: ${checkin.message}`);

      // Step3: 进入直播间
      this.logger.info('--- 进入直播间 ---');
      const enter = await this.api.enterRoom(activeRoomId);
      this.logger.info(`进场结果: ${enter.message}`);

      // Step4: 发送心跳（修炼）
      this.logger.info('--- 发送心跳修炼 ---');
      const heartbeat = await this.api.sendRoomHeartbeat(activeRoomId);
      this.logger.info(`心跳结果: ${heartbeat.message || (heartbeat.success ? '成功' : '失败')}`);

      this.logger.success('挂机修炼完成！');

      return {
        success: true,
        roomId: activeRoomId,
        roomTitle: roomInfo.title || '',
        anchorName: roomInfo.anchorName || '',
        switched,
        switchedFrom,
        checkin: checkin.message,
        heartbeat: heartbeat.success,
        message: switched
          ? `直播间已切换 ${switchedFrom}→${activeRoomId}，签到+心跳完成`
          : `直播间 ${activeRoomId} 签到+心跳完成`,
      };

    } catch (error) {
      this.logger.error('挂机修炼任务失败', error.message);
      return {
        success: false,
        error: error.message,
        message: `挂机失败: ${error.message}`,
      };
    }
  }
}

module.exports = HangupService;
