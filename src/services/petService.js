const BilibiliApi = require('./bilibiliApi');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

class PetService {
  constructor() {
    this.api = new BilibiliApi();
    this.config = new Config();
    this.logger = new Logger(this.config.logLevel);
  }

  /**
   * 执行宠物成长任务
   */
  async execute() {
    try {
      this.logger.info('========== 开始执行宠物成长任务 ==========');

      // 验证配置
      this.config.validate();

      // 验证Cookie
      const cookieValid = await this.api.validateCookie();
      if (!cookieValid.valid) {
        throw new Error('Cookie无效，请检查配置');
      }

      // 获取用户信息
      const userInfo = await this.api.getUserInfo();
      if (!userInfo) {
        throw new Error('无法获取用户信息');
      }

      // 获取当前经验值
      const expInfo = await this.api.getUserExp();
      const coins = await this.api.getCoins();

      // 生成宠物信息
      const petInfo = this.generatePetInfo(userInfo, expInfo, coins);

      this.logger.info(`宠物名称: ${petInfo.name}`);
      this.logger.info(`宠物等级: Lv.${petInfo.level}`);
      this.logger.info(`当前经验: ${petInfo.exp}/${petInfo.expToNext}`);
      this.logger.info(`升级进度: ${petInfo.progress}%`);
      this.logger.info(`硬币数量: ${petInfo.coins}`);

      // 计算成长
      const growth = this.calculateGrowth(petInfo);

      if (growth.leveledUp) {
        this.logger.success(`🎉 恭喜！宠物升级了！`);
        this.logger.info(`新等级: Lv.${growth.newLevel}`);
      }

      this.logger.success('宠物成长任务完成！');

      return {
        success: true,
        petInfo,
        growth
      };

    } catch (error) {
      this.logger.error('宠物成长任务失败', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 生成宠物信息
   */
  generatePetInfo(userInfo, expInfo, coins) {
    const baseExp = expInfo?.current_exp || 0;
    const level = expInfo?.current_level || 1;
    const expToNext = expInfo?.next_exp || 1000;

    // 根据经验值计算宠物等级（更精细）
    const petLevel = Math.min(Math.floor(baseExp / 1000) + 1, 50);
    const petExp = baseExp % 1000;
    const petExpToNext = 1000;

    // 计算成长进度
    const progress = ((petExp / petExpToNext) * 100).toFixed(2);

    // 计算心情和饥饿度（模拟）
    const mood = Math.min(100, Math.max(0, 80 + Math.random() * 20 - 10));
    const hunger = Math.min(100, Math.max(0, 90 - (Date.now() % 86400000) / 86400000 * 20));

    return {
      uid: userInfo.mid,
      name: `${userInfo.uname}的宠物`,
      level: petLevel,
      exp: petExp,
      expToNext: petExpToNext,
      progress: parseFloat(progress),
      userLevel: level,
      userExp: baseExp,
      coins: coins || 0,
      mood: Math.floor(mood),
      hunger: Math.floor(hunger),
      lastUpdate: new Date().toISOString(),
      avatar: userInfo.face || 'https://i0.hdslb.com/bfs/archive/default.png'
    };
  }

  /**
   * 计算成长
   */
  calculateGrowth(petInfo) {
    const oldLevel = petInfo.level;
    const newLevel = Math.min(Math.floor(petInfo.userExp / 1000) + 1, 50);
    const leveledUp = newLevel > oldLevel;

    // 计算成长速度
    const expGrowth = petInfo.userExp;
    const levelGrowth = newLevel - oldLevel;

    // 旧版本这里用随机数模拟“修炼加成”，会产生类似 +14 这样的假数据。
    // 当前 B 站接口并没有给出一个可直接读取的单次真元/修炼加成值，所以这里不再伪造。
    const cultivationBonus = null;
    const cultivationBonusNote = '当前本地宠物任务无法从真实接口直接拿到单次真元增量，已移除旧的随机模拟值';

    return {
      leveledUp,
      oldLevel,
      newLevel,
      levelGrowth,
      expGrowth,
      cultivationBonus,
      cultivationBonusNote,
      totalGrowth: expGrowth
    };

  }

  /**
   * 获取宠物状态描述
   */
  getStatusDescription(petInfo) {
    const { mood, hunger, level } = petInfo;

    let status = '';
    let advice = '';

    // 心情状态
    if (mood >= 80) {
      status = '非常开心';
      advice = '宠物状态很好，继续保持！';
    } else if (mood >= 60) {
      status = '开心';
      advice = '宠物状态不错。';
    } else if (mood >= 40) {
      status = '一般';
      advice = '需要更多关注和互动。';
    } else {
      status = '不开心';
      advice = '建议多陪伴宠物！';
    }

    // 饥饿状态
    if (hunger < 30) {
      status += '，饥饿';
      advice = '请及时喂养宠物。';
    } else if (hunger < 50) {
      status += '，有点饿';
      advice = '可以考虑喂养。';
    }

    // 等级评价
    let levelDesc = '';
    if (level >= 30) {
      levelDesc = '传说级宠物';
    } else if (level >= 20) {
      levelDesc = '史诗级宠物';
    } else if (level >= 10) {
      levelDesc = '稀有宠物';
    } else {
      levelDesc = '普通宠物';
    }

    return {
      status,
      advice,
      levelDesc
    };
  }

  /**
   * 模拟喂养宠物
   */
  async feedPet() {
    try {
      this.logger.task('喂养宠物');

      const userInfo = await this.api.getUserInfo();
      const coins = await this.api.getCoins();

      if (coins < 10) {
        this.logger.warn('硬币不足，无法喂养宠物');
        return {
          success: false,
          message: '硬币不足'
        };
      }

      this.logger.success('喂养成功！');
      this.logger.info('宠物心情和饥饿度已恢复');

      return {
        success: true,
        cost: 10,
        remainingCoins: coins - 10
      };

    } catch (error) {
      this.logger.error('喂养失败', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = PetService;
