import { useState, type FormEvent } from "react";
import { api } from "./api/client";
export function RegistrationPage() {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const { response } = await api.POST("/registrations", {
        body: {
          username: String(f.get("username")),
          displayName: String(f.get("displayName")),
          organizationHint: String(f.get("organizationHint")),
          password: String(f.get("password")),
        },
      });
      if (response.ok) setDone(true);
      else
        setError(
          response.status === 409
            ? "用户名已被使用"
            : "注册失败，请检查填写内容",
        );
    } catch {
      setError("无法连接服务器");
    }
    setBusy(false);
  }
  return (
    <div className="sign-in">
      <form className="sign-in-form" onSubmit={submit}>
        <h1>注册</h1>
        {done ? (
          <p role="status">注册已提交，等待管理员审批。</p>
        ) : (
          <>
            <label>
              姓名
              <input name="displayName" required maxLength={150} />
            </label>
            <label>
              用户名
              <input
                name="username"
                required
                maxLength={150}
                autoComplete="username"
              />
            </label>
            <label>
              所属组织说明
              <input name="organizationHint" required maxLength={150} />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                maxLength={1024}
                autoComplete="new-password"
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button disabled={busy}>提交注册</button>
          </>
        )}
        <a href="/sign-in">返回登录</a>
      </form>
    </div>
  );
}
