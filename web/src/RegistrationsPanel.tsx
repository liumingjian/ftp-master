import { useState, useEffect } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
export function RegistrationsPanel() {
  const [rows, setRows] = useState<components["schemas"]["Registration"][]>([]);
  const [organizations, setOrganizations] = useState<
    components["schemas"]["Organization"][]
  >([]);
  const [error, setError] = useState("");
  async function load() {
    try {
      const [r, o] = await Promise.all([
        api.GET("/registrations"),
        api.GET("/organizations"),
      ]);
      if (r.data && o.data) {
        setRows(r.data);
        setOrganizations(o.data);
      } else setError("无法加载注册申请");
    } catch {
      setError("无法连接服务器");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function process(
    id: number,
    action: "activate" | "reject",
    organizationId: number,
  ) {
    setError("");
    try {
      const { response } =
        action === "activate"
          ? await api.POST("/registrations/{id}/activate", {
              params: { path: { id } },
              body: { organizationId },
            })
          : await api.POST("/registrations/{id}/reject", {
              params: { path: { id } },
            });
      if (response.ok) await load();
      else setError("处理失败，请刷新后重试");
    } catch {
      setError("无法连接服务器");
    }
  }
  return (
    <section aria-label="注册审批">
      <h2>待审批注册</h2>
      {error && <p role="alert">{error}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void process(
                  r.id,
                  "activate",
                  Number(new FormData(e.currentTarget).get("organizationId")),
                );
              }}
            >
              {r.displayName}（{r.username}）— {r.organizationHint}
              <label>
                分配组织
                <select name="organizationId" required defaultValue="">
                  <option value="">请选择组织</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <button>激活</button>
              <button
                type="button"
                onClick={() => void process(r.id, "reject", 0)}
              >
                拒绝
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
