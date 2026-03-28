# B站自动化工具 v2.0

自动完成B站每日任务，获取经验值。

## 功能

- ✅ **每日签到** - 每天自动签到 +5经验
- ✅ **直播挂机** - 在直播间挂机修炼
- ✅ **宠物成长** - 记录每日宠物成长

## 配置 GitHub Secrets

进入仓库 → Settings → Secrets and variables → Actions → New repository secret

| Secret名称 | 说明 | 必填 |
|-----------|------|------|
| `BILIBILI_COOKIE` | B站登录Cookie（必须包含SESSDATA和bili_jct） | ✅ |
| `BILIBILI_UID` | 你的B站UID（数字） | 可选 |
| `HANGUP_ROOM_ID` | 挂机直播间ID（默认732） | 可选 |
| `HANGUP_DURATION` | 挂机时长秒数（默认3600） | 可选 |
| `PET_NAME` | 宠物名称（默认：我的弹幕宠物） | 可选 |

## 获取 Cookie

1. 打开浏览器，登录 [bilibili.com](https://www.bilibili.com)
2. 按 F12 打开开发者工具
3. 点击 Application → Cookies → https://www.bilibili.com
4. 复制以下字段，格式：`SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx`

**必须包含的字段：**
- `SESSDATA` - 登录凭证
- `bili_jct` - CSRF Token（签到必须）
- `DedeUserID` - 你的UID

## 执行时间（北京时间）

| 任务 | 时间 |
|------|------|
| 签到 | 每天 16:00 |
| 挂机 | 每天 08:00, 14:00, 20:00, 02:00 |
| 宠物 | 每天 08:00, 20:00 |

## 手动触发

进入 Actions → 选择工作流 → Run workflow

## 注意事项

- Cookie 有效期约1-3个月，过期需重新获取
- 每月2000分钟免费额度（本项目完全够用）
