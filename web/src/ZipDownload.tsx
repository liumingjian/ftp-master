import { useEffect, useState } from "react";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function ZipDownload({ nodes }: { nodes: Node[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [tooLarge, setTooLarge] = useState(false);
  useEffect(() => { setSelected([]); setTooLarge(false); }, [nodes]);
  async function download() {
    const url = `/api/tree/zip?ids=${selected.join(",")}`;
    setTooLarge(false);
    const response = await fetch(`${url}&preflight=true`, { credentials: "same-origin" });
    if (response.status === 413) { setTooLarge(true); return; }
    if (!response.ok) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = "download.zip";
    link.click();
  }
  return <section aria-label="打包下载">
    {nodes.map(node => <label key={node.id}><input type="checkbox" checked={selected.includes(node.id)}
      onChange={event => setSelected(ids => event.target.checked ? [...ids, node.id] : ids.filter(id => id !== node.id))}/>{node.name}</label>)}
    <button disabled={!selected.length} onClick={() => void download()}>打包下载所选项目</button>
    {tooLarge && <p role="alert">所选可下载文件超过 10 GB，请减少选择后重试。</p>}
  </section>;
}
