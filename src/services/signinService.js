const BilibiliApi = require('./bilibiliApi');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

class SigninService {
  constructor() {
    this.api = new BilibiliApi();
    this.config = new Config();
    this.logger = new Logger(this.config.logLevel);
  }

  /**
   * 执行每日签到任务
   */
  async execute() {
    try {
      this.logger.info('========== 开始执行每日签到任务 ==========');

      // 验证配置
      this.config.validate();

      // 验证Cookie
      const cookieValid = await this.api.validateCookie();
      if (!cookieValid.valid) {
        throw new Error('Cookie无效，请检查配置');
      }

      // 检查今日是否已签到
      this.logger.waiting('检查今日签到状态...');
      const signStatus = await this.api.getSignStatus();
      
      if (signStatus.signed) {
        this.logger.warn('今日已签到，跳过签到任务');
        return {
          success: true,
          skipped: true,
          message: '今日已签到'
        };
      }

      // 执行签到
      this.logger.task('执行签到...');
      const result = await this.api.doSignin();

      if (result.success) {
        this.logger.success(`签到完成，获得 ${result.exp} 经验值`);
        
        // 获取更新后的经验值
        const expInfo = await this.api.getUserExp();
        if (expInfo) {
          this.logger.info(`当前等级: Lv.${expInfo.current_level}`);
          this.logger.info(`当前经验: ${expInfo.current_exp}`);
          this.logger.info(`距离升级还需: ${expInfo.next_exp - expInfo.current_exp} 经验`);
        }

        return {
          success: true,
          exp: result.exp,
          level: expInfo?.current_level,
          currentExp: expInfo?.current_exp,
          nextExp: expInfo?.next_exp
        };
      } else {
        throw new Error(result.message || '签到失败');
      }

    } catch (error) {
      this.logger.error('签到任务失败', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 获取签到统计信息
   */
  async getStats() {
    try {
      const userInfo = await this.api.getUserInfo();
      const expInfo = await this.api.getUserExp();
      
      return {
        uid: userInfo?.mid,
        uname: userInfo?.uname,
        level: expInfo?.current_level,
        currentExp: expInfo?.current_exp,
        nextExp: expInfo?.next_exp,
        progress: expInfo ? ((expInfo.current_exp / expInfo.next_exp) * 100).toFixed(2) : 0
      };
    } catch (error) {
      this.logger.error('获取统计信息失败', error.message);
      return null;
    }
  }
}

module.exports = SigninService;
