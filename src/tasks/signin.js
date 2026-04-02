const SigninService = require('../services/signinService');
const Logger = require('../utils/logger');
const Config = require('../utils/config');

async function main() {
  const config = new Config();
  const logger = new Logger(config.logLevel);

  try {
    logger.info('🚀 B站自动签到任务开始');

    const service = new SigninService();
    const result = await service.execute();

    if (result.success) {
      logger.success('✅ 自动签到任务完成');
      
      if (result.skipped) {
        console.log('\n📊 签到结果:');
        console.log('- 状态: 今日已签到，跳过');
      } else {
        console.log('\n📊 签到结果:');
        console.log(`- 状态: 签到成功`);
        console.log(`- 获得经验: ${result.exp}`);
        console.log(`- 当前等级: Lv.${result.level}`);
        console.log(`- 当前经验: ${result.currentExp}`);
        console.log(`- 距离升级: ${result.nextExp - result.currentExp}`);
      }

      // 退出码 0 表示成功
      process.exit(0);
    } else {
      logger.error('❌ 自动签到任务失败');
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
