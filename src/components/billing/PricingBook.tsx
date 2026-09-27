import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpenText,
  Check,
  Coins,
  Gift,
  LockKeyhole,
  MapPinned,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { normalizeReturnTo } from "@/lib/auth/return-to";
import {
  PACKAGE_CATALOG,
  resolvePackage,
  type PackageCode,
  type PackageDefinition,
} from "@/lib/billing/catalog";

export type CheckoutCallback = (selection: PackageDefinition) => void;

export type CheckoutAction =
  { status: "auth"; href: string } | { status: "checkout"; selection: PackageDefinition };

const packageOrder: PackageCode[] = ["single", "ten", "thirty"];

const packageDescriptions: Record<PackageCode, string> = {
  single: "临时出行，不想囤点数",
  ten: "适合一年多次出发",
  thirty: "适合高频旅行与家庭共享",
};

function toChinesePoints(points: number): string {
  if (points < 10 || points >= 100) return String(points);
  const digits = "零一二三四五六七八九";
  const tens = Math.floor(points / 10);
  const ones = points % 10;
  return `${tens === 1 ? "" : digits[tens]}十${ones ? digits[ones] : ""}`;
}

function getPackageTitle(code: PackageCode): string {
  const { points } = resolvePackage(code);
  return points === 1 ? "单次购买" : `${toChinesePoints(points)}次点数`;
}

function getPackageIndex(code: PackageCode): string {
  return String(resolvePackage(code).points).padStart(2, "0");
}

function formatPrice(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function formatPerUse(selection: PackageDefinition): string {
  return formatPrice(Math.round(selection.amountCents / selection.points));
}

export type PricingEntitlement = {
  freeTrialClaimed: boolean;
};

export function getPricingStatusCopy(input: {
  authenticated: boolean;
  entitlement: PricingEntitlement | null | undefined;
  selection: PackageDefinition;
}): string {
  if (!input.authenticated) return "登录后首次完整体验免费";
  if (!input.entitlement) return "正在确认免费体验状态";
  if (input.entitlement.freeTrialClaimed) {
    return `本次购买将获得 ${input.selection.points} 点`;
  }
  return "新用户首次完整体验免费";
}

export async function loadPricingEntitlement(input: {
  userId: string | undefined;
  fetchWallet: () => Promise<{ wallet: { freeTrialClaimed: boolean } }>;
  onEntitlement: (entitlement: PricingEntitlement | null) => void;
}): Promise<PricingEntitlement | null> {
  if (!input.userId) {
    input.onEntitlement(null);
    return null;
  }

  const result = await input.fetchWallet();
  const entitlement = { freeTrialClaimed: result.wallet.freeTrialClaimed };
  input.onEntitlement(entitlement);
  return entitlement;
}

export function buildPricingAuthHref(returnTo?: string): string {
  const safeReturnTo = returnTo ? normalizeReturnTo(returnTo) : undefined;
  const pricingHref =
    safeReturnTo && safeReturnTo !== "/"
      ? `/pricing?returnTo=${encodeURIComponent(safeReturnTo)}`
      : "/pricing";
  return `/auth?returnTo=${pricingHref}`;
}

export function resolveCheckoutAction(input: {
  authenticated: boolean;
  returnTo?: string;
  selectedCode: PackageCode;
}): CheckoutAction {
  if (!input.authenticated) {
    return { status: "auth", href: buildPricingAuthHref(input.returnTo) };
  }

  return {
    status: "checkout",
    selection: resolvePackage(input.selectedCode),
  };
}

export function completeCheckout(input: {
  selectedCode: PackageCode;
  onCheckout: CheckoutCallback;
}): PackageDefinition {
  const selection = resolvePackage(input.selectedCode);
  input.onCheckout(selection);
  return selection;
}

export type PricingBookProps = {
  authenticated: boolean;
  onCheckout: CheckoutCallback;
  entitlement?: PricingEntitlement | null;
  returnTo?: string;
  initialPackage?: PackageCode;
};

export function PricingBook({
  authenticated,
  onCheckout,
  entitlement,
  returnTo,
  initialPackage = "ten",
}: PricingBookProps) {
  const [selectedCode, setSelectedCode] = useState<PackageCode>(initialPackage);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const selected = resolvePackage(selectedCode);
  const statusCopy = getPricingStatusCopy({ authenticated, entitlement, selection: selected });

  function openCheckout() {
    const action = resolveCheckoutAction({
      authenticated,
      returnTo,
      selectedCode,
    });
    if (action.status === "checkout") setCheckoutOpen(true);
  }

  function confirmCheckout() {
    completeCheckout({ selectedCode, onCheckout });
    setCheckoutOpen(false);
  }

  return (
    <main className="min-h-dvh overflow-x-hidden bg-bg px-3 py-4 text-fg sm:px-4 sm:py-6">
      <div className="mx-auto w-full max-w-[1320px]">
        <header className="flex items-center justify-between gap-3 rounded-[18px] border border-fg/10 bg-surface/90 p-2.5 shadow-[0_12px_34px_rgba(23,35,31,0.08)] backdrop-blur">
          <a
            className="flex min-w-0 items-center gap-3 text-inherit no-underline"
            href="/"
            aria-label="返回你好，徐霞客首页"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-primary font-serif text-xl font-bold text-primary-fg shadow-[0_9px_22px_rgba(31,106,88,0.23)]">
              徐
            </span>
            <span className="min-w-0">
              <strong className="block truncate font-serif text-base font-semibold">
                你好，徐霞客
              </strong>
              <small className="block text-[10px] tracking-[0.16em] text-muted">
                LEDGER / 行旅点册
              </small>
            </span>
          </a>
          <div className="flex items-center gap-2">
            <a
              className="hidden rounded-full border border-border bg-elevated/60 px-3 py-2 text-[11px] text-muted no-underline transition hover:border-primary/40 hover:text-primary sm:inline-flex"
              href="/account"
            >
              我的点数
            </a>
            <a
              className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated/60 px-3 py-2 text-[11px] text-muted no-underline transition hover:border-primary/40 hover:text-primary"
              href="/"
            >
              返回首页
              <ArrowRight size={13} />
            </a>
          </div>
        </header>

        <section className="mt-8 grid gap-5 lg:mt-12 lg:grid-cols-[1.04fr_0.96fr]">
          <article
            className="relative min-h-[640px] overflow-hidden rounded-[28px] p-6 text-white shadow-[0_26px_75px_rgba(23,35,31,0.15)] sm:p-10"
            style={{
              background:
                "radial-gradient(circle at 84% 8%, rgba(216,203,115,.22), transparent 17rem), linear-gradient(145deg, #163e35, #0c5746 62%, #87663b)",
            }}
          >
            <span className="pointer-events-none absolute -right-8 -bottom-24 select-none font-serif text-[260px] leading-none text-white/[.045]">
              游
            </span>
            <div className="relative z-10">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-[10px] font-extrabold tracking-[0.22em] text-[#dccc74]">
                  XUXIAKE'S LEDGER
                </div>
                <span
                  data-pricing-status
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] text-white/75"
                >
                  <Gift size={13} />
                  {statusCopy}
                </span>
              </div>

              <h1 className="mt-5 max-w-2xl font-serif text-4xl leading-[1.06] font-semibold tracking-[-0.045em] sm:text-6xl">
                你的旅行，
                <br />
                值得先算清楚。
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-white/72">
                不订阅用不上的会员，也不把费用藏进套餐。每次生成完整行程、预算、PDF
                路书和分享链接，统一消耗 1 点。
              </p>

              <div className="mt-8 grid gap-2.5 sm:grid-cols-2">
                <Benefit
                  icon={<MapPinned size={17} />}
                  title="完整旅行规划"
                  text="路线、景点、天气与预算"
                />
                <Benefit
                  icon={<BookOpenText size={17} />}
                  title="PDF 路书下载"
                  text="适合打印与离线查看"
                />
                <Benefit
                  icon={<WalletCards size={17} />}
                  title="分享给同行者"
                  text="同行者查看不重复购买"
                />
                <Benefit
                  icon={<Sparkles size={17} />}
                  title="社交平台文案"
                  text="小红书与朋友圈可直接改写"
                />
              </div>

              <div className="mt-8 rounded-2xl border border-white/12 bg-black/10 p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#f1dfa1]">
                  <ShieldCheck size={17} />
                  出发之前，先知道这一天该怎么走。
                </div>
                <p className="mt-2 text-xs leading-6 text-white/60">
                  价格透明，点数按次消耗，不做自动续费。所有结果先给用户看，再决定是否带走。
                </p>
              </div>
            </div>
          </article>

          <article className="rounded-[28px] border border-fg/10 bg-surface/90 p-5 shadow-[0_20px_60px_rgba(23,35,31,0.09)] sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] font-extrabold tracking-[0.22em] text-primary">
                  CREDIT PACKAGES
                </div>
                <h2 className="mt-2 font-serif text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                  点数价目表
                </h2>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-3 py-1.5 text-[10px] font-semibold text-primary">
                <Coins size={13} />1 点 = 1 次完整规划
              </span>
            </div>

            <div className="mt-7 grid gap-3" role="radiogroup" aria-label="选择点数套餐">
              {packageOrder.map((code) => {
                const item = PACKAGE_CATALOG[code];
                const title = getPackageTitle(code);
                const description = packageDescriptions[code];
                const isSelected = selectedCode === code;
                return (
                  <button
                    key={code}
                    type="button"
                    data-package={code}
                    aria-pressed={isSelected}
                    aria-checked={isSelected}
                    role="radio"
                    onClick={() => setSelectedCode(code)}
                    className={`group relative grid w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-2xl border p-4 text-left transition ${
                      isSelected
                        ? "border-primary bg-primary/8 shadow-[0_16px_34px_rgba(31,106,88,0.13)]"
                        : "border-border bg-elevated/40 hover:-translate-y-0.5 hover:border-primary/35"
                    }`}
                  >
                    <span
                      className={`grid h-11 w-11 place-items-center rounded-xl font-serif text-lg font-semibold ${
                        isSelected ? "bg-primary text-primary-fg" : "bg-surface text-muted"
                      }`}
                    >
                      {getPackageIndex(code)}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="font-serif text-lg font-semibold">{title}</strong>
                        {isSelected ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[9px] font-bold text-primary-fg">
                            <Check size={10} />
                            已选
                          </span>
                        ) : null}
                      </span>
                      <small className="mt-1 block text-[11px] text-muted">
                        {description} · 每次约 ¥{formatPerUse(item)}
                      </small>
                    </span>
                    <span className="text-right">
                      <strong className="block font-serif text-2xl font-semibold">
                        ¥{formatPrice(item.amountCents)}
                      </strong>
                      <small className="mt-1 block text-[10px] text-muted">
                        {item.discountLabel}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-7 rounded-2xl border border-border bg-bg/45 p-5">
              <div className="flex items-start gap-3">
                <ReceiptText className="mt-0.5 shrink-0 text-primary" size={19} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="font-serif text-base">本次预计支付</strong>
                    <strong className="font-serif text-2xl text-primary">
                      ¥{formatPrice(selected.amountCents)}
                    </strong>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted">
                    获得 {selected.points} 点 · 折合每次约 ¥{formatPerUse(selected)}
                  </p>
                </div>
              </div>
              {authenticated ? (
                <button
                  type="button"
                  onClick={openCheckout}
                  className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-fg shadow-[0_12px_24px_rgba(31,106,88,0.18)] transition hover:-translate-y-0.5"
                >
                  进入支付
                  <ArrowRight size={16} />
                </button>
              ) : (
                <a
                  href={buildPricingAuthHref(returnTo)}
                  className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-fg no-underline shadow-[0_12px_24px_rgba(31,106,88,0.18)] transition hover:-translate-y-0.5"
                >
                  登录后进入支付
                  <ArrowRight size={16} />
                </a>
              )}
              <div className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-muted">
                <LockKeyhole size={12} />
                不自动续费 · 不隐藏收费 · 支付前展示总价
              </div>
            </div>
          </article>
        </section>
      </div>

      {authenticated && checkoutOpen ? (
        <CheckoutSheet
          selection={selected}
          onClose={() => setCheckoutOpen(false)}
          onConfirm={confirmCheckout}
        />
      ) : null}
    </main>
  );
}

function Benefit({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-white/12 bg-white/[.07] p-4">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-[#e7d78e]">
        {icon}
      </span>
      <strong className="mt-3 block text-sm">{title}</strong>
      <small className="mt-1 block text-[10px] leading-5 text-white/55">{text}</small>
    </div>
  );
}

export type CheckoutSheetProps = {
  selection: PackageDefinition;
  onClose: () => void;
  onConfirm: () => void;
};

export function CheckoutSheet({ selection, onClose, onConfirm }: CheckoutSheetProps) {
  const [paymentMethod, setPaymentMethod] = useState<"wechat" | "alipay">("wechat");
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;

    function getFocusableElements(): HTMLElement[] {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const active = document.activeElement;
      const activeInside = active instanceof Node && dialog?.contains(active);
      if (event.shiftKey) {
        if (!activeInside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!activeInside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    closeButtonRef.current?.focus();
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45 backdrop-blur-sm">
      <button
        type="button"
        aria-label="关闭支付面板背景"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-dialog-title"
        tabIndex={-1}
        className="relative z-10 flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-white/10 bg-surface p-5 shadow-2xl sm:p-7"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-extrabold tracking-[0.22em] text-primary">
              PAYMENT CONFIRMATION
            </div>
            <h3 id="checkout-dialog-title" className="mt-2 font-serif text-3xl font-semibold">
              确认购买点数
            </h3>
            <p className="mt-2 text-xs leading-6 text-muted">
              本界面仅确认套餐与金额，不会在本任务中创建真实订单。
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭支付面板"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-bg/60 text-lg text-muted"
          >
            ×
          </button>
        </header>

        <div className="mt-7 rounded-2xl border border-border bg-bg/55 p-5">
          <div className="text-[10px] font-extrabold tracking-[0.18em] text-primary">
            ORDER / 本次订单
          </div>
          <h4 className="mt-2 font-serif text-xl font-semibold">
            {getPackageTitle(selection.code)}
          </h4>
          <div className="mt-4 grid gap-2 text-xs">
            <div className="flex items-center justify-between gap-4 border-b border-dashed border-border pb-2">
              <span className="text-muted">点数数量</span>
              <strong>{selection.points} 点</strong>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-dashed border-border pb-2">
              <span className="text-muted">每次消耗</span>
              <strong>1 点</strong>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-dashed border-border pb-2">
              <span className="text-muted">包含权益</span>
              <strong>规划 / PDF / 分享 / 文案</strong>
            </div>
            <div className="flex items-center justify-between gap-4 pt-1">
              <span className="text-muted">自动续费</span>
              <strong>不会开启</strong>
            </div>
          </div>
          <div className="mt-5 flex items-end justify-between gap-3">
            <span className="text-xs text-muted">应付金额</span>
            <strong className="font-serif text-3xl text-primary">
              ¥{formatPrice(selection.amountCents)}
            </strong>
          </div>
        </div>

        <div className="mt-6">
          <div className="text-[10px] font-extrabold tracking-[0.18em] text-primary">
            PAYMENT / 支付方式
          </div>
          <h4 className="mt-2 font-serif text-xl font-semibold">选择支付方式</h4>
          <div className="mt-4 grid gap-2.5">
            <PaymentOption
              active={paymentMethod === "wechat"}
              color="#07a84a"
              mark="微"
              title="微信支付"
              text="推荐使用，手机端体验更顺畅"
              onClick={() => setPaymentMethod("wechat")}
            />
            <PaymentOption
              active={paymentMethod === "alipay"}
              color="#1677ff"
              mark="支"
              title="支付宝"
              text="支持扫码与余额支付"
              onClick={() => setPaymentMethod("alipay")}
            />
          </div>
          <p className="mt-3 text-[10px] leading-5 text-muted">
            正式版本将由支付服务商处理付款，应用不保存银行卡、支付密码或完整支付凭证。
          </p>
        </div>

        <div className="mt-auto pt-7">
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-fg shadow-[0_12px_24px_rgba(31,106,88,0.18)] transition hover:-translate-y-0.5"
          >
            确认支付 ¥{formatPrice(selection.amountCents)}
          </button>
          <p className="mt-3 text-center text-[10px] text-muted">
            当前为界面与回调接口，不会产生真实订单。
          </p>
        </div>
      </section>
    </div>
  );
}

function PaymentOption({
  active,
  color,
  mark,
  title,
  text,
  onClick,
}: {
  active: boolean;
  color: string;
  mark: string;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition ${
        active
          ? "border-primary bg-primary/8"
          : "border-border bg-elevated/40 hover:border-primary/35"
      }`}
    >
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold text-white"
        style={{ background: color }}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm">{title}</strong>
        <small className="mt-1 block text-[10px] text-muted">{text}</small>
      </span>
      <span
        className={`grid h-5 w-5 place-items-center rounded-full border ${active ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
      >
        {active ? <Check size={12} /> : null}
      </span>
    </button>
  );
}
