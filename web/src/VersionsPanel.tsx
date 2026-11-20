import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];
export function VersionsPanel({ node, close }: { node: Node; close: () => void }) {
  const [versions, setVersions] = useState<components["schemas"]["FileVersion"][]>([]);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    void api.GET("/tree/{id}/versions", { params: { path: { id: node.id } } }).then(({ data, response }) => {
      if (live) { setVersions(data ?? []); if (!response.ok) setMessage(`HTTP ${response.status}`); }
    });
    return () => { live = false; };
  }, [node.id, revision]);
  async function restore(versionId: number) {
    const { response } = await api.POST("/tree/{id}/versions/{versionId}/restore", { params: { path: { id: node.id, versionId } } });
    setMessage(response.ok ? "已恢复为新版本" : `HTTP ${response.status}`);
    setRevision(v => v + 1);
  }
  return <section aria-label="文件版本"><h3>{node.name}：文件版本</h3><button onClick={close}>返回目录</button>
    <ol>{versions.map(v => <li key={v.id}>版本 {v.id} · {v.username} · {new Date(v.createdAt).toLocaleString()} · {v.size} 字节
      {!!(node.rights & 2) && <a href={`/api/tree/${node.id}/download?versionId=${v.id}`} download>下载此版本</a>}
      {!!(node.rights & 8) && <button onClick={() => void restore(v.id)}>恢复为新版本</button>}
    </li>)}</ol>{message && <p role="status">{message}</p>}</section>;
}
