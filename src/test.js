const BilibiliAutomation = require('./index');
const Logger = require('./utils/logger');
const Config = require('./utils/config');

async function runTests() {
  const config = new Config();
  const logger = new Logger(config.logLevel);

  console.log('🧪 B站自动化工具测试');
  console.log('========================\n');

  // 测试1: 配置验证
  console.log('测试 1/4: 配置验证');
  try {
    config.validate();
    console.log('✅ 配置验证通过\n');
  } catch (error) {
    console.log(`❌ 配置验证失败: ${error.message}\n`);
    console.log('请检查 .env 文件是否配置正确');
    process.exit(1);
  }

  // 测试2: API连接
  console.log('测试 2/4: API连接测试');
  const automation = new BilibiliAutomation();
  
  try {
    const userInfo = await automation.signinService.api.getUserInfo();
    if (userInfo) {
      console.log(`✅ API连接成功`);
      console.log(`   用户: ${userInfo.uname}`);
      console.log(`   UID: ${userInfo.mid}\n`);
    } else {
      console.log('❌ API连接失败\n');
      process.exit(1);
    }
  } catch (error) {
    console.log(`❌ API连接出错: ${error.message}\n`);
    process.exit(1);
  }

  // 测试3: 签到状态
  console.log('测试 3/4: 签到状态查询');
  try {
    const signStatus = await automation.signinService.api.getSignStatus();
    console.log(`✅ 签到状态查询成功`);
    console.log(`   今日已签到: ${signStatus.signed ? '是' : '否'}\n`);
  } catch (error) {
    console.log(`❌ 签到状态查询失败: ${error.message}\n`);
  }

  // 测试4: 直播间信息
  console.log('测试 4/4: 直播间信息查询');
  try {
    const roomInfo = await automation.hangupService.api.getRoomInfo('732');
    if (roomInfo) {
      console.log(`✅ 直播间信息查询成功`);
      console.log(`   标题: ${roomInfo.room_info.title}`);
      console.log(`   主播: ${roomInfo.anchor_info.base_info.uname}`);
      console.log(`   在线: ${roomInfo.room_info.online}人\n`);
    } else {
      console.log('❌ 直播间信息查询失败\n');
    }
  } catch (error) {
    console.log(`❌ 直播间信息查询失败: ${error.message}\n`);
  }

  console.log('========================');
  console.log('🎉 所有测试完成！');
  console.log('\n💡 提示:');
  console.log('- 运行 "npm run signin" 测试签到功能');
  console.log('- 运行 "npm run hangup" 测试挂机功能');
  console.log('- 运行 "npm run pet" 测试宠物成长功能');
  console.log('- 运行 "node src/index.js" 执行所有任务');
}

// 运行测试
runTests().catch(error => {
  console.error('测试出错:', error);
  process.exit(1);
});
