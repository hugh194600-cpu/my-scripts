const HangupService = require('../services/hangupService');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

async function main() {
  const config = new Config();
  const logger = new Logger(config.logLevel);

  try {
    logger.info('🚀 B站自动挂机修炼任务开始');

    const service = new HangupService();
    const result = await service.execute();

    if (result.success) {
      logger.success('✅ 自动挂机修炼任务完成');
      
      console.log('\n📊 挂机结果:');
      console.log(`- 直播间: ${result.roomTitle}`);
      console.log(`- 主播: ${result.anchorName}`);
      console.log(`- 挂机时长: ${Math.floor(result.actualDuration / 60)} 分钟`);
      console.log(`- 心跳次数: ${result.heartbeatCount}`);
      console.log(`- 当前等级: Lv.${result.level || 'N/A'}`);
      console.log(`- 当前经验: ${result.currentExp || 'N/A'}`);
      
      // 计算修炼效率
      const efficiency = result.heartbeatCount > 0 ? Math.floor(result.actualDuration / result.heartbeatCount) : 0;
      console.log(`- 修炼效率: 每${efficiency}秒一次心跳`);

      // 退出码 0 表示成功
      process.exit(0);
    } else {
      logger.error('❌ 自动挂机修炼任务失败');
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
