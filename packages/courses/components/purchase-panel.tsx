"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/components/i18n/locale-provider";
import { OrderFormFields } from "@/components/order-form-fields";
import { COUPON_QUERY_KEY, COUPON_STORAGE_KEY } from "@andyyyds/shared/coupon-share";
import { normalizeCouponCode } from "@andyyyds/shared/coupons";
import {
  activeOrderFormFields,
  validateOrderFormAnswers,
  type OrderFormAnswers,
  type OrderFormConfig,
} from "@andyyyds/shared/order-form";
import { REFERRAL_STORAGE_KEY } from "@andyyyds/shared/invite";
import { formatPrice } from "@andyyyds/shared/utils";

type AvailableCoupon = {
  id: string;
  code: string;
  title: string;
  type: string;
  benefit: string;
  discountCents: number;
  minAmount: number;
  expiresAt: string | null;
  available?: boolean;
  reason?: string;
  reservedOrderId?: string;
};

type PaymentConflict = {
  orderId: string;
  orderNo: string;
  amount: number;
  discount: number;
};

type Props = {
  courseId: string;
  price: number;
  isFree: boolean;
  enrolled: boolean;
  slug: string;
  orderForm: OrderFormConfig;
  /** 购买面板文案：课程 / 资料 / 专栏 */
  productLabel?: string;
  /** 站长 / 授课者：可不购买直接进学习页预览 */
  canStaffPreview?: boolean;
  /** 购买/已拥有后的跳转；专栏套餐可指回详情页选子课 */
  learnHref?: string;
  /** 已拥有态文案（约搭用「你已报名」） */
  ownedHint?: string;
  /** 已拥有态主按钮文案 */
  ownedCtaLabel?: string;
  /** 购买按钮文案（约搭用「报名并支付」） */
  buyCtaLabel?: string;
  /** 支付说明旁白 */
  payHint?: string;
  /** 营销面隐藏售价（结账页仍显示应付） */
  hidePriceDisplay?: boolean;
};

export function PurchasePanel({
  courseId,
  price,
  isFree,
  enrolled,
  slug,
  orderForm,
  productLabel = "课程",
  canStaffPreview = false,
  learnHref,
  ownedHint,
  ownedCtaLabel,
  buyCtaLabel,
  payHint,
  hidePriceDisplay = false,
}: Props) {
  const goLearn = learnHref || `/learn/${slug}`;
  const router = useRouter();
  const { t } = useLocale();
  const [couponCode, setCouponCode] = useState("");
  const [selectedCouponId, setSelectedCouponId] = useState("");
  const [available, setAvailable] = useState<AvailableCoupon[]>([]);
  const [unavailable, setUnavailable] = useState<AvailableCoupon[]>([]);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<PaymentConflict | null>(null);
  const [loading, setLoading] = useState(false);
  const buyingRef = useRef(false);
  const [formAnswers, setFormAnswers] = useState<OrderFormAnswers>({});
  const fields = activeOrderFormFields(orderForm);
  const isMeetup = productLabel === "约搭";

  // 登录后拉取可用券；分享链 / 本地券码在回调里预填，避免 effect 同步 setState。
  useEffect(() => {
    if (isFree || price <= 0) return;
    let cancelled = false;
    let prefill = "";
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = normalizeCouponCode(
        params.get(COUPON_QUERY_KEY) || params.get("couponCode") || "",
      );
      const fromStorage = normalizeCouponCode(
        window.localStorage.getItem(COUPON_STORAGE_KEY) || "",
      );
      prefill = fromQuery || fromStorage;
    } catch {
      /* ignore */
    }
    (async () => {
      const res = await fetch(
        `/api/coupons/available?courseId=${encodeURIComponent(courseId)}`,
      );
      if (!res.ok || cancelled) return;
      const data = await res.json();
      if (cancelled) return;
      const list = (data.coupons || []) as AvailableCoupon[];
      const blocked = (data.unavailable || []) as AvailableCoupon[];
      const typed = normalizeCouponCode(prefill);
      const hit = typed
        ? list.find((c) => normalizeCouponCode(c.code) === typed)
        : undefined;
      setAvailable(list);
      setUnavailable(blocked);
      if (typed) setCouponCode(typed);
      const best = hit || list[0];
      if (best) {
        setSelectedCouponId(best.id);
        setCouponCode(best.code);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId, isFree, price]);

  const previewDiscount = (() => {
    if (selectedCouponId) {
      return (
        available.find((c) => c.id === selectedCouponId)?.discountCents || 0
      );
    }
    // 手输券码时也尝试匹配可用列表，便于预览「抵扣后 0 元」
    const typed = normalizeCouponCode(couponCode);
    if (!typed) return 0;
    return (
      available.find((c) => normalizeCouponCode(c.code) === typed)
        ?.discountCents || 0
    );
  })();
  const previewPay = Math.max(price - Math.min(previewDiscount, price), 0);
  const willZeroPay = !isFree && price > 0 && previewDiscount > 0 && previewPay === 0;
  const selectedCoupon = available.find((c) => c.id === selectedCouponId);

  async function recoverOpenOrder() {
    try {
      const res = await fetch(
        `/api/orders?courseId=${encodeURIComponent(courseId)}`,
      );
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.orderId) return false;
      if (data.enrolled || data.status === "PAID" || data.amount === 0) {
        router.push(goLearn);
        router.refresh();
        return true;
      }
      if (data.status === "PENDING") {
        router.push(`/checkout/${data.orderId}`);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function cancelReservedOrder(orderId: string, retryBuy = false) {
    if (buyingRef.current) return;
    buyingRef.current = true;
    setLoading(true);
    setMessage("");
    let cancelled = false;
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(
          typeof data.error === "string" && data.error.trim()
            ? data.error
            : "取消订单失败",
        );
        if (data.conflict?.orderId) {
          setConflict({
            orderId: String(data.conflict.orderId),
            orderNo: String(data.conflict.orderNo || ""),
            amount: Number(data.conflict.amount || 0),
            discount: Number(data.conflict.discount || 0),
          });
        }
        return;
      }
      cancelled = true;
      setConflict(null);
      if (!retryBuy) setSelectedCouponId("");
      router.refresh();
      const listed = await fetch(
        `/api/coupons/available?courseId=${encodeURIComponent(courseId)}`,
      );
      if (listed.ok) {
        const body = await listed.json();
        setAvailable((body.coupons || []) as AvailableCoupon[]);
        setUnavailable((body.unavailable || []) as AvailableCoupon[]);
      }
      setMessage(
        retryBuy
          ? "原订单已取消，正在按当前优惠重新开通…"
          : "原订单已取消，优惠券已释放。可以重新选择。",
      );
    } finally {
      buyingRef.current = false;
      setLoading(false);
    }
    if (cancelled && retryBuy) {
      await buy();
    }
  }

  function pickCoupon(coupon: AvailableCoupon) {
    setSelectedCouponId(coupon.id);
    setCouponCode(coupon.code);
  }

  function clearCoupon() {
    setSelectedCouponId("");
    setCouponCode("");
  }

  async function buy() {
    if (buyingRef.current) return;
    if (fields.length > 0) {
      const check = validateOrderFormAnswers(orderForm, formAnswers);
      if (!check.ok) {
        setMessage(check.error);
        return;
      }
    }

    buyingRef.current = true;
    setLoading(true);
    setMessage("");
    setConflict(null);
    let referralCode: string | undefined;
    try {
      referralCode =
        window.localStorage.getItem(REFERRAL_STORAGE_KEY) || undefined;
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          couponInstanceId: selectedCouponId || undefined,
          formAnswers: fields.length > 0 ? formAnswers : undefined,
          referralCode,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "PAYMENT_IN_PROGRESS" && data.conflict?.orderId) {
          setConflict({
            orderId: String(data.conflict.orderId),
            orderNo: String(data.conflict.orderNo || ""),
            amount: Number(data.conflict.amount || 0),
            discount: Number(data.conflict.discount || 0),
          });
        }
        setMessage(
          typeof data.error === "string" && data.error.trim()
            ? data.error
            : res.status === 401
              ? "请先登录"
              : "下单失败，请稍后重试",
        );
        if (res.status === 401) router.push("/login");
        return;
      }

      if (data.enrolled) {
        router.push(goLearn);
        router.refresh();
        return;
      }

      router.push(`/checkout/${data.orderId}`);
    } catch (error) {
      const timedOut =
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      if (timedOut) {
        const recovered = await recoverOpenOrder();
        if (recovered) return;
      }
      setMessage(
        timedOut
          ? "下单超时。请刷新页面确认订单，不要重复支付。"
          : "网络异常，请稍后重试",
      );
    } finally {
      buyingRef.current = false;
      setLoading(false);
    }
  }

  if (enrolled) {
    return (
      <div className="surface rounded-[28px] p-6">
        <p className="text-sm text-[var(--muted)]">
          {ownedHint || `你已拥有本${productLabel}`}
        </p>
        <button
          className="btn btn-primary mt-4 w-full"
          onClick={() => router.push(goLearn)}
          type="button"
        >
          {ownedCtaLabel ||
            (productLabel === "资料"
              ? "进入查看"
              : productLabel === "专栏"
                ? "查看套餐课程"
                : isMeetup
                  ? "查看活动"
                  : "进入学习")}
        </button>
      </div>
    );
  }

  if (canStaffPreview) {
    const isMaterial = productLabel === "资料";
    const isColumn = productLabel === "专栏";
    return (
      <div className="surface rounded-[28px] p-6">
        <p className="text-sm text-[var(--muted)]">
          {isMaterial
            ? "站长 / 授课预览：可直接预览或下载全部资料文件。"
            : isColumn
              ? "站长 / 授课预览：可查看套餐内各单课并进入学习。"
              : "站长 / 授课预览：可直接查看全部网课内容并播放视频。"}
        </p>
        <button
          className="btn btn-primary mt-4 w-full"
          onClick={() => router.push(goLearn)}
          type="button"
        >
          {isMaterial ? "预览资料" : isColumn ? "查看套餐" : "预览网课"}
        </button>
        {hidePriceDisplay ? (
          <p className="mt-3 text-xs text-[var(--muted)]">
            学员仍须购买后{isMaterial ? "查看 / 下载" : "学习"}。
          </p>
        ) : (
          <p className="mt-3 text-xs text-[var(--muted)]">
            前台售价 {isFree || price <= 0 ? "免费" : formatPrice(price)}
            ；学员仍须购买后
            {isMaterial ? "查看 / 下载" : "学习"}。
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="surface rounded-[28px] p-6">
      {hidePriceDisplay ? (
        <div className="text-xl font-semibold text-[var(--ink)]">
          {isFree || price <= 0 ? "免费领取" : `获取${productLabel}`}
        </div>
      ) : (
        <div className="text-3xl font-semibold text-[var(--brand)]">
          {isFree || price <= 0
            ? "免费领取"
            : previewDiscount > 0
              ? formatPrice(previewPay)
              : `¥${(price / 100).toFixed(price % 100 === 0 ? 0 : 2)}`}
        </div>
      )}
      {previewDiscount > 0 ? (
        <div className="mt-2 space-y-1 text-sm">
          <p className="text-[var(--muted)]">原价 {formatPrice(price)}</p>
          <p className="text-[var(--fire)]">
            优惠 -{formatPrice(Math.min(previewDiscount, price))}
            {selectedCoupon
              ? ` · ${selectedCoupon.title} · 券号 ${selectedCoupon.code}`
              : ""}
          </p>
          <p className="font-medium text-[var(--ink)]">
            应付 {formatPrice(previewPay)}
            {willZeroPay ? " · 确认后直接开通，无需支付" : ""}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-[var(--muted)]">
          {payHint ||
            (isMeetup
              ? "支持微信 JSAPI / 扫码支付；支付成功后自动报名。可用优惠券抵扣，额度 ≥ 报名费时可 0 元报名。"
              : "支持微信支付购买；支付成功后立即开通学习。优惠券额度 ≥ 售价时可 0 元开通。")}
        </p>
      )}
      {fields.length > 0 ? (
        <div className="mt-4 border-t border-[var(--line)] pt-4">
          <OrderFormFields
            config={orderForm}
            values={formAnswers}
            onChange={setFormAnswers}
            disabled={loading}
          />
        </div>
      ) : null}
      {!isFree && price > 0 ? (
        <div className="mt-4 space-y-3">
          {available.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm text-[var(--muted)]">可用优惠券</div>
              <div className="flex flex-col gap-2">
                {available.map((c) => {
                  const active = selectedCouponId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        active ? clearCoupon() : pickCoupon(c)
                      }
                      className={`min-h-11 rounded-2xl border px-3 py-3 text-left text-sm transition ${
                        active
                          ? "border-[var(--fire)] bg-[var(--fire)]/5"
                          : "border-[var(--line)] bg-white/60 hover:border-[var(--brand)]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{c.title}</span>
                        <span className="text-[var(--fire)]">{c.benefit}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--muted)]">
                        {c.code}
                        {c.minAmount > 0
                          ? ` · 满 ${formatPrice(c.minAmount)}`
                          : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {unavailable.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm text-[var(--muted)]">暂不可用的优惠券</div>
              <div className="flex flex-col gap-2">
                {unavailable.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-2xl border border-dashed border-[var(--line)] bg-white/40 px-3 py-3 text-left text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[var(--muted)]">
                        {c.title}
                      </span>
                      <span className="text-[var(--muted)]">{c.benefit}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-red-700">
                      {c.reason || "当前不可用"}
                      {c.code ? ` · 券号 ${c.code}` : ""}
                    </div>
                    {c.reservedOrderId ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn min-h-11 px-3 text-xs"
                          onClick={() => router.push(`/checkout/${c.reservedOrderId}`)}
                        >
                          继续支付
                        </button>
                        <button
                          type="button"
                          className="btn min-h-11 px-3 text-xs"
                          disabled={loading}
                          onClick={() => cancelReservedOrder(c.reservedOrderId!)}
                        >
                          取消原订单
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {available.length === 0 && unavailable.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">
              没有已领取的优惠券。请打开管理员发给你的独立领取链接。
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        className="btn btn-accent mt-4 min-h-11 w-full"
        disabled={loading}
        onClick={buy}
        type="button"
      >
        {loading
          ? t("common.loading")
          : buyCtaLabel
            ? willZeroPay
              ? isMeetup
                ? "0 元报名"
                : "0 元开通"
              : buyCtaLabel
            : isFree || price <= 0 || willZeroPay
              ? isMeetup
                ? t("cta.freeJoin")
                : "0 元开通"
              : t("cta.buy")}
      </button>
      {message ? <p className="mt-3 text-sm text-red-700">{message}</p> : null}
      {conflict ? (
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            className="btn min-h-11 w-full"
            onClick={() => router.push(`/checkout/${conflict.orderId}`)}
          >
            继续支付原订单
            {conflict.orderNo ? `（${conflict.orderNo}）` : ""}
          </button>
          <button
            type="button"
            className="btn min-h-11 w-full"
            disabled={loading}
            onClick={() => cancelReservedOrder(conflict.orderId, true)}
          >
            取消原订单并使用当前优惠
          </button>
        </div>
      ) : null}
    </div>
  );
}
