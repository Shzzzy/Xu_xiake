import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Coins, FileText, ReceiptText, ShieldCheck, Users } from "lucide-react";
import type { AdminLedgerRow, AdminMetrics, AdminOrderRow, AdminUserRow } from "@/lib/admin.server";

export type AdminDashboardProps = {
  metrics: AdminMetrics;
  users: AdminUserRow[];
  orders: AdminOrderRow[];
  ledger: AdminLedgerRow[];
  onAdjustCredits?: (input: {
    userId: string;
    delta: number;
    note: string;
  }) => Promise<void> | void;
  onSetUserStatus?: (input: {
    userId: string;
    status: "active" | "disabled";
  }) => Promise<void> | void;
  onRevealPhone?: (userId: string) => Promise<string | null> | string | null;
};

function currency(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(status: string): string {
  if (status === "active") return "正常";
  if (status === "disabled") return "已停用";
  if (status === "paid") return "已支付";
  if (status === "pending") return "处理中";
  if (status === "created") return "已创建";
  if (status === "failed") return "失败";
  if (status === "refunded") return "已退款";
  return status;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    free_trial: "首次免费",
    purchase: "购买点数",
    generation: "生成行程",
    refund: "退款",
    admin_adjustment: "管理员调整",
    expiration: "过期",
    migration: "迁移",
  };
  return labels[reason] ?? reason;
}

export function AdminDashboard({
  metrics,
  users,
  orders,
  ledger,
  onAdjustCredits,
  onSetUserStatus,
  onRevealPhone,
}: AdminDashboardProps) {
  const [targetUserId, setTargetUserId] = useState(users[0]?.id ?? "");
  const [delta, setDelta] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revealedPhone, setRevealedPhone] = useState<{
    userId: string;
    phone: string | null;
  } | null>(null);

  async function submitAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedDelta = Number(delta);
    if (!targetUserId || !Number.isInteger(parsedDelta) || parsedDelta === 0) {
      setMessage("请选择用户并填写非零整数点数。");
      return;
    }
    if (!window.confirm(`确认将用户点数调整为 ${parsedDelta > 0 ? "+" : ""}${parsedDelta} 点？`)) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await onAdjustCredits?.({ userId: targetUserId, delta: parsedDelta, note });
      setMessage("点数调整已写入流水和审计日志。");
      setNote("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "点数调整失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: AdminUserRow) {
    const next = user.status === "active" ? "disabled" : "active";
    if (!window.confirm(`确认${next === "disabled" ? "停用" : "启用"}账号？`)) return;
    setBusy(true);
    setMessage("");
    try {
      await onSetUserStatus?.({ userId: user.id, status: next });
      setMessage(next === "disabled" ? "账号已停用。" : "账号已启用。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号状态更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function revealPhone(user: AdminUserRow) {
    if (!window.confirm("查看完整手机号会写入审计日志，是否继续？")) return;
    setBusy(true);
    setMessage("");
    try {
      const phone = (await onRevealPhone?.(user.id)) ?? null;
      setRevealedPhone({ userId: user.id, phone });
      setMessage("完整手机号已显示，并已写入 view_full_phone 审计事件。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取手机号");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-extrabold tracking-[0.22em] text-[var(--v-accent)]">
            ADMIN / 管理后台
          </p>
          <h1 className="mt-1 font-serif text-3xl font-semibold text-[var(--v-ink)]">运营总览</h1>
          <p className="mt-1 text-sm text-[var(--v-muted)]">查看账号、订单、流水并处理点数调整。</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--v-line)] px-3 py-1.5 text-xs text-[var(--v-muted)]">
          <ShieldCheck className="size-3.5 text-[var(--v-accent)]" />
          所有敏感操作写入审计
        </span>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<Users />} label="用户数" value={metrics.users.toLocaleString("zh-CN")} />
        <MetricCard
          icon={<ReceiptText />}
          label="订单数"
          value={metrics.orders.toLocaleString("zh-CN")}
        />
        <MetricCard icon={<Coins />} label="收入" value={currency(metrics.revenueCents)} />
        <MetricCard
          icon={<FileText />}
          label="生成次数"
          value={metrics.plans.toLocaleString("zh-CN")}
        />
      </div>

      {message ? (
        <div
          className="rounded-xl border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-sm text-[var(--v-muted)]"
          role="status"
        >
          {message}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <section className="overflow-hidden rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)]">
          <div className="border-b border-[var(--v-line)] px-5 py-4">
            <h2 className="font-serif text-xl text-[var(--v-ink)]">用户与点数</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-xs">
              <thead className="bg-[var(--v-soft)] text-[var(--v-muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">手机号</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">可用点数</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-[var(--v-line)]">
                    <td className="px-4 py-3 font-mono text-[var(--v-ink)]">
                      {user.phoneMasked ?? "未绑定"}
                      {revealedPhone?.userId === user.id ? (
                        <span className="ml-2 text-[var(--v-accent)]">
                          {revealedPhone.phone ?? "无"}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-[var(--v-muted)]">
                      {user.role === "admin" ? "管理员" : "普通用户"}
                    </td>
                    <td className="px-4 py-3 text-[var(--v-muted)]">{statusLabel(user.status)}</td>
                    <td className="px-4 py-3 text-[var(--v-ink)]">
                      {user.balance - user.reserved} / {user.balance}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void toggleStatus(user)}
                          className="rounded-md border border-[var(--v-line)] px-2.5 py-1.5 text-[11px] text-[var(--v-muted)] transition hover:border-[var(--v-accent)] disabled:opacity-50"
                        >
                          {user.status === "active" ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void revealPhone(user)}
                          className="rounded-md border border-[var(--v-line)] px-2.5 py-1.5 text-[11px] text-[var(--v-muted)] transition hover:border-[var(--v-accent)] disabled:opacity-50"
                        >
                          查看完整手机号
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-[var(--v-muted)]" colSpan={5}>
                      暂无用户
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-5">
          <h2 className="font-serif text-xl text-[var(--v-ink)]">调整点数</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--v-muted)]">
            正数增加、负数扣减；操作会同时写入流水和管理员审计。
          </p>
          <form className="mt-5 space-y-3" onSubmit={(event) => void submitAdjustment(event)}>
            <label className="block text-xs text-[var(--v-muted)]">
              目标用户
              <select
                className="mt-1 h-10 w-full rounded-lg border border-[var(--v-line)] bg-[var(--v-bg)] px-3 text-sm text-[var(--v-ink)]"
                value={targetUserId}
                onChange={(event) => setTargetUserId(event.target.value)}
              >
                <option value="">请选择</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.phoneMasked ?? user.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-[var(--v-muted)]">
              变更点数
              <input
                className="mt-1 h-10 w-full rounded-lg border border-[var(--v-line)] bg-[var(--v-bg)] px-3 text-sm text-[var(--v-ink)]"
                type="number"
                step="1"
                value={delta}
                onChange={(event) => setDelta(event.target.value)}
              />
            </label>
            <label className="block text-xs text-[var(--v-muted)]">
              调整原因
              <textarea
                className="mt-1 min-h-20 w-full rounded-lg border border-[var(--v-line)] bg-[var(--v-bg)] px-3 py-2 text-sm text-[var(--v-ink)]"
                value={note}
                minLength={2}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                placeholder="至少填写 2 个字符"
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-[var(--v-accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              确认调整
            </button>
          </form>
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <DataTable title="订单">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead className="bg-[var(--v-soft)] text-[var(--v-muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">套餐</th>
                <th className="px-4 py-3 font-medium">金额</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t border-[var(--v-line)]">
                  <td className="px-4 py-3 text-[var(--v-ink)]">
                    {order.packageCode} · {order.points} 点
                  </td>
                  <td className="px-4 py-3 text-[var(--v-ink)]">{currency(order.amountCents)}</td>
                  <td className="px-4 py-3 text-[var(--v-muted)]">{statusLabel(order.status)}</td>
                  <td className="px-4 py-3 text-[var(--v-muted)]">{formatDate(order.createdAt)}</td>
                </tr>
              ))}
              {orders.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--v-muted)]" colSpan={4}>
                    暂无订单
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataTable>

        <DataTable title="点数流水">
          <table className="w-full min-w-[680px] border-collapse text-left text-xs">
            <thead className="bg-[var(--v-soft)] text-[var(--v-muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">原因</th>
                <th className="px-4 py-3 font-medium">变化</th>
                <th className="px-4 py-3 font-medium">余额</th>
                <th className="px-4 py-3 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.id} className="border-t border-[var(--v-line)]">
                  <td className="px-4 py-3 text-[var(--v-ink)]">
                    {reasonLabel(entry.reason)}
                    {entry.note ? (
                      <span className="ml-2 text-[var(--v-muted)]">{entry.note}</span>
                    ) : null}
                  </td>
                  <td
                    className={`px-4 py-3 font-medium ${entry.delta >= 0 ? "text-[#35634d]" : "text-[#a54a32]"}`}
                  >
                    {entry.delta >= 0 ? "+" : ""}
                    {entry.delta}
                  </td>
                  <td className="px-4 py-3 text-[var(--v-muted)]">{entry.balanceAfter}</td>
                  <td className="px-4 py-3 text-[var(--v-muted)]">{formatDate(entry.createdAt)}</td>
                </tr>
              ))}
              {ledger.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--v-muted)]" colSpan={4}>
                    暂无流水
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataTable>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-xs leading-5 text-[var(--v-muted)]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--v-accent)]" />
        管理员只能通过受控后台调整点数；任何点数变更都必须保留原因和审计记录。
      </div>
    </section>
  );
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-4">
      <span className="grid size-9 place-items-center rounded-xl bg-[var(--v-soft)] text-[var(--v-accent)]">
        {icon}
      </span>
      <span className="mt-3 block text-xs text-[var(--v-muted)]">{label}</span>
      <strong className="mt-1 block font-serif text-2xl text-[var(--v-ink)]">{value}</strong>
    </div>
  );
}

function DataTable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)]">
      <div className="border-b border-[var(--v-line)] px-5 py-4">
        <h2 className="font-serif text-xl text-[var(--v-ink)]">{title}</h2>
      </div>
      <div className="max-h-[420px] overflow-auto">{children}</div>
    </section>
  );
}
