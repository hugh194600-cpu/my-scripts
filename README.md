# B站自动化工具 🚀

[![B站弹幕宠物挂机](https://github.com/hugh194600-cpu/my-scripts/actions/workflows/hangup.yml/badge.svg)](https://github.com/hugh194600-cpu/my-scripts/actions/workflows/hangup.yml)
[![边界AI签到](https://github.com/hugh194600-cpu/my-scripts/actions/workflows/yyai_signin.yml/badge.svg)](https://github.com/hugh194600-cpu/my-scripts/actions/workflows/yyai_signin.yml)

基于 **GitHub Actions** 的自动化工具，当前仅保留已实测有效的两条链路：**B站弹幕宠物挂机修炼** 与 **边界AI签到**。

## ✨ 功能

| 工作流 | 触发时间 | 功能 |
|--------|---------|------|
| 弹幕宠物挂机修炼 | 每 10 分钟 | 扫描开播的弹幕宠物直播间，发修炼指令，校验经验增量，满经验自动突破 |
| 边界AI签到 | 每天 08:05 / 10:05（北京时间） | yyai8.com 每日签到，token 失效时发邮件通知 |

## 🚀 快速部署

### 第一步：Fork 本仓库

点击右上角 **Fork**，复制到你自己的 GitHub 账号。

### 第二步：配置 GitHub Secrets

进入你 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

**B站相关（必填）：**

| Secret 名称 | 说明 |
|------------|------|
| `BILIBILI_COOKIE` | B站登录 Cookie（从浏览器 F12 → Network → 任意 B 站请求的 Cookie 头复制） |
| `BILIBILI_UID` | B站用户 UID（个人主页 URL 里的数字） |

**挂机相关（可选但推荐）：**

| Secret 名称 | 说明 | 默认值 |
|------------|------|-------|
| `PET_PRIORITY_ROOMS` | 历史确认打出过 +19 的优先房间号，逗号分隔 | `1788399444` |
| `HANGUP_ROOM_ID` | 备选挂机房间 | `1788399444` |
| `RANDOM_ROOMS` | 随机心跳直播间列表，逗号分隔 | `732,6,1,76,488,21452505` |

**邮件通知（可选但推荐）：**

| Secret 名称 | 说明 |
|------------|------|
| `QQ_MAIL_USER` | QQ 邮箱地址 |
| `QQ_MAIL_PASS` | QQ 邮箱授权码（不是登录密码，在 QQ 邮箱设置 → SMTP 里生成） |

**边界AI相关（仅使用边界AI签到时需要）：**

| Secret 名称 | 说明 |
|------------|------|
| `YYAI_TOKEN` | 边界AI短 token（yyai8.com F12 → Network → 签到请求 Headers 里） |
| `YYAI_ACCESS_TOKEN` | 边界AI access-token（同上） |
| `YYAI_UID` | 边界AI uid（同上） |

### 第三步：手动触发测试

1. 进入 **Actions** 标签页
2. 左侧选择 **B站弹幕宠物挂机修炼**
3. 点击 **Run workflow** → **Run workflow**
4. 等待完成后查看日志，重点确认经验增量是否达到有效修炼档位
5. 如需验证边界AI，再单独手动触发 **边界AI每日签到**

## 🔧 挂机修炼说明

- 每 10 分钟执行一次，自动扫描已开播且开启弹幕宠物的直播间
- 优先检查 `PET_PRIORITY_ROOMS` 配置的房间，再自动扫描
- 触发修炼顺序：**宠物面板「修仙」 → 直播弹幕「修炼」 → 直播弹幕「修仙」**
- 触发后先做一次 12 秒复查；若经验仍像 `+14` 基础收益或出现 `+28 / +42` 这类 `+14` 倍数，再自动补做第二次 12 秒复查，排除经验显示滞后
- 两轮复查后，只有累计增量达到有效修炼档位且**不是 `+14` 的倍数**，才算确认修炼成功
- 若经验已满，优先通过宠物面板发送「突破」，失败时回退到直播弹幕「突破」
- 单次最多尝试 3 个候选直播间

## ⚙️ 本地运行

```bash
git clone https://github.com/hugh194600-cpu/my-scripts.git
cd my-scripts
npm install
cp .env.example .env
# 编辑 .env 填入 BILIBILI_COOKIE 等配置
node src/index.js
```

## ⚠️ 注意事项

- **Cookie 有效期**：B站 Cookie 通常数月有效，但登出或修改密码后会立即失效；失效后程序会发邮件通知
- **GitHub Actions 免费额度**：公开仓库完全免费，无分钟限制；私有仓库每月有 2000 分钟免费额度
- **挂机频率**：每 10 分钟一次，每次运行约 1-2 分钟，私有仓库用量极低
- 本项目仅供学习研究，请遵守 B 站用户协议，风险自负

## 📝 更新日志

### v2.0.0 (2026-04-02)
- ✅ 从腾讯云 SCF 全面迁移到 GitHub Actions（完全免费）
- ✅ 仅保留已实测有效的两条工作流：弹幕宠物挂机修炼 + 边界AI签到
- ✅ 修炼触发链路：宠物面板 + 直播弹幕双重保障
- ✅ 支持最多两轮 12 秒增量复查，避开 `+14` 倍数导致的经验显示滞后误判
- ✅ 满经验自动突破（面板优先，弹幕兜底）
- ✅ 返回值内置触发顺序 / 实际执行路径 / 突破链路可见

### v1.0.0 (2026-03-24)
- ✅ 初始版本：自动化任务 + 挂机修炼 + GitHub Actions 集成
