#!/usr/bin/env python3
"""把部署备份里的原始优惠券实例写回空的 CouponInstance 表。

只写 CouponCampaign / CouponCampaignProduct / CouponInstance / CouponAuditLog。
不修改 User、Order、Enrollment 或其他业务表。
"""
from __future__ import annotations

import glob
import os
import sqlite3
import sys

COPY_TABLES = (
    "CouponCampaign",
    "CouponCampaignProduct",
    "CouponInstance",
    "CouponAuditLog",
)
DELETE_ORDER = (
    "CouponAuditLog",
    "CouponInstance",
    "CouponCampaignProduct",
    "CouponCampaign",
)
INSERT_ORDER = (
    "CouponCampaign",
    "CouponCampaignProduct",
    "CouponInstance",
    "CouponAuditLog",
)
PREFERRED_BACKUP_NAME = "prod.db.before_restore_20260920202005"
MIN_INSTANCES = 1400


def table_names(con: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }


def table_columns(con: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in con.execute(f'PRAGMA table_info("{table}")')]


def count_rows(con: sqlite3.Connection, table: str) -> int:
    return con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]


def quote_idents(columns: list[str]) -> str:
    return ",".join(f'"{column}"' for column in columns)


def choose_backup(backup_dir: str) -> tuple[str, int]:
    preferred = os.path.join(backup_dir, PREFERRED_BACKUP_NAME)
    candidates: list[tuple[int, str]] = []
    paths = []
    if os.path.isfile(preferred):
        paths.append(preferred)
    paths.extend(sorted(glob.glob(os.path.join(backup_dir, "prod.db*"))))
    seen: set[str] = set()
    for path in paths:
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        bak = sqlite3.connect(path)
        try:
            names = table_names(bak)
            if "CouponInstance" not in names or "CouponCampaign" not in names:
                continue
            count = count_rows(bak, "CouponInstance")
        finally:
            bak.close()
        if count >= MIN_INSTANCES:
            candidates.append((count, path))
            if os.path.basename(path) == PREFERRED_BACKUP_NAME:
                return path, count
    if not candidates:
        raise SystemExit("no backup contains the original coupon instances")
    count, path = max(candidates)
    return path, count


def shared_columns(
    live: sqlite3.Connection, backup: sqlite3.Connection, table: str
) -> list[str]:
    live_cols = table_columns(live, table)
    bak_cols = table_columns(backup, table)
    return [column for column in bak_cols if column in live_cols]


def restore(live_path: str, backup_dir: str) -> None:
    live = sqlite3.connect(live_path)
    try:
        names = table_names(live)
        for table in ("CouponCampaign", "CouponInstance", "User", "Order"):
            if table not in names:
                raise SystemExit(f"missing table {table}")
        users = count_rows(live, "User")
        orders = count_rows(live, "Order")
        account_sub = live.execute(
            "SELECT count(*) FROM User WHERE accountSub IS NOT NULL AND accountSub != ''"
        ).fetchone()[0]
        instances = count_rows(live, "CouponInstance")
        print(
            "BEFORE_RESTORE instances=%s users=%s orders=%s accountSub=%s"
            % (instances, users, orders, account_sub)
        )
        backup_path, backup_count = choose_backup(backup_dir)
        print("RESTORE_SOURCE", backup_path, "count", backup_count)
        if instances == 0:
            copy_coupon_tables(live, backup_path)
        elif instances < MIN_INSTANCES:
            raise SystemExit(
                "coupon instances partially present (%s); refuse to mix with backup"
                % instances
            )
        else:
            print("RESTORE_SKIP existing instances already present")
        restored = count_rows(live, "CouponInstance")
        print("AFTER_RESTORE instances=%s" % restored)
        if restored < MIN_INSTANCES:
            raise SystemExit("coupon instances below %s" % MIN_INSTANCES)
        if count_rows(live, "User") < users:
            raise SystemExit("user count decreased during restore")
        if count_rows(live, "Order") < orders:
            raise SystemExit("order count decreased during restore")
        if (
            live.execute(
                "SELECT count(*) FROM User WHERE accountSub IS NOT NULL AND accountSub != ''"
            ).fetchone()[0]
            < account_sub
        ):
            raise SystemExit("accountSub count decreased during restore")
        assert_original_hashes(live, backup_path)
        assert_legacy_coupons(live)
    finally:
        live.close()


def copy_coupon_tables(live: sqlite3.Connection, backup_path: str) -> None:
    backup = sqlite3.connect(backup_path)
    try:
        bak_names = table_names(backup)
        plan: list[tuple[str, list[str]]] = []
        for table in INSERT_ORDER:
            if table not in bak_names:
                if table in ("CouponCampaign", "CouponInstance"):
                    raise SystemExit("backup missing " + table)
                continue
            columns = shared_columns(live, backup, table)
            if not columns:
                raise SystemExit("no shared columns for " + table)
            if table == "CouponInstance" and "tokenHash" not in columns:
                raise SystemExit("backup instances have no tokenHash column")
            plan.append((table, columns))
    finally:
        backup.close()

    live.execute("PRAGMA foreign_keys=OFF")
    live.execute("ATTACH DATABASE ? AS bak", (backup_path,))
    for table, _columns in plan:
        if table in DELETE_ORDER:
            live.execute(f'DELETE FROM "{table}"')
    for table, columns in plan:
        collist = quote_idents(columns)
        live.execute(
            f'INSERT INTO "{table}" ({collist}) SELECT {collist} FROM bak."{table}"'
        )
    live.commit()
    live.execute("DETACH DATABASE bak")


def assert_original_hashes(live: sqlite3.Connection, backup_path: str) -> None:
    live.execute("ATTACH DATABASE ? AS bak", (backup_path,))
    matched = live.execute(
        "SELECT count(*) FROM CouponInstance AS live_row "
        "JOIN bak.CouponInstance AS bak_row ON live_row.tokenHash = bak_row.tokenHash"
    ).fetchone()[0]
    distinct = live.execute(
        "SELECT count(DISTINCT tokenHash) FROM CouponInstance"
    ).fetchone()[0]
    available = live.execute(
        "SELECT count(*) FROM CouponInstance WHERE status='AVAILABLE'"
    ).fetchone()[0]
    live.execute("DETACH DATABASE bak")
    print(
        "HASH_CHECK matched=%s distinct=%s available=%s" % (matched, distinct, available)
    )
    if matched < MIN_INSTANCES or distinct < MIN_INSTANCES:
        raise SystemExit("original coupon token hashes were not preserved")


def assert_legacy_coupons(live: sqlite3.Connection) -> None:
    missing = live.execute(
        "SELECT legacyCouponId FROM CouponCampaign "
        "WHERE legacyCouponId IS NOT NULL AND legacyCouponId NOT IN (SELECT id FROM Coupon)"
    ).fetchall()
    campaigns = count_rows(live, "CouponCampaign")
    print("CAMPAIGNS", campaigns)
    if campaigns < 1 or missing:
        raise SystemExit("restored campaigns do not match existing coupons")


def main() -> int:
    root = os.environ.get("COURSE_ROOT") or os.getcwd()
    live_path = os.environ.get("COURSE_DB") or os.path.join(root, "prisma", "prod.db")
    backup_dir = os.environ.get("COURSE_BACKUP_DIR") or os.path.join(root, ".deploy_backup")
    restore(live_path, backup_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
