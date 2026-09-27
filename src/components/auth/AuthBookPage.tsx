import { type FormEvent, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Check, LockKeyhole, ShieldCheck, Sparkles, WalletCards } from "lucide-react";
import { authClient, authEnabled } from "@/lib/auth/client";
import { isValidPhone, normalizePhone } from "@/lib/auth/phone";
import { registerWithPhone } from "@/lib/auth/public.functions";
import "./AuthBookPage.css";

type AuthMode = "login" | "register";

type AuthBookPageProps = {
  returnTo?: string;
};

export function safeReturnTo(value?: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value === "/auth" || value.startsWith("/auth?")) return "/";
  return value;
}

function readableAuthError(error: unknown, mode: AuthMode): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message)
        : "";
  if (/already|已存在|unique|duplicate/i.test(message)) {
    return "该手机号已经注册，请直接登录。";
  }
  if (/password|密码|credential|invalid/i.test(message)) {
    return mode === "login" ? "手机号或密码不正确。" : "密码不符合要求。";
  }
  if (/手机号|phone|username|邮箱/.test(message)) return message;
  return mode === "login" ? "登录失败，请稍后再试。" : "注册失败，请稍后再试。";
}

export function AuthBookPage({ returnTo }: AuthBookPageProps) {
  const register = useServerFn(registerWithPhone);
  const [mode, setMode] = useState<AuthMode>("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ title: string; copy: string } | null>(null);
  const destination = useMemo(() => safeReturnTo(returnTo), [returnTo]);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError("");
    setSuccess(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      setError("请输入合法的 11 位中国大陆手机号。");
      return;
    }
    if (password.length < 8) {
      setError("密码至少需要 8 位。");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    if (mode === "register" && !agreed) {
      setError("请先确认服务条款和未验证手机号说明。");
      return;
    }

    setPending(true);
    try {
      if (mode === "register") {
        await register({ data: { phone: normalizedPhone, password } });
      }

      const { error: signInError } = await authClient.signIn.username({
        username: normalizedPhone,
        password,
      });
      if (signInError) throw new Error(signInError.message ?? "登录失败");

      if (mode === "register") {
        setSuccess({
          title: "账号已创建",
          copy: "钱包已经准备好，首次完整体验仍然免费。",
        });
        window.setTimeout(() => window.location.assign(destination), 650);
      } else {
        window.location.assign(destination);
      }
    } catch (err) {
      setError(readableAuthError(err, mode));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-book-page">
      <div className="auth-book-shell">
        <header className="auth-book-top">
          <a className="auth-book-brand" href="/" aria-label="返回你好，徐霞客首页">
            <span className="auth-book-seal">徐</span>
            <span>
              <strong>你好，徐霞客</strong>
              <small>XU XIAKE · TRAVEL BUTLER</small>
            </span>
          </a>
          <a className="auth-book-top-link" href={destination}>
            <ArrowLeft size={14} />
            返回上一步
          </a>
        </header>

        <div className="auth-book-layout">
          <section className="auth-book-story" aria-labelledby="auth-story-title">
            <div className="auth-book-eyebrow">ACCOUNT / 行旅账号</div>
            <h1 id="auth-story-title">把每一段路，收进自己的行囊。</h1>
            <p>
              登录后，点数、订单、行程和分享链接都会归到同一个账号。换设备登录，也能继续查看已经完成的路书。
            </p>

            <div className="auth-book-route" aria-hidden="true">
              <svg viewBox="0 0 620 190" preserveAspectRatio="none">
                <path d="M52 126 C132 25 218 36 302 88 S478 156 568 112" />
              </svg>
              <span className="auth-book-dot auth-book-dot-a">北<small>出发地</small></span>
              <span className="auth-book-dot auth-book-dot-b">途<small>沿途停靠</small></span>
              <span className="auth-book-dot auth-book-dot-c">远<small>抵达远方</small></span>
            </div>

            <div className="auth-book-story-notes">
              <div><b>账号归集</b><span>点数、订单与路书都归到同一个账号</span></div>
              <div><b>跨设备找回</b><span>换手机登录后仍可继续使用</span></div>
              <div><b>分享不收费</b><span>同行者打开链接即可查看路书</span></div>
            </div>
          </section>

          <section className="auth-book-card" aria-live="polite">
            {success ? (
              <div className="auth-book-success">
                <div className="auth-book-success-mark"><Check size={30} /></div>
                <h2>{success.title}</h2>
                <p>{success.copy}</p>
                <a className="auth-book-primary" href={destination}>继续查看路书</a>
              </div>
            ) : (
              <>
                <div className="auth-book-eyebrow">ACCOUNT / 行旅账号</div>
                <h2>{mode === "login" ? "登录后，继续出发。" : "创建你的行旅账号。"}</h2>
                <p>首次使用会直接创建账号。登录后可将点数、订单与路书保存到同一账号。</p>

                <div className="auth-book-tabs" role="tablist" aria-label="登录或注册">
                  <button className={`auth-book-tab ${mode === "login" ? "is-active" : ""}`} type="button" onClick={() => switchMode("login")} role="tab" aria-selected={mode === "login"}>登录</button>
                  <button className={`auth-book-tab ${mode === "register" ? "is-active" : ""}`} type="button" onClick={() => switchMode("register")} role="tab" aria-selected={mode === "register"}>注册</button>
                </div>

                <form className="auth-book-form" onSubmit={submit}>
                  <label className="auth-book-field">
                    <span>手机号</span>
                    <div className="auth-book-control">
                      <span className="auth-book-prefix">+86</span>
                      <input
                        name="phone"
                        type="tel"
                        inputMode="numeric"
                        autoComplete="tel"
                        maxLength={11}
                        placeholder="请输入 11 位手机号"
                        value={phone}
                        onChange={(event) => setPhone(normalizePhone(event.target.value).slice(0, 11))}
                        required
                      />
                    </div>
                    <small className="auth-book-hint">手机号不会发送短信验证，仅作为登录账号。</small>
                  </label>

                  <label className="auth-book-field">
                    <span>密码</span>
                    <div className="auth-book-control">
                      <LockKeyhole size={16} color="var(--auth-muted)" />
                      <input
                        name="password"
                        type="password"
                        minLength={8}
                        autoComplete={mode === "login" ? "current-password" : "new-password"}
                        placeholder={mode === "login" ? "请输入密码" : "至少 8 位字符"}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                    </div>
                  </label>

                  {mode === "register" ? (
                    <label className="auth-book-field">
                      <span>确认密码</span>
                      <div className="auth-book-control">
                        <ShieldCheck size={16} color="var(--auth-muted)" />
                        <input
                          name="confirmPassword"
                          type="password"
                          minLength={8}
                          autoComplete="new-password"
                          placeholder="再次输入密码"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          required
                        />
                      </div>
                    </label>
                  ) : null}

                  {mode === "register" ? (
                    <label className="auth-book-agree">
                      <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
                      <span>我已阅读并同意服务条款与隐私政策，知悉当前手机号不进行短信验证。</span>
                    </label>
                  ) : (
                    <div className="auth-book-micro">
                      <Sparkles size={15} />
                      <span><b>无需验证码</b>：当前版本不发送短信；忘记密码暂不支持自助找回。</span>
                    </div>
                  )}

                  {error ? <p className="auth-book-error" role="alert">{error}</p> : null}

                  <button className="auth-book-primary" type="submit" disabled={pending || !authEnabled}>
                    {pending ? "正在处理…" : mode === "login" ? "登录并继续" : "创建账号并继续"}
                  </button>

                  <div className="auth-book-micro">
                    <WalletCards size={15} />
                    <span><b>首次完整体验免费</b>：新账号创建后，第一次保存、下载或分享不会消耗点数。</span>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
