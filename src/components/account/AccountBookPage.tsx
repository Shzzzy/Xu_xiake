import {
  BadgeCheck,
  ChevronRight,
  Coins,
  Gift,
  History,
  LockKeyhole,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { maskPhone } from "@/lib/auth/phone";
import type { CreditLedgerEntry } from "@/lib/credits/types";

export type AccountBookUser = {
  id: string;
  phone: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
};

export type AccountBookWallet = {
  balance: number;
  reserved: number;
  freeTrialClaimed: boolean;
};

export type AccountBookLedgerEntry = Pick<
  CreditLedgerEntry,
  "id" | "delta" | "reason" | "balanceAfter"
> &
  Partial<Pick<CreditLedgerEntry, "createdAt" | "note">>;

export type AccountBookPageProps = {
  user: AccountBookUser;
  wallet: AccountBookWallet;
  ledger: AccountBookLedgerEntry[];
};

const ledgerReasonLabels: Record<CreditLedgerEntry["reason"], string> = {
  free_trial: "首次免费",
  purchase: "购买获得",
  generation: "生成行程",
  refund: "退款返还",
  admin_adjustment: "管理员调整",
  expiration: "点数过期",
  migration: "历史迁移",
};

function formatLedgerDate(value: string | undefined): string {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatLedgerDelta(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta}`;
}

export function AccountBookPage({ user, wallet, ledger }: AccountBookPageProps) {
  const available = Math.max(0, wallet.balance - wallet.reserved);
  const maskedPhone = user.phone ? maskPhone(user.phone) : "未绑定手机号";
  const visibleLedger = ledger.slice(0, 100);

  return (
    <main className="min-h-dvh overflow-x-hidden bg-bg px-3 py-4 text-fg sm:px-4 sm:py-6">
      <div className="mx-auto w-full max-w-[1280px]">
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
                WALLET / 行旅点册
              </small>
            </span>
          </a>
          <a
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-elevated/60 px-3 py-2 text-[11px] text-muted no-underline transition hover:border-primary/40 hover:text-primary"
            href="/"
          >
            返回首页
            <ChevronRight size={13} />
          </a>
        </header>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section
            className="relative overflow-hidden rounded-[28px] p-6 text-white shadow-[0_26px_75px_rgba(23,35,31,0.15)] sm:p-10"
            style={{
              background:
                "radial-gradient(circle at 84% 8%, rgba(216,203,115,.22), transparent 17rem), linear-gradient(145deg, #163e35, #0c5746 62%, #87663b)",
            }}
          >
            <span className="pointer-events-none absolute -right-4 -bottom-20 select-none font-serif text-[220px] leading-none text-white/[.045]">
              游
            </span>
            <div className="relative z-10">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-[10px] font-extrabold tracking-[0.22em] text-[#dccc74]">
                  WALLET / 行旅点册
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] text-white/75">
                  <BadgeCheck size={13} />
                  账号已安全登录
                </span>
              </div>

              <h1 className="mt-4 max-w-xl font-serif text-4xl leading-[1.05] font-semibold tracking-[-0.045em] sm:text-6xl">
                你的点数，安心放在这里。
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-white/72">
                当前账号：{maskedPhone}
                <span className="mx-2 text-white/35">·</span>
                点数、订单与行程都归到同一个账号，换设备登录也能继续查看。
              </p>

              <div className="mt-8 grid gap-3 sm:grid-cols-[1.3fr_1fr_1fr]">
                <div className="rounded-[20px] border border-white/15 bg-white/[.08] p-4 backdrop-blur">
                  <span className="text-[10px] tracking-[0.12em] text-white/55">可用点数</span>
                  <strong className="mt-2 block font-serif text-5xl leading-none font-semibold">
                    {available} 点
                  </strong>
                  <span className="mt-3 block text-[10px] text-white/50">
                    总余额 {wallet.balance} · 预占 {wallet.reserved}
                  </span>
                </div>
                <div className="rounded-[20px] border border-white/15 bg-white/[.06] p-4">
                  <Gift size={18} className="text-[#dccc74]" />
                  <span className="mt-3 block text-[10px] text-white/55">首次免费</span>
                  <strong className="mt-1 block text-sm font-semibold text-white">
                    {wallet.freeTrialClaimed ? "首次免费已使用" : "首次免费可用"}
                  </strong>
                </div>
                <div className="rounded-[20px] border border-white/15 bg-white/[.06] p-4">
                  <ShieldCheck size={18} className="text-[#dccc74]" />
                  <span className="mt-3 block text-[10px] text-white/55">账号状态</span>
                  <strong className="mt-1 block text-sm font-semibold text-white">
                    {user.status === "active" ? "正常使用" : "暂时停用"}
                  </strong>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2.5">
                <a
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#f5f0e5] px-5 text-sm font-bold text-[#123f34] no-underline shadow-[0_12px_24px_rgba(0,0,0,0.16)] transition hover:-translate-y-0.5"
                  href="/pricing?returnTo=/account"
                >
                  <Coins size={16} />
                  购买点数
                </a>
                {user.role === "admin" ? (
                  <a
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/25 bg-white/10 px-5 text-sm font-semibold text-white no-underline transition hover:bg-white/15"
                    href="/admin"
                  >
                    <LockKeyhole size={15} />
                    管理后台
                  </a>
                ) : null}
              </div>
            </div>
          </section>

          <aside className="rounded-[28px] border border-border bg-surface p-5 shadow-soft sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-bold tracking-[0.2em] text-primary">
                  LEDGER / 点数流水
                </div>
                <h2 className="mt-2 font-serif text-3xl font-semibold tracking-[-0.035em]">
                  最近流水
                </h2>
                <p className="mt-1 text-[11px] leading-5 text-muted">
                  最近 100 条点数变化都会保留在这里，方便你随时核对。
                </p>
              </div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
                <History size={18} />
              </span>
            </div>

            <ol className="mt-5 grid gap-3">
              {visibleLedger.length > 0 ? (
                visibleLedger.map((entry) => {
                  const positive = entry.delta >= 0;
                  return (
                    <li
                      className="flex items-start justify-between gap-4 rounded-[18px] border border-border/80 bg-elevated p-3.5"
                      key={entry.id}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                            positive ? "bg-primary/10 text-primary" : "bg-warn/10 text-warn"
                          }`}
                        >
                          {positive ? <Plus size={14} /> : <Minus size={14} />}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong className="text-sm font-semibold">
                              {ledgerReasonLabels[entry.reason] ?? "点数变动"}
                            </strong>
                            <span className="text-[10px] text-subtle">
                              {formatLedgerDate(entry.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 truncate text-[11px] text-muted">
                            {entry.note ?? "点数变动已记录"}
                          </p>
                          <span className="mt-1 block text-[10px] text-subtle">
                            余额 {entry.balanceAfter} 点
                          </span>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 font-serif text-lg font-semibold ${positive ? "text-primary" : "text-warn"}`}
                      >
                        {formatLedgerDelta(entry.delta)}
                      </span>
                    </li>
                  );
                })
              ) : (
                <li className="rounded-[18px] border border-dashed border-border bg-bg/55 px-4 py-8 text-center text-xs leading-6 text-muted">
                  还没有点数流水。首次完整体验或购买点数后，这里会显示记录。
                </li>
              )}
            </ol>
          </aside>
        </div>

        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-[20px] border border-border bg-surface/80 p-4">
            <Sparkles size={17} className="text-primary" />
            <strong className="mt-3 block text-sm">首次完整体验免费</strong>
            <span className="mt-1 block text-[11px] leading-5 text-muted">
              新账号第一次保存、下载或分享路书不消耗点数。
            </span>
          </div>
          <div className="rounded-[20px] border border-border bg-surface/80 p-4">
            <WalletCards size={17} className="text-primary" />
            <strong className="mt-3 block text-sm">购买后自动到账</strong>
            <span className="mt-1 block text-[11px] leading-5 text-muted">
              支付成功后，点数会回到当前账号，浏览器返回不会直接加点。
            </span>
          </div>
          <div className="rounded-[20px] border border-border bg-surface/80 p-4">
            <ShieldCheck size={17} className="text-primary" />
            <strong className="mt-3 block text-sm">分享查看不收费</strong>
            <span className="mt-1 block text-[11px] leading-5 text-muted">
              同行者打开分享链接即可查看路书，不会消耗他们的点数。
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
