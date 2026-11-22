import { useState, type FormEvent } from "react";
import { AuthLayout } from "./AuthLayout";
import { PasswordInput } from "./PasswordInput";
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
    <AuthLayout title={done ? "申请已提交" : "注册"} description={done ? undefined : "提交后由管理员审批，通过后即可登录"}
      onSubmit={submit} footer={<a href="/sign-in">返回登录</a>}>
        {done ? (
          <p className="banner success" role="status">注册已提交，等待管理员审批</p>
        ) : (
          <>
            <label>
              姓名
              <input name="displayName" required maxLength={150} autoComplete="name" />
            </label>
            <label>
              用户名
              <input
                name="username"
                required
                maxLength={150}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              所属组织说明
              <input name="organizationHint" required maxLength={150} />
            </label>
            <PasswordInput name="password" required maxLength={1024} autoComplete="new-password" />
            {error && <p className="banner error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "正在提交…" : "提交注册"}</button>
          </>
        )}
    </AuthLayout>
  );
}
