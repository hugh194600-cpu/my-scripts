#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CodeBuddy 自动签到脚本
- 支持多账号
- 异常重试
- 详细日志（使用 print，避免 encoding 问题）
"""

import os
import sys
import time
from typing import List, Dict, Optional
import requests
from requests.adapters import HTTPAdapter
from requests.packages.urllib3.util.retry import Retry

# 强制使用 UTF-8 编码（解决 GitHub Actions 环境编码问题）
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def log_info(msg: str):
    """打印 INFO 日志（避免 logging 模块编码问题）"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"{timestamp} - INFO - {msg}", flush=True)


def log_error(msg: str):
    """打印 ERROR 日志（避免 logging 模块编码问题）"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"{timestamp} - ERROR - {msg}", flush=True)


def log_warning(msg: str):
    """打印 WARNING 日志（避免 logging 模块编码问题）"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"{timestamp} - WARNING - {msg}", flush=True)


# 常量配置
BASE_URL = "https://www.codebuddy.cn"
CHECKIN_URL = f"{BASE_URL}/console/accounts"  # 根据实际签到接口调整
TIMEOUT = 30
MAX_RETRIES = 3


class CodeBuddyCheckin:
    """CodeBuddy 签到类"""

    def __init__(self, cookie: str, user_id: str):
        self.cookie = cookie
        self.user_id = user_id
        self.session = self._create_session()

    def _create_session(self) -> requests.Session:
        """创建带重试机制的 Session"""
        session = requests.Session()

        # 配置重试策略
        retry_strategy = Retry(
            total=MAX_RETRIES,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "POST"]
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("https://", adapter)
        session.mount("http://", adapter)

        # 设置默认请求头
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://www.codebuddy.cn/agents",
            "Cookie": self.cookie,
            "X-User-Id": self.user_id,
        })

        return session

    def checkin(self) -> Dict:
        """
        执行签到
        注意：需要根据实际签到接口调整此方法
        """
        try:
            log_info(f"开始签到... [User: {self.user_id[:8]}...]")

            # 发送请求
            response = self.session.get(
                CHECKIN_URL,
                timeout=TIMEOUT
            )

            # 强制指定编码为 UTF-8（避免 requests 默认使用 latin-1）
            response.encoding = 'utf-8'

            # 检查响应状态
            if response.status_code == 200:
                # 检查是否返回了登录页面（Cookie 失效）
                response_text = response.text
                if '<!DOCTYPE html>' in response_text or 'login' in response_text.lower():
                    log_error("[失败] Cookie 已失效，请重新获取！")
                    return {
                        "success": False,
                        "message": "Cookie 已失效",
                        "data": None
                    }

                result = response.json()
                log_info(f"[成功] 签到成功！响应: {result}")
                return {
                    "success": True,
                    "message": "签到成功",
                    "data": result
                }
            else:
                log_error(f"[失败] 签到失败！状态码: {response.status_code}")
                return {
                    "success": False,
                    "message": f"HTTP {response.status_code}",
                    "data": None
                }

        except requests.exceptions.Timeout:
            log_error("[失败] 请求超时")
            return {"success": False, "message": "请求超时", "data": None}

        except requests.exceptions.RequestException as e:
            # 安全处理错误信息（避免编码问题）
            error_msg = str(e).encode('ascii', 'ignore').decode('ascii')
            log_error(f"[失败] 请求异常: {error_msg}")
            return {"success": False, "message": error_msg, "data": None}

        except Exception as e:
            # 安全处理错误信息（避免编码问题）
            error_msg = str(e).encode('ascii', 'ignore').decode('ascii')
            log_error(f"[失败] 未知错误: {error_msg}")
            return {"success": False, "message": error_msg, "data": None}


def load_accounts_from_env() -> List[Dict[str, str]]:
    """
    从环境变量加载账号信息
    支持单账号和多账号配置

    环境变量格式：
    - 单账号：CODEBUDDY_COOKIE, CODEBUDDY_USER_ID
    - 多账号：CODEBUDDY_ACCOUNTS (JSON 格式)
    """
    accounts = []

    # 尝试读取多账号配置
    multi_accounts = os.getenv("CODEBUDDY_ACCOUNTS")
    if multi_accounts:
        try:
            import json
            accounts = json.loads(multi_accounts)
            log_info(f"已加载 {len(accounts)} 个账号（多账号模式）")
            return accounts
        except json.JSONDecodeError as e:
            log_error(f"多账号配置 JSON 解析失败: {e}")

    # 单账号模式
    cookie = os.getenv("CODEBUDDY_COOKIE")
    user_id = os.getenv("CODEBUDDY_USER_ID")

    if cookie and user_id:
        accounts.append({
            "cookie": cookie,
            "user_id": user_id
        })
        log_info("已加载 1 个账号（单账号模式）")
    else:
        log_warning("未找到账号配置，请检查环境变量")

    return accounts


def main():
    """主函数"""
    log_info("=" * 60)
    log_info("CodeBuddy 自动签到脚本启动")
    log_info("=" * 60)

    # 加载账号
    accounts = load_accounts_from_env()

    if not accounts:
        log_error("❌ 没有找到任何账号配置，退出")
        exit(1)

    # 遍历所有账号执行签到
    results = []
    for idx, account in enumerate(accounts, 1):
        log_info(f"\n{'=' * 60}")
        log_info(f"处理账号 {idx}/{len(accounts)}")
        log_info(f"{'=' * 60}")

        checkin = CodeBuddyCheckin(
            cookie=account["cookie"],
            user_id=account["user_id"]
        )

        result = checkin.checkin()
        results.append(result)

        # 账号之间稍微间隔，避免请求过快
        if idx < len(accounts):
            time.sleep(2)

    # 汇总结果
    log_info(f"\n{'=' * 60}")
    log_info("签到任务完成 - 结果汇总")
    log_info(f"{'=' * 60}")
    success_count = sum(1 for r in results if r["success"])
    log_info(f"总计: {len(results)} 个账号")
    log_info(f"成功: {success_count} 个")
    log_info(f"失败: {len(results) - success_count} 个")

    # 如果有失败，退出码设为 1（便于 GitHub Actions 识别）
    if success_count < len(results):
        exit(1)


if __name__ == "__main__":
    main()
