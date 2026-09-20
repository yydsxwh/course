"use client";

import { useEffect, useState } from "react";
import { formatCouponBenefit } from "@andyyyds/shared/coupons";
import { formatPrice } from "@andyyyds/shared/utils";

type InstanceRow = {
  id: string;
  serialNo: string;
  tokenHint: string;
  status: string;
  claimedByUserId: string | null;
  claimedBy: { id: string; name: string; email: string; phone: string } | null;
  claimedAt: string | null;
  redeemedAt: string | null;
  redeemedOrderId: string | null;
  reservedOrderId: string | null;
  orders: Array<{ id: string; orderNo: string; status: string; courseId: string }>;
};

type Stats = {
  generated: number;
  available: number;
  claimed: number;
  redeemed: number;
  expired: number;
  disabled: number;
};

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "未领取",
  CLAIMED: "已领取未使用",
  RESERVED: "下单预占",
  REDEEMED: "已核销",
  EXPIRED: "已过期",
  DISABLED: "已停用",
};

type Props = {
  campaignId: string;
  name: string;
  description: string;
  code: string;
  type: string;
  discountCents: number;
  percentOff: number;
  minAmount: number;
  maxPerUser: number;
  issueCount: number;
  productScope: string;
  products: Array<{ id: string; title: string }>;
  startsAt: string | null;
  expiresAt: string | null;
  stats: Stats;
};

export function CouponCampaignDetail(props: Props) {
  const [rows, setRows] = useState<InstanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [userQ, setUserQ] = useState("");
  const [orderQ, setOrderQ] = useState("");
  const [issueCount, setIssueCount] = useState(String(props.issueCount));
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const reloadKey = `${status}|${userQ}|${orderQ}|${props.campaignId}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (userQ.trim()) qs.set("user", userQ.trim());
      if (orderQ.trim()) qs.set("order", orderQ.trim());
      qs.set("take", "200");
      const res = await fetch(
        `/api/studio/coupons/${props.campaignId}/instances?${qs.toString()}`,
      );
      if (!res.ok || cancelled) return;
      const data = await res.json();
      if (cancelled) return;
      setRows(data.instances || []);
      setTotal(data.total || 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, orderQ, props.campaignId, status, userQ]);

  async function copyLink(id: string) {
    setBusy(id);
    setNotice("");
    const res = await fetch(
      `/api/studio/coupons/${props.campaignId}/instances/${id}/link`,
    );
    const data = await res.json();
    setBusy("");
    if (!res.ok) {
      setNotice(data.error || "复制失败");
      return;
    }
    try {
      await navigator.clipboard.writeText(data.url);
      setNotice(`已复制 ${data.serialNo} 的领取链接`);
    } catch {
      setNotice(data.url);
    }
  }

  async function disableOne(id: string) {
    if (!confirm("停用这张尚未领取的券？")) return;
    setBusy(`d-${id}`);
    const res = await fetch(
      `/api/studio/coupons/${props.campaignId}/instances/${id}/disable`,
      { method: "POST" },
    );
    setBusy("");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNotice(data.error || "停用失败");
      return;
    }
    window.location.reload();
  }

  async function resize() {
    setBusy("resize");
    setNotice("");
    const res = await fetch(`/api/studio/coupons/${props.campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueCount: Number(issueCount) }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy("");
    if (!res.ok) {
      setNotice(data.error || "调整失败");
      return;
    }
    setNotice("发行数量已更新");
    window.location.reload();
  }

  return (
    <div className="space-y-6">
      <div className="surface rounded-[28px] p-6">
        <div className="text-lg font-semibold">{props.name}</div>
        {props.description ? (
          <p className="mt-1 text-sm text-[var(--muted)]">{props.description}</p>
        ) : null}
        <div className="mt-3 text-sm">
          {formatCouponBenefit(props)} · 每人 {props.maxPerUser} 张 ·{" "}
          {props.minAmount > 0 ? `满 ${formatPrice(props.minAmount)}` : "无门槛"}
        </div>
        <div className="mt-1 text-xs text-[var(--muted)]">
          {props.productScope === "ALL"
            ? "全站商品"
            : props.products.map((p) => p.title).join("、") || "指定商品"}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["计划发行", props.issueCount],
            ["已生成", props.stats.generated],
            ["未领取", props.stats.available],
            ["已领取未使用", props.stats.claimed],
            ["已核销", props.stats.redeemed],
            ["已过期 / 停用", `${props.stats.expired} / ${props.stats.disabled}`],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-2xl bg-[var(--bg-deep)]/40 px-3 py-2">
              <div className="text-xs text-[var(--muted)]">{label}</div>
              <div className="text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="text-[var(--muted)]">调整发行数量</span>
            <input
              className="field mt-1 w-32"
              type="number"
              min={1}
              value={issueCount}
              onChange={(e) => setIssueCount(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            disabled={busy === "resize"}
            onClick={() => void resize()}
          >
            保存数量
          </button>
          <a
            className="btn btn-primary min-h-11"
            href={`/api/studio/coupons/${props.campaignId}/export`}
          >
            导出 CSV
          </a>
        </div>
      </div>

      <div className="surface rounded-[28px] p-6">
        <div className="flex flex-wrap gap-2">
          <select
            className="field"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            className="field"
            placeholder="领取用户 ID / 昵称 / 邮箱"
            value={userQ}
            onChange={(e) => setUserQ(e.target.value)}
          />
          <input
            className="field"
            placeholder="订单号"
            value={orderQ}
            onChange={(e) => setOrderQ(e.target.value)}
          />
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          共 {total} 张。列表默认只显示编号和 token 片段；复制链接需授权接口解密。
        </p>
        {notice ? <p className="mt-2 text-sm text-[var(--brand)]">{notice}</p> : null}
        <div className="mt-4 space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="rounded-2xl border border-[var(--line)] p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{row.serialNo}</div>
                  <div className="text-xs text-[var(--muted)]">token {row.tokenHint}</div>
                </div>
                <span>{STATUS_LABEL[row.status] || row.status}</span>
              </div>
              <div className="mt-2 text-xs text-[var(--muted)]">
                领取：
                {row.claimedBy
                  ? `${row.claimedBy.name || row.claimedBy.id} ${row.claimedBy.email} ${row.claimedBy.phone} · ${row.claimedAt || ""}`
                  : "未领取"}
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                核销：
                {row.redeemedAt
                  ? `${row.redeemedAt} · 订单 ${row.orders[0]?.orderNo || row.redeemedOrderId}`
                  : row.reservedOrderId
                    ? `预占订单 ${row.orders[0]?.orderNo || row.reservedOrderId}`
                    : "未使用"}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary min-h-11 text-sm"
                  disabled={busy === row.id}
                  onClick={() => void copyLink(row.id)}
                >
                  复制领取链接
                </button>
                {row.status === "AVAILABLE" ? (
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 text-sm text-[var(--fire)]"
                    disabled={busy === `d-${row.id}`}
                    onClick={() => void disableOne(row.id)}
                  >
                    停用
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
