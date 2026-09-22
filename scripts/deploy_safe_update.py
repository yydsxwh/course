"""
安全增量部署：同步本地代码到阿里云，构建并重启 pm2。
保留远端 .env / 数据库 / public/uploads / node_modules，不执行 seed。
"""
from __future__ import annotations

import os
import sys
import tarfile
import tempfile
import textwrap
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def resolve_host_user() -> tuple[str, str]:
    raw = (os.environ.get("DEPLOY_HOST") or "47.242.157.181").strip()
    if "@" in raw:
        user, host = raw.split("@", 1)
        return host.strip(), user.strip() or "admin"
    return raw, (os.environ.get("DEPLOY_USER") or "admin").strip() or "admin"


HOST, USER = resolve_host_user()
# 默认打当前仓库根；可用 YYDS_LOCAL_PROJECT 覆盖（Windows / Cloud Agent 都能用）
LOCAL_PROJECT = Path(os.environ.get("YYDS_LOCAL_PROJECT") or Path(__file__).resolve().parents[1])
REMOTE_DIR = "/var/www/yyds-course-platform"
REMOTE_TAR = "/tmp/yyds-safe-deploy.tar.gz"
REMOTE_STAGE = "/tmp/yyds-safe-deploy-stage"

EXCLUDE_DIRS = {
    "node_modules",
    ".next",
    ".git",
    "uploads",
    "public/uploads",
    "agent-transcripts",
    "assets",
    ".cursor",
    "tmp",
    # Android / Electron 工程与构建缓存体积大，站点只需 public/app 安装包
    "android",
    "desktop",
    "www",
    "exports",
}
EXCLUDE_FILES = {".env", "dev.db", "dev.db-journal", "prod.db", "prod.db-journal"}


def should_exclude(path: Path) -> bool:
    rel = path.relative_to(LOCAL_PROJECT).as_posix()
    parts = rel.split("/")
    if any(p in EXCLUDE_DIRS for p in parts):
        return True
    if path.name in EXCLUDE_FILES:
        return True
    if path.suffix in {".db", ".db-journal", ".pyc"}:
        return True
    if "__pycache__" in parts:
        return True
    # 本地临时诊断脚本不必上线
    if parts[0] == "scripts" and path.name.startswith("_"):
        return True
    # 安装包走 OSS，且体积上百 MB；打进每次部署包会拖垮上传，
    # 解包失败时 rsync --delete 还会把线上残留清成空目录
    if rel.startswith("public/app/") and path.suffix.lower() in {
        ".apk",
        ".exe",
        ".zip",
    }:
        return True
    # 主题图和封面已在生产机上，每次整包上传会拖垮发布；rsync 同样排除，避免 --delete 删掉。
    if rel.startswith("public/themes/") or rel.startswith("public/covers/"):
        return True
    return False


def make_tarball() -> Path:
    tmp = Path(tempfile.gettempdir()) / "yyds-safe-deploy.tar.gz"
    count = 0
    with tarfile.open(tmp, "w:gz") as tar:
        for root, dirs, files in os.walk(LOCAL_PROJECT):
            root_path = Path(root)
            dirs[:] = [d for d in dirs if not should_exclude(root_path / d)]
            for name in files:
                fp = root_path / name
                if should_exclude(fp):
                    continue
                tar.add(fp, arcname=fp.relative_to(LOCAL_PROJECT).as_posix())
                count += 1
    print(f"Packed {count} files -> {tmp} ({tmp.stat().st_size} bytes)", flush=True)
    return tmp


def load_deploy_key() -> paramiko.PKey:
    """优先用环境变量 DEPLOY_SSH_KEY（可被存成单行 PEM），否则用 ~/.ssh/yyds_aliyun。"""
    raw = (os.environ.get("DEPLOY_SSH_KEY") or "").strip()
    if raw:
        pem = raw.replace("\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
        if pem.count("\n") <= 2:
            import re

            match = re.match(
                r"-{5}BEGIN ([A-Z0-9 ]+)-{5}\s*(.*?)\s*-{5}END \1-{5}",
                pem,
                re.S,
            )
            if not match:
                raise RuntimeError("DEPLOY_SSH_KEY 不是可识别的 PEM")
            kind = match.group(1)
            b64 = "".join(match.group(2).split())
            pem = (
                f"-----BEGIN {kind}-----\n"
                + "\n".join(textwrap.wrap(b64, 64))
                + f"\n-----END {kind}-----\n"
            )
        elif not pem.endswith("\n"):
            pem += "\n"
        tmp = Path(tempfile.gettempdir()) / "yyds-deploy-key.pem"
        tmp.write_text(pem)
        tmp.chmod(0o600)
        for loader in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey):
            try:
                return loader.from_private_key_file(str(tmp))
            except Exception:  # noqa: BLE001
                continue
        raise RuntimeError("DEPLOY_SSH_KEY 无法作为 SSH 私钥加载")
    return paramiko.Ed25519Key.from_private_key_file(_default_key_path())


def _default_key_path() -> str:
    env_tmp = Path(tempfile.gettempdir()) / "yyds-deploy-key.pem"
    if env_tmp.exists():
        return str(env_tmp)
    return str(Path.home() / ".ssh" / "yyds_aliyun")


def connect(retries: int = 8) -> paramiko.SSHClient:
    last: Exception | None = None
    key = load_deploy_key()
    for i in range(retries):
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                HOST,
                username=USER,
                pkey=key,
                look_for_keys=False,
                allow_agent=False,
                timeout=60,
                banner_timeout=90,
                auth_timeout=60,
            )
            # 长传包时防空闲断连
            transport = client.get_transport()
            if transport is not None:
                transport.set_keepalive(30)
            print("SSH_OK", flush=True)
            return client
        except Exception as exc:  # noqa: BLE001
            last = exc
            wait = min(45, 10 * (i + 1))
            print(f"SSH retry {i + 1}/{retries}: {exc}; sleep {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"SSH failed: {last}")


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 1200) -> str:
    print(f"$ {cmd}", flush=True)
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out[-8000:], flush=True)
    if err.strip():
        print(err[-4000:], flush=True)
    if code != 0:
        raise RuntimeError(f"fail {code}: {cmd}\n{err[-2000:]}\n{out[-2000:]}")
    return out


def upload_tarball(client: paramiko.SSHClient, tarball: Path) -> paramiko.SSHClient:
    """优先 paramiko SFTP（带 keepalive）；失败再试系统 scp。校验远端体积。"""
    local_size = tarball.stat().st_size
    key_path = _default_key_path()
    remote_spec = f"{USER}@{HOST}:{REMOTE_TAR}"

    for attempt in range(1, 8):
        print(f"Uploading (attempt {attempt}/7, {local_size} bytes)...", flush=True)
        uploaded = False

        # 1) SFTP：scp 超时后原 SSH 常已死，先确保会话可用再传
        try:
            transport = client.get_transport()
            if transport is None or not transport.is_active():
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass
                client = connect()
            sftp = client.open_sftp()
            try:
                # 大文件分块，进度可见，便于判断是否卡死
                with open(tarball, "rb") as local_f:
                    with sftp.file(REMOTE_TAR, "wb") as remote_f:
                        remote_f.set_pipelined(True)
                        sent = 0
                        chunk = 256 * 1024
                        while True:
                            buf = local_f.read(chunk)
                            if not buf:
                                break
                            remote_f.write(buf)
                            sent += len(buf)
                            if sent == local_size or sent % (2 * 1024 * 1024) < chunk:
                                pct = int(sent * 100 / local_size)
                                print(f"  SFTP {sent}/{local_size} ({pct}%)", flush=True)
            finally:
                sftp.close()
            uploaded = True
            print("SFTP put done", flush=True)
        except Exception as sftp_exc:  # noqa: BLE001
            print(f"SFTP failed: {sftp_exc}; try scp", flush=True)

        if not uploaded:
            try:
                import subprocess

                result = subprocess.run(
                    [
                        "scp",
                        "-i",
                        key_path,
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "StrictHostKeyChecking=accept-new",
                        "-o",
                        "ConnectTimeout=60",
                        "-o",
                        "ServerAliveInterval=20",
                        "-o",
                        "ServerAliveCountMax=30",
                        str(tarball),
                        remote_spec,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=1200,
                )
                if result.returncode != 0:
                    raise RuntimeError(
                        f"scp exit {result.returncode}: {result.stderr[-500:]}"
                    )
                uploaded = True
                # scp 可能拖死旧会话，校验前重连
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass
                client = connect()
            except Exception as scp_exc:  # noqa: BLE001
                print(f"scp failed: {scp_exc}", flush=True)
                time.sleep(min(40, 5 * attempt))
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass
                client = connect()
                continue

        # 校验体积
        try:
            out = run(client, f"stat -c%s {REMOTE_TAR}")
            remote_size = int(out.strip().splitlines()[-1].strip())
        except Exception as exc:  # noqa: BLE001
            print(f"stat remote failed: {exc}; reconnect", flush=True)
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
            client = connect()
            continue

        if remote_size == local_size:
            print(f"Upload done ({remote_size} bytes)", flush=True)
            return client
        print(
            f"Size mismatch local={local_size} remote={remote_size}; retry",
            flush=True,
        )
        time.sleep(min(40, 5 * attempt))
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass
        client = connect()

    raise RuntimeError(f"Upload failed after retries: local={local_size} bytes")


def main() -> int:
    tarball = make_tarball()
    client = connect()
    client = upload_tarball(client, tarball)

    # 解到临时目录，再 rsync 覆盖代码；绝不碰 .env / db / uploads
    run(client, f"rm -rf {REMOTE_STAGE} && mkdir -p {REMOTE_STAGE}")
    run(client, f"tar -xzf {REMOTE_TAR} -C {REMOTE_STAGE}")
    run(
        client,
        "command -v rsync >/dev/null || "
        "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y rsync",
    )
    run(
        client,
        # exclude 的文件 rsync --delete 不会删；比 P 规则稳，避免再把安装包冲掉
        f"rsync -a --delete "
        f"--exclude '.env' "
        f"--exclude 'node_modules' "
        f"--exclude '.next' "
        f"--exclude 'public/uploads' "
        f"--exclude '.deploy_backup' "
        f"--exclude '*.db' "
        f"--exclude '*.db-journal' "
        f"--exclude 'public/products/' "
        f"--exclude 'public/themes/' "
        f"--exclude 'public/covers/' "
        f"--exclude 'capacitor.config.ts' "
        f"--exclude 'docs/' "
        f"--exclude '.github/' "
        f"--exclude 'scripts/_*' "
        f"--exclude 'public/app/*.apk' "
        f"--exclude 'public/app/*.exe' "
        f"--exclude 'public/app/*.zip' "
        f"{REMOTE_STAGE}/ {REMOTE_DIR}/",
    )

    # 依赖可能有变更；不跑 seed，避免清业务数据
    run(client, f"cd {REMOTE_DIR} && npm install", timeout=900)
    run(client, f"cd {REMOTE_DIR} && npx prisma generate")
    # 推 schema 前用 SQLite backup API 做一致性备份；rsync 已排除 *.db。
    run(
        client,
        "python3 - <<'PY'\n"
        "import os, sqlite3, time\n"
        f"root = '{REMOTE_DIR}'\n"
        "os.makedirs(root + '/.deploy_backup', exist_ok=True)\n"
        "src = root + '/prisma/prod.db'\n"
        "dst = root + '/.deploy_backup/prod.db.' + time.strftime('%Y%m%d%H%M%S')\n"
        "src_con = sqlite3.connect(src)\n"
        "dst_con = sqlite3.connect(dst)\n"
        "with dst_con:\n"
        "    src_con.backup(dst_con)\n"
        "dst_con.close()\n"
        "src_con.close()\n"
        "print('BACKUP', dst, os.path.getsize(dst))\n"
        "PY",
        timeout=120,
    )
    # 推 schema 前看差异。出现 DROP 就停，禁止 --accept-data-loss。
    diff_sql = run(
        client,
        f"cd {REMOTE_DIR} && set -a && . ./.env && set +a && "
        f"npx --no-install prisma migrate diff "
        f"--from-url 'file:{REMOTE_DIR}/prisma/prod.db' "
        f"--to-schema-datamodel prisma/schema.prisma --script",
        timeout=180,
    )
    # SQLite 加外键时会整表重建：先 INSERT 进 new_* 再 DROP。那是拷贝，不是丢数据。
    # 真正的删列会在 diff 里写 “will be lost” / DROP COLUMN，这里才中止。
    import re

    lowered = diff_sql.lower()
    if "will be lost" in lowered or "drop the column" in lowered:
        raise RuntimeError("schema diff would drop production columns:\n" + diff_sql[-2000:])
    destructive = [
        line.strip()
        for line in diff_sql.splitlines()
        if " DROP COLUMN" in line.upper()
        or line.strip().upper().startswith("DROP COLUMN")
        or ("ALTER TABLE" in line.upper() and " DROP " in line.upper())
    ]
    for table in re.findall(r'DROP TABLE "([^"]+)"', diff_sql):
        copied = (
            f'CREATE TABLE "new_{table}"' in diff_sql
            and f'INSERT INTO "new_{table}"' in diff_sql
            and f'FROM "{table}"' in diff_sql
        )
        if not copied:
            destructive.append(f'DROP TABLE "{table}"')
    if destructive:
        raise RuntimeError(
            "schema diff would drop production data:\n" + "\n".join(destructive[:40])
        )
    print("SCHEMA_DIFF_OK", flush=True)
    # 只做增量扩表/加列。禁止 --accept-data-loss，避免删掉生产库多出来的列。
    run(client, f"cd {REMOTE_DIR} && npx --no-install prisma db push")
    # 若实例表是空的，从含 1400 张券的部署备份写回原实例，避免迁移脚本重铸 token。
    run(
        client,
        f"cd {REMOTE_DIR} && python3 scripts/restore_coupon_instances.py",
        timeout=120,
    )
    # 旧公共券码 → 活动+独立实例（幂等，不删订单/核销历史）。不改 AUTH_SECRET / 不写 COUPON_TOKEN_KEY。
    migrate_out = run(
        client,
        f"cd {REMOTE_DIR} && set -a && . ./.env && set +a && npm run db:migrate-coupons",
        timeout=600,
    )
    if "newCampaigns=0" not in migrate_out or "newInstances=0" not in migrate_out:
        raise RuntimeError(
            "coupon migration was not idempotent after restoring original instances:\n"
            + migrate_out[-2000:]
        )
    run(
        client,
        f"python3 - <<'PY'\n"
        "import sqlite3\n"
        f"con = sqlite3.connect('{REMOTE_DIR}/prisma/prod.db')\n"
        "cur = con.cursor()\n"
        "tables = {r[0] for r in cur.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}\n"
        "need = ['CouponCampaign','CouponInstance','CouponAuditLog']\n"
        "missing = [t for t in need if t not in tables]\n"
        "if missing:\n"
        "    raise SystemExit('missing tables: ' + ','.join(missing))\n"
        "n_user = cur.execute('SELECT count(*) FROM User').fetchone()[0]\n"
        "n_order = cur.execute('SELECT count(*) FROM \"Order\"').fetchone()[0]\n"
        "n_coupon = cur.execute('SELECT count(*) FROM Coupon').fetchone()[0]\n"
        "n_camp = cur.execute('SELECT count(*) FROM CouponCampaign').fetchone()[0]\n"
        "n_inst = cur.execute('SELECT count(*) FROM CouponInstance').fetchone()[0]\n"
        "n_avail = cur.execute(\"SELECT count(*) FROM CouponInstance WHERE status='AVAILABLE'\").fetchone()[0]\n"
        "print(f'DB_OK users={n_user} orders={n_order} coupons={n_coupon} campaigns={n_camp} instances={n_inst} available={n_avail}')\n"
        "if n_user < 1 or n_coupon < 1 or n_camp < 1 or n_inst != 1400 or n_avail != 1400:\n"
        "    raise SystemExit('production coupon instances are not the original 1400; abort')\n"
        "import glob, os\n"
        f"backups = sorted(glob.glob('{REMOTE_DIR}/.deploy_backup/prod.db.*'), key=os.path.getmtime)\n"
        "pre = None\n"
        "for path in reversed(backups):\n"
        "    bak = sqlite3.connect(path)\n"
        "    names = {r[0] for r in bak.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}\n"
        "    if 'CouponInstance' not in names and 'Order' in names:\n"
        "        pre = bak\n"
        "        print('COMPARE_BACKUP', os.path.basename(path))\n"
        "        break\n"
        "    bak.close()\n"
        "if pre is None:\n"
        "    raise SystemExit('no pre-push backup to compare orders against')\n"
        "pre_users = pre.execute('SELECT count(*) FROM User').fetchone()[0]\n"
        "pre_orders = pre.execute('SELECT count(*) FROM \"Order\"').fetchone()[0]\n"
        "pre_nos = {r[0] for r in pre.execute('SELECT orderNo FROM \"Order\"')}\n"
        "live_nos = {r[0] for r in cur.execute('SELECT orderNo FROM \"Order\"')}\n"
        "missing_orders = sorted(pre_nos - live_nos)\n"
        "pre.close()\n"
        "if n_user < pre_users or n_order < pre_orders or missing_orders:\n"
        "    raise SystemExit('users or orders were lost; missing=' + ','.join(missing_orders[:10]))\n"
        "con.close()\n"
        "PY",
    )
    # 清 lock / 残留 .next，避免并发或半成品导致 pages-manifest ENOENT
    # 用 [n]ext 避免 pkill -f 误匹配当前 SSH 命令行把自己杀掉
    run(
        client,
        f"rm -f {REMOTE_DIR}/.next/lock; "
        "pids=$(pgrep -f '[n]ext build' || true); "
        "if [ -n \"$pids\" ]; then kill $pids || true; fi; "
        f"sleep 1; rm -rf {REMOTE_DIR}/.next",
    )
    run(client, f"cd {REMOTE_DIR} && npm run build", timeout=1200)
    # 用 if/else，避免 || 与 && 连用导致 restart 成功后又多起一个进程
    run(
        client,
        "if pm2 describe yyds-course >/dev/null 2>&1; then "
        "pm2 restart yyds-course --update-env; "
        "else "
        f"cd {REMOTE_DIR} && pm2 start npm --name yyds-course -- start -- -p 3000; "
        "fi",
    )
    run(client, "pm2 save")
    run(client, "pm2 status")
    run(
        client,
        "sleep 4; "
        "curl -s -o /dev/null -w 'local:%{http_code}\\n' http://127.0.0.1:3000/; "
        "curl -s -o /dev/null -w 'site:%{http_code}\\n' -m 15 https://www.yydsxwh.com/; "
        f"grep -n '横屏全屏\\|learn-landscape-fs\\|learn-fs-enter' "
        f"{REMOTE_DIR}/packages/courses/components/learn-player.tsx "
        f"{REMOTE_DIR}/src/app/globals.css | head -20",
    )
    print("DEPLOY_OK", flush=True)
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
