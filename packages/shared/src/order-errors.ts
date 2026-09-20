/**
 * 下单/优惠券业务错误：对用户只回安全文案，内部原因打日志。
 */

export class OrderBusinessError extends Error {
  readonly userMessage: string;
  readonly httpStatus: number;
  readonly internal: string;

  constructor(
    userMessage: string,
    options?: { status?: number; internal?: string },
  ) {
    const internal = options?.internal || userMessage;
    super(internal);
    this.name = "OrderBusinessError";
    this.userMessage = userMessage;
    this.httpStatus = options?.status ?? 400;
    this.internal = internal;
  }
}

export function logOrderError(scope: string, err: unknown) {
  if (err instanceof OrderBusinessError) {
    console.error(`[${scope}]`, err.internal);
    return;
  }
  console.error(`[${scope}]`, err);
}

export function orderErrorPayload(err: unknown): {
  status: number;
  error: string;
} {
  if (err instanceof OrderBusinessError) {
    return { status: err.httpStatus, error: err.userMessage };
  }
  if (err && typeof err === "object" && "name" in err && err.name === "ZodError") {
    return { status: 400, error: "请求参数无效" };
  }
  return { status: 400, error: "下单失败，请稍后重试" };
}
