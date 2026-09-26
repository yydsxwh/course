"""
不要对现有生产站运行本脚本。

它会覆盖远端 .env、执行 prisma db push 和 seed，可能清掉业务数据。
线上发布只用 scripts/deploy_safe_update.py。

仓库曾把认证密钥写死在这个文件里。该值视为已经泄露，站长需要在生产密钥管理里轮换 AUTH_SECRET。
轮换会使旧登录会话失效。这里不再保存任何密钥；缺少环境变量时直接失败。
未经授权不要重写 Git 历史。
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    print(
        "refuse: resume_deploy.py rewrites .env and runs seed; use deploy_safe_update.py",
        file=sys.stderr,
    )
    # 即使有人想强制执行，也必须从环境读取，禁止再把密钥写回仓库。
    required = ("AUTH_SECRET", "DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY")
    missing = [name for name in required if not (os.environ.get(name) or "").strip()]
    if missing:
        print(
            "refuse: missing environment variables: " + ", ".join(missing),
            file=sys.stderr,
        )
    if os.environ.get("ALLOW_RESUME_DEPLOY") != "1" or missing:
        return 2
    print(
        "refuse: ALLOW_RESUME_DEPLOY does not re-enable seed or .env overwrite",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
