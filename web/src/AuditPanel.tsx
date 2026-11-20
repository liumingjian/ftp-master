import { useState } from "react";
import { api } from "./api/client";
import { useRequestOnMount } from "./requestOnMount";

type Event = {
  id: number;
  time: string;
  userId: number | null;
  username: string;
  sourceIp: string;
  action: string;
  outcome: string;
  itemId: number | null;
  path: string;
  detail: unknown;
};
type Results = {
  events: Event[];
  total: number;
  page: number;
  directories: { path: string; exists: boolean }[];
};
export function AuditPanel() {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [users, setUsers] = useState(""),
    [org, setOrg] = useState(""),
    [directory, setDirectory] = useState(""),
    [action, setAction] = useState(""),
    [category, setCategory] = useState(""),
    [recursive, setRecursive] = useState(true),
    [failures, setFailures] = useState(false),
    [item, setItem] = useState<number>(),
    [result, setResult] = useState<Results>(),
    [detail, setDetail] = useState<Event>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const people = useRequestOnMount<{ id: number; username: string }[]>(
    [],
    async () => {
      const { data } = await api.GET("/managed-users");
      return data ?? [];
    },
  );
  const organizations = useRequestOnMount<{ id: number; name: string }[]>(
    [],
    async () => {
      const { data } = await api.GET("/organizations");
      return data ?? [];
    },
  );
  useRequestOnMount(null, async () => {
    const { data } = await api.GET("/health");
    if (data) {
      setFrom(data.checkedAt.slice(0, 10) + "T00:00");
      setTo(data.checkedAt.slice(0, 16));
    }
    return null;
  });
  async function query(
    page = 1,
    exportCSV = false,
    pivot?: { userId?: number; directory?: string; itemId?: number },
  ) {
    setBusy(true);
    setError("");
    try {
      const body = {
        from: from + ":00Z",
        to: to + ":00Z",
        userIds: pivot?.itemId
          ? []
          : pivot?.userId
            ? [pivot.userId]
            : users.split(",").filter(Boolean).map(Number),
        organizationId:
          pivot?.itemId || pivot?.userId
            ? undefined
            : org
              ? Number(org)
              : undefined,
        directory: pivot?.directory ?? directory,
        action: pivot?.itemId ? "" : action,
        category: pivot?.itemId ? undefined : category || undefined,
        includeSubdirectories: recursive,
        failuresOnly: pivot?.itemId ? false : failures,
        itemId: pivot?.itemId ?? item,
        page,
        export: exportCSV,
      };
      const response = await fetch("/api/audit/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(
          response.status === 400
            ? "时间范围必须精确到分钟且不超过 180 天"
            : "查询失败（" + response.status + "）",
        );
        return;
      }
      if (exportCSV) {
        const url = URL.createObjectURL(await response.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = "audit.csv";
        a.click();
        URL.revokeObjectURL(url);
      } else setResult((await response.json()) as Results);
    } catch {
      setError("无法连接服务");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="审计记录" className="panel">
      <h2>审计记录</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void query();
        }}
      >
        <label>
          开始时间（UTC）
          <input
            type="datetime-local"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束时间（UTC）
          <input
            type="datetime-local"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          人员
          <select
            multiple
            value={users.split(",")}
            onChange={(e) => {
              setUsers(
                Array.from(e.target.selectedOptions, (x) => x.value).join(","),
              );
              setOrg("");
            }}
          >
            {Array.isArray(people) &&
              people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
          </select>
        </label>
        <label>
          组织（含下级）
          <select
            value={org}
            onChange={(e) => {
              setOrg(e.target.value);
              setUsers("");
            }}
          >
            <option value="">全部组织</option>
            {Array.isArray(organizations) &&
              organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          历史目录
          <input
            list="audit-directories"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
          />
        </label>
        <datalist id="audit-directories">
          {result?.directories.map((d) => (
            <option key={d.path} value={d.path}>
              {d.exists ? "当前目录" : "已不存在"}
            </option>
          ))}
        </datalist>
        <label>
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />
          包含子目录
        </label>
        <label>
          动作类别
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              ["", "全部动作"],
              ["session", "登录"],
              ["read", "查看与下载"],
              ["write", "上传与修改"],
              ["delete", "删除与恢复"],
              ["grant", "授权变更"],
              ["account", "账户"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          动作
          <input
            value={action}
            placeholder="例如 rename、download"
            onChange={(e) => setAction(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={failures}
            onChange={(e) => setFailures(e.target.checked)}
          />
          仅失败
        </label>
        {item !== undefined && (
          <p>
            项目历史：{item}{" "}
            <button type="button" onClick={() => setItem(undefined)}>
              清除项目筛选
            </button>
          </p>
        )}
        <button disabled={busy}>查询审计</button>
        <button
          type="button"
          disabled={busy || !from || !to}
          onClick={() => void query(1, true)}
        >
          导出 CSV
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p role="status">
            共 {result.total} 条记录，第 {result.page} 页
          </p>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>人员</th>
                <th>动作</th>
                <th>历史路径</th>
                <th>结果</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {result.events.map((e) => (
                <tr key={e.time + "-" + e.id}>
                  <td>{e.time}</td>
                  <td>{e.username}</td>
                  <td>{e.action}</td>
                  <td>{e.path}</td>
                  <td>{e.outcome === "success" ? "成功" : "失败"}</td>
                  <td>
                    <button onClick={() => setDetail(e)}>查看详情</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            disabled={busy || result.page <= 1}
            onClick={() => void query(result.page - 1)}
          >
            上一页
          </button>
          <button
            disabled={busy || result.page * 50 >= result.total}
            onClick={() => void query(result.page + 1)}
          >
            下一页
          </button>
        </>
      )}
      {detail && (
        <aside aria-label="审计详情">
          <button onClick={() => setDetail(undefined)}>关闭详情</button>
          <p>
            {detail.username} · {detail.time} · {detail.sourceIp}
          </p>
          <p>
            {detail.action} · {detail.outcome === "success" ? "成功" : "失败"} ·
            项目 {detail.itemId ?? "—"}
          </p>
          <p>{detail.path}</p>
          <pre>{JSON.stringify(detail.detail, null, 2)}</pre>
          {detail.userId !== null && (
            <button
              onClick={() => {
                setUsers(String(detail.userId));
                setOrg("");
                void query(1, false, { userId: detail.userId! });
              }}
            >
              仅此人员
            </button>
          )}
          {detail.path && (
            <button
              onClick={() => {
                const d =
                  detail.path.slice(0, detail.path.lastIndexOf("/")) || "/";
                setDirectory(d);
                void query(1, false, { directory: d });
              }}
            >
              仅此目录
            </button>
          )}
          {detail.itemId !== null && (
            <button
              onClick={() => {
                setItem(detail.itemId!);
                setUsers("");
                setOrg("");
                setAction("");
                setCategory("");
                setFailures(false);
                setDirectory("");
                void query(1, false, { itemId: detail.itemId!, directory: "" });
              }}
            >
              此项目完整历史
            </button>
          )}
        </aside>
      )}
    </section>
  );
}
