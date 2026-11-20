import { UploadRow, UploadPolicyEditor } from "./UploadRow";
import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function TreePanel({ administrator }: { administrator: boolean }) {
  const [path, setPath] = useState<Node[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const current = path.at(-1);
  useEffect(() => {
    let live = true;
    api
      .GET("/tree", { params: { query: { parentId: current?.id } } })
      .then(({ data, response }) => {
        if (live) {
          setNodes(data ?? []);
          if (!data) setMessage(`HTTP ${response.status}`);
        }
      });
    return () => {
      live = false;
    };
  }, [current?.id, revision]);
  async function create(form: FormData) {
    const { response } = await api.POST("/tree", {
      body: { name: String(form.get("name")), parentId: current?.id },
    });
    setMessage(response.ok ? "目录已创建" : `HTTP ${response.status}`);
    setRevision((v) => v + 1);
  }
  async function grant(form: FormData) {
    if (!current) return;
    const { response } = await api.POST("/tree/{id}/grants", {
      params: { path: { id: current.id } },
      body: {
        principalKind: form.get("kind") as
          "user" | "organization" | "user_group",
        principalId: Number(form.get("principal")),
        rights: Number(form.get("rights")),
        scope: form.get("scope") as "subtree" | "this_level_only",
      },
    });
    setMessage(response.ok ? "授权已保存" : `HTTP ${response.status}`);
    setRevision((v) => v + 1);
  }
  return (
    <section aria-label="共享目录">
      <h2>共享目录</h2>
      <div className="tree-layout">
        <nav aria-label="目录树">
          <button onClick={() => setPath([])}>共享目录</button>
          {path.map((n, i) => (
            <div key={n.id}>
              <button onClick={() => setPath(path.slice(0, i + 1))}>
                {n.name}
                {n.traversable ? "（仅通行）" : ""}
              </button>
            </div>
          ))}
        </nav>
        <div>
          <nav aria-label="目录路径">
            <button onClick={() => setPath([])}>根目录</button>
            {path.map((n, i) => (
              <button key={n.id} onClick={() => setPath(path.slice(0, i + 1))}>
                {n.name}
              </button>
            ))}
          </nav>
          {current && !(current.rights & 1) && (
            <p>此目录内容不可浏览；仅显示可访问的路径。</p>
          )}
          {current && (current.rights & 4) !== 0 && <UploadRow key={current.id} parentId={current.id} completed={() => setRevision(v => v + 1)} />}
          {administrator && <UploadPolicyEditor />}
          <ul>
            {nodes.map((n) => (
              <li key={n.id}>
                <button
                  disabled={n.isFile}
                  onClick={() => setPath([...path, n])}
                >
                  {n.name}
                </button>
                {n.traversable && "（仅通行）"}
              </li>
            ))}
          </ul>
          {((!current && administrator) ||
            (current && (current.rights & 4) !== 0)) && (
            <form action={create}>
              <label>
                目录名称
                <input name="name" required />
              </label>
              <button>创建目录</button>
            </form>
          )}
          {current && (current.rights & 32) !== 0 && (
            <form action={grant}>
              <h3>授权</h3>
              <label>
                主体类型
                <select name="kind">
                  <option value="user">用户</option>
                  <option value="organization">组织</option>
                  <option value="user_group">用户组</option>
                </select>
              </label>
              <label>
                主体 ID
                <input name="principal" type="number" min="1" required />
              </label>
              <label>
                权限
                <select name="rights">
                  <option value="1">仅浏览</option>
                  <option value="3">只读</option>
                  <option value="15">读写</option>
                  <option value="31">读写删除</option>
                  <option value="63">完全控制</option>
                  <option value="4">投递箱</option>
                </select>
              </label>
              <label>
                范围
                <select name="scope">
                  <option value="subtree">整个子树</option>
                  <option value="this_level_only">仅本层</option>
                </select>
              </label>
              <button>保存授权</button>
            </form>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </div>
    </section>
  );
}
