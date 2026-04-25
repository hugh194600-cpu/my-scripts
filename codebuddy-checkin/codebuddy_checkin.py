#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CodeBuddy 自动签到脚本
- 支持多账号
- 异常重试
- 详细日志（使用 ASCII 安全输出，避免 encoding 问题）
"""

import os
import sys
import time
from typing import List, Dict, Optional
import requests
from requests.adapters import HTTPAdapter
from requests.packages.urllib3.util.retry import Retry

# 强制使用 UTF-8 编码（解决 GitHub Actions 环境编码问题）
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except:
    pass

# 设置环境变量（双重保险）
os.environ['PYTHONIOENCODING'] = 'utf-8'


def safe_ascii(msg) -> str:
    """将任意对象转换为 ASCII 安全字符串（使用 repr，自动转义非 ASCII 字符）"""
    try:
        return repr(msg)
    except:
        try:
            return str(msg).encode('ascii', 'ignore').decode('ascii')
        except:
            return '<unprintable>'


def log_info(msg):
    """打印 INFO 日志"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    output = f"{timestamp} - INFO - {safe_ascii(msg)}\n"
    sys.stdout.write(output)
    sys.stdout.flush()


def log_error(msg):
    """打印 ERROR 日志"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    output = f"{timestamp} - ERROR - {safe_ascii(msg)}\n"
    sys.stderr.write(output)
    sys.stderr.flush()


def log_warning(msg):
    """打印 WARNING 日志"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    output = f"{timestamp} - WARNING - {safe_ascii(msg)}\n"
    sys.stdout.write(output)
    sys.stdout.flush()


# 常量配置
BASE_URL = "https://www.codebuddy.cn"
CHECKIN_URL = f"{BASE_URL}/console/accounts"  # 根据实际签到接口调整
TIMEOUT = 30
MAX_RETRIES = 3


class CodeBuddyCheckin:
    """CodeBuddy 签到类"""

    def __init__(self, cookie: str, user_id: str):
        self.cookie = cookie
        # 去除可能的 BOM 字符（\ufeff 等）
        self.user_id = user_id.strip().replace('\ufeff', '').replace('\ufffe', '')
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

        # 设置默认请求头（Cookie 可能包含非 ASCII 字符，使用 ASCII 安全方式）
        cookie_safe = safe_ascii(self.cookie)
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://www.codebuddy.cn/agents",
            "Cookie": self.cookie,  # 保留原始 Cookie，requests 会处理编码
            "X-User-Id": self.user_id,
        })

        return session

    def checkin(self) -> Dict:
        """
        执行签到
        注意：需要根据实际签到接口调整此方法
        """
        try:
            log_info(f"Start checkin... [User: {self.user_id[:8]}...]")

            # 发送请求
            log_info(f"Request URL: {CHECKIN_URL}")
            response = self.session.get(
                CHECKIN_URL,
                timeout=TIMEOUT
            )
            log_info(f"Response status: {response.status_code}")

            # 强制指定编码为 UTF-8（避免 requests 默认使用 latin-1）
            response.encoding = 'utf-8'

            # 检查响应状态
            if response.status_code == 200:
                # 检查是否返回了登录页面（Cookie 失效）
                response_text = response.text
                if '<!DOCTYPE html>' in response_text or 'login' in response_text.lower():
                    log_error("Failed: Cookie expired, please update!")
                    return {
                        "success": False,
                        "message": "Cookie expired",
                        "data": None
                    }

                # 尝试解析 JSON
                try:
                    result = response.json()
                    log_info(f"Success: checkin successful! Response: {safe_ascii(result)}")
                    return {
                        "success": True,
                        "message": "checkin successful",
                        "data": result
                    }
                except ValueError as json_err:
                    # JSON 解析失败，记录响应内容前 500 字符
                    log_error(f"Failed: Invalid JSON response: {safe_ascii(json_err)}")
                    log_error(f"Failed: Response content: {safe_ascii(response.text[:500])}")
                    return {
                        "success": False,
                        "message": "Invalid JSON response",
                        "data": None
                    }
            else:
                log_error(f"Failed: HTTP {response.status_code}, Response: {safe_ascii(response.text[:200])}")
                return {
                    "success": False,
                    "message": f"HTTP {response.status_code}",
                    "data": None
                }

        except requests.exceptions.Timeout:
            log_error("Failed: Request timeout")
            return {"success": False, "message": "Request timeout", "data": None}

        except requests.exceptions.RequestException as e:
            # 安全处理错误信息（避免编码问题）
            log_error(f"Failed: Request exception: {safe_ascii(e)}")
            return {"success": False, "message": safe_ascii(e), "data": None}

        except Exception as e:
            # 安全处理错误信息（避免编码问题）
            log_error(f"Failed: Unknown error: {safe_ascii(e)}")
            return {"success": False, "message": safe_ascii(e), "data": None}


def load_accounts_from_env() -> List[Dict[str, str]]:
    """
    从环境变量加载账号信息
    支持单账号和多账号配置
    """
    accounts = []

    # 尝试读取多账号配置
    multi_accounts = os.getenv("CODEBUDDY_ACCOUNTS")
    if multi_accounts:
        try:
            import json
            accounts = json.loads(multi_accounts)
            log_info(f"Loaded {len(accounts)} accounts (multi-account mode)")
            return accounts
        except json.JSONDecodeError as e:
            log_error(f"Multi-account config JSON parse failed: {safe_ascii(e)}")

    # 单账号模式
    cookie = os.getenv("CODEBUDDY_COOKIE")
    user_id = os.getenv("CODEBUDDY_USER_ID")

    if cookie and user_id:
        accounts.append({
            "cookie": cookie,
            "user_id": user_id
        })
        log_info("Loaded 1 account (single-account mode)")
    else:
        log_warning("No account config found, please check environment variables")

    return accounts


def main():
    """主函数"""
    log_info("=" * 60)
    log_info("CodeBuddy Auto Checkin Script Started")
    log_info("=" * 60)

    # 加载账号
    accounts = load_accounts_from_env()

    if not accounts:
        log_error("No account config found, exit")
        exit(1)

    # 遍历所有账号执行签到
    results = []
    for idx, account in enumerate(accounts, 1):
        log_info("")
        log_info("=" * 60)
        log_info(f"Processing account {idx}/{len(accounts)}")
        log_info("=" * 60)

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
    log_info("")
    log_info("=" * 60)
    log_info("Checkin Task Completed - Summary")
    log_info("=" * 60)
    success_count = sum(1 for r in results if r["success"])
    log_info(f"Total: {len(results)} accounts")
    log_info(f"Success: {success_count}")
    log_info(f"Failed: {len(results) - success_count}")

    # 如果有失败，退出码设为 1（便于 GitHub Actions 识别）
    if success_count < len(results):
        exit(1)


if __name__ == "__main__":
    main()
