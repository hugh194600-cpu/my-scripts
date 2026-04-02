const PetService = require('../services/petService');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

async function main() {
  const config = new Config();
  const logger = new Logger(config.logLevel);

  try {
    logger.info('🚀 B站宠物成长任务开始');

    const service = new PetService();
    const result = await service.execute();

    if (result.success) {
      logger.success('✅ 宠物成长任务完成');
      
      console.log('\n📊 宠物成长结果:');
      console.log(`- 宠物名称: ${result.petInfo.name}`);
      console.log(`- 宠物等级: Lv.${result.petInfo.level}`);
      console.log(`- 当前经验: ${result.petInfo.exp}/${result.petInfo.expToNext}`);
      console.log(`- 升级进度: ${result.petInfo.progress}%`);
      console.log(`- 硬币数量: ${result.petInfo.coins}`);
      console.log(`- 心情值: ${result.petInfo.mood}/100`);
      console.log(`- 饥饿度: ${result.petInfo.hunger}/100`);
      
      // 成长信息
      if (result.growth.leveledUp) {
        console.log('\n🎉 成长信息:');
        console.log(`- 升级: Lv.${result.growth.oldLevel} → Lv.${result.growth.newLevel}`);
      }
      
      if (typeof result.growth.cultivationBonus === 'number') {
        console.log(`- 修炼加成: +${result.growth.cultivationBonus} 经验`);
      } else {
        console.log(`- 真元/修炼加成: ${result.growth.cultivationBonusNote}`);
      }
      console.log(`- 总成长值: ${result.growth.totalGrowth}`);

      
      // 状态描述
      const status = service.getStatusDescription(result.petInfo);
      console.log(`\n🎯 宠物状态: ${status.status}`);
      console.log(`💡 建议: ${status.advice}`);
      console.log(`🏆 称号: ${status.levelDesc}`);

      // 退出码 0 表示成功
      process.exit(0);
    } else {
      logger.error('❌ 宠物成长任务失败');
      console.log(`\n错误信息: ${result.error}`);
      
      // 退出码 1 表示失败
      process.exit(1);
    }

  } catch (error) {
    logger.error('❌ 任务执行出错', error.message);
    console.log(`\n错误信息: ${error.message}`);
    process.exit(1);
  }
}

// 执行主函数
main().catch(error => {
  console.error('未捕获的错误:', error);
  process.exit(1);
});
