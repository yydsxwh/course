"use client";

/**
 * 优惠券活动后台：创建批次并生成独立实例，不再提供公共分享库存链接。
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  postSave,
  SaveFeedback,
  type SaveStatus,
} from "@/components/save-feedback";
import {
  COUPON_PRODUCT_SCOPE_LABEL,
  COUPON_TYPE_LABEL,
  formatCouponBenefit,
  formatCouponProductScope,
  type CouponProductScope,
  type CouponType,
} from "@andyyyds/shared/coupons";
import { productTypeLabel } from "@andyyyds/shared/product-types";
import { formatPrice } from "@andyyyds/shared/utils";

export type CouponProductOption = {
  id: string;
  title: string;
  slug: string;
  productType: string;
  status: string;
};

export type CouponAdminRow = {
  id: string;
  code: string;
  title: string;
  name?: string;
  type: string;
  discountCents: number;
  percentOff: number;
  minAmount: number;
  issueCount?: number;
  generatedCount?: number;
  maxUses?: number;
  usedCount?: number;
  maxPerUser: number;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  productScope?: string;
  productIds?: string[];
  productTitles?: string[];
  products?: Array<{
    id: string;
    title: string;
    slug: string;
    productType: string;
  }>;
  createdAt: string;
};

type FormState = {
  title: string;
  description: string;
  type: CouponType;
  discountYuan: string;
  percentOff: string;
  minAmountYuan: string;
  issueCount: string;
  maxPerUser: string;
  startsAt: string;
  expiresAt: string;
  productScope: CouponProductScope;
  productIds: string[];
};

const emptyForm: FormState = {
  title: "",
  description: "",
  type: "FIXED",
  discountYuan: "100",
  percentOff: "10",
  minAmountYuan: "",
  issueCount: "200",
  maxPerUser: "1",
  startsAt: "",
  expiresAt: "",
  productScope: "ALL",
  productIds: [],
};

type Props = {
  initialCoupons: CouponAdminRow[];
  productOptions?: CouponProductOption[];
  defaultProductId?: string;
  embedded?: boolean;
};

export function CouponAdminPanel({
  initialCoupons,
  productOptions = [],
  defaultProductId,
  embedded = false,
}: Props) {
  const router = useRouter();
  const [coupons, setCoupons] = useState(initialCoupons);
  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    productScope: defaultProductId ? "SELECTED" : "ALL",
    productIds: defaultProductId ? [defaultProductId] : [],
  }));
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState<SaveStatus>(null);
  const [productFilter, setProductFilter] = useState("");

  const filteredOptions = useMemo(() => {
    const q = productFilter.trim().toLowerCase();
    if (!q) return productOptions;
    return productOptions.filter((p) => p.title.toLowerCase().includes(q));
  }, [productOptions, productFilter]);

  const visibleCoupons = useMemo(() => {
    if (!defaultProductId) return coupons;
    return coupons.filter((c) => {
      const scope = c.productScope || "ALL";
      if (scope === "ALL") return true;
      return (c.productIds || []).includes(defaultProductId);
    });
  }, [coupons, defaultProductId]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleProduct(id: string) {
    setForm((f) => {
      const has = f.productIds.includes(id);
      return {
        ...f,
        productIds: has
          ? f.productIds.filter((x) => x !== id)
          : [...f.productIds, id],
      };
    });
  }

  async function createCoupon() {
    setBusy("create");
    setFeedback(null);
    const result = await postSave("/api/studio/coupons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.title,
        description: form.description,
        type: form.type,
        discountYuan:
          form.type === "FIXED" ? Number(form.discountYuan) : undefined,
        percentOff:
          form.type === "PERCENT" ? Number(form.percentOff) : undefined,
        minAmountYuan: form.minAmountYuan ? Number(form.minAmountYuan) : 0,
        issueCount: Number(form.issueCount) || 1,
        maxPerUser: Number(form.maxPerUser) || 1,
        startsAt: form.startsAt || null,
        expiresAt: form.expiresAt || null,
        isActive: true,
        productScope: form.productScope,
        productIds: form.productScope === "SELECTED" ? form.productIds : [],
      }),
    });
    setBusy("");
    if (!result.ok) {
      setFeedback({ kind: "error", text: result.error || "创建失败" });
      return;
    }
    const coupon = (result.data.campaign || result.data.coupon) as
      | CouponAdminRow
      | undefined;
    if (coupon) setCoupons((prev) => [coupon, ...prev]);
    setForm({
      ...emptyForm,
      productScope: defaultProductId ? "SELECTED" : "ALL",
      productIds: defaultProductId ? [defaultProductId] : [],
    });
    setFeedback({
      kind: "ok",
      text: `已创建活动并生成 ${Number(form.issueCount) || 1} 张独立优惠券`,
    });
    router.refresh();
  }

  async function toggleActive(row: CouponAdminRow) {
    setBusy(row.id);
    setFeedback(null);
    const result = await postSave(`/api/studio/coupons/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    setBusy("");
    if (!result.ok) {
      setFeedback({ kind: "error", text: result.error || "更新失败" });
      return;
    }
    const coupon = (result.data.campaign || result.data.coupon) as
      | CouponAdminRow
      | undefined;
    if (coupon) {
      setCoupons((prev) =>
        prev.map((c) => (c.id === row.id ? { ...c, ...coupon } : c)),
      );
      setFeedback({
        kind: "ok",
        text: coupon.isActive ? "已启用成功" : "已停用成功",
      });
    }
    router.refresh();
  }

  async function removeCoupon(row: CouponAdminRow) {
    if (!confirm(`确定停用活动「${row.title || row.name}」？已领取/核销记录会保留。`)) {
      return;
    }
    setBusy(`del-${row.id}`);
    setFeedback(null);
    const result = await postSave(`/api/studio/coupons/${row.id}`, {
      method: "DELETE",
    });
    setBusy("");
    if (!result.ok) {
      setFeedback({ kind: "error", text: result.error || "操作失败" });
      return;
    }
    setCoupons((prev) => prev.filter((c) => c.id !== row.id));
    setFeedback({ kind: "ok", text: "已停用并保留历史" });
    router.refresh();
  }

  function scopeLabel(row: CouponAdminRow) {
    return formatCouponProductScope({
      productScope: row.productScope,
      productIds: row.productIds,
      productTitles: row.productTitles,
    });
  }

  return (
    <div className="space-y-6">
      <div className="surface space-y-4 rounded-[28px] p-6">
        <div>
          <h2 className="text-lg font-semibold">
            {embedded ? "本商品优惠券活动" : "创建优惠券活动"}
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            发行数量会生成同样多张彼此独立的优惠券，每张都有不可猜测的领取链接。不再使用公共券码共享库存。
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-[var(--muted)]">名称</span>
            <input
              className="field mt-2"
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              placeholder="如：高等数学单课优惠券"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">说明（可选）</span>
            <input
              className="field mt-2"
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="领取与使用说明"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          {(["FIXED", "PERCENT"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`chip text-sm ${
                form.type === t ? "chip-active" : "chip-idle"
              }`}
              onClick={() => setField("type", t)}
            >
              {COUPON_TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        {form.type === "FIXED" ? (
          <label className="block text-sm sm:max-w-xs">
            <span className="text-[var(--muted)]">每张减免金额（元）</span>
            <input
              className="field mt-2"
              type="number"
              min={0.01}
              step={0.01}
              value={form.discountYuan}
              onChange={(e) => setField("discountYuan", e.target.value)}
            />
          </label>
        ) : (
          <label className="block text-sm sm:max-w-xs">
            <span className="text-[var(--muted)]">减免比例 %（1–99）</span>
            <input
              className="field mt-2"
              type="number"
              min={1}
              max={99}
              step={1}
              value={form.percentOff}
              onChange={(e) => setField("percentOff", e.target.value)}
            />
          </label>
        )}

        <div>
          <div className="text-sm text-[var(--muted)]">适用商品</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["ALL", "SELECTED"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                className={`chip text-sm ${
                  form.productScope === scope ? "chip-active" : "chip-idle"
                }`}
                onClick={() => {
                  setField("productScope", scope);
                  if (
                    scope === "SELECTED" &&
                    defaultProductId &&
                    form.productIds.length === 0
                  ) {
                    setField("productIds", [defaultProductId]);
                  }
                }}
              >
                {COUPON_PRODUCT_SCOPE_LABEL[scope]}
              </button>
            ))}
          </div>
          {form.productScope === "SELECTED" ? (
            <div className="mt-3 space-y-2">
              {productOptions.length > 8 ? (
                <input
                  className="field"
                  value={productFilter}
                  onChange={(e) => setProductFilter(e.target.value)}
                  placeholder="筛选商品标题…"
                />
              ) : null}
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-[var(--line)] p-2">
                {filteredOptions.map((p) => {
                  const checked = form.productIds.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/80">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProduct(p.id)}
                          className="h-4 w-4"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <span className="mr-1.5 text-xs text-[var(--brand)]">
                            {productTypeLabel(p.productType)}
                          </span>
                          {p.title}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="text-[var(--muted)]">最低消费（元，可选）</span>
            <input
              className="field mt-2"
              type="number"
              min={0}
              step={0.01}
              value={form.minAmountYuan}
              onChange={(e) => setField("minAmountYuan", e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">发行数量（独立张数）</span>
            <input
              className="field mt-2"
              type="number"
              min={1}
              max={2000}
              value={form.issueCount}
              onChange={(e) => setField("issueCount", e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">每用户最多领取</span>
            <input
              className="field mt-2"
              type="number"
              min={1}
              max={100}
              value={form.maxPerUser}
              onChange={(e) => setField("maxPerUser", e.target.value)}
            />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-[var(--muted)]">使用开始时间（可选）</span>
            <input
              className="field mt-2 min-h-12 text-lg"
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setField("startsAt", e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--muted)]">使用结束时间（可选）</span>
            <input
              className="field mt-2 min-h-12 text-lg"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => setField("expiresAt", e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={busy === "create"}
            onClick={() => void createCoupon()}
          >
            {busy === "create" ? "创建中..." : "创建并生成独立券"}
          </button>
          <SaveFeedback status={feedback} />
        </div>
      </div>

      <div className="surface rounded-[28px] p-4 sm:p-6">
        <h2 className="text-lg font-semibold">
          {embedded ? "相关优惠券活动" : "优惠券活动"}
        </h2>
        {visibleCoupons.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">暂无优惠券活动</p>
        ) : (
          <div className="mt-4 space-y-3">
            {visibleCoupons.map((c) => (
              <div
                key={c.id}
                className="rounded-2xl border border-[var(--line)] bg-white/70 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{c.title || c.name}</div>
                    <div className="text-xs text-[var(--muted)]">批次 {c.code}</div>
                  </div>
                  <span
                    className={
                      c.isActive
                        ? "text-sm text-[var(--brand-strong)]"
                        : "text-sm text-[var(--muted)]"
                    }
                  >
                    {c.isActive ? "启用中" : "已停用"}
                  </span>
                </div>
                <div className="mt-2 text-sm">
                  {formatCouponBenefit(c)} · {scopeLabel(c)}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {c.minAmount > 0 ? `满 ${formatPrice(c.minAmount)}` : "无门槛"}{" "}
                  · 计划发行 {c.issueCount ?? c.maxUses} 张
                  {typeof c.generatedCount === "number"
                    ? ` · 已生成 ${c.generatedCount}`
                    : ""}{" "}
                  · 每人 {c.maxPerUser} 张
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/studio/marketing/coupons/${c.id}`}
                    className="btn btn-secondary min-h-11 flex-1 text-sm sm:flex-none"
                  >
                    查看详情
                  </Link>
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 flex-1 text-sm sm:flex-none"
                    disabled={busy === c.id}
                    onClick={() => toggleActive(c)}
                  >
                    {c.isActive ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11 flex-1 text-sm text-[var(--fire)] sm:flex-none"
                    disabled={busy === `del-${c.id}`}
                    onClick={() => removeCoupon(c)}
                  >
                    停用活动
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
