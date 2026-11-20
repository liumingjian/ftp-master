import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function BrowseTools({ navigate }: { navigate: (node: Node) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Node[]>([]);
  const [selected, setSelected] = useState<Node>();
  const [message, setMessage] = useState("");
  function open(node: Node) { if (node.isFile) setSelected(node); else navigate(node); }
  useEffect(() => {
    async function resolve() {
      const match = /^#item=(\d+)$/.exec(location.hash);
      if (!match) return;
      const { data, response } = await api.GET("/tree/{id}", { params: { path: { id: Number(match[1]) } } });
      if (data) open(data); else setMessage(response.status === 404 ? "项目不存在或无权访问" : `HTTP ${response.status}`);
    }
    void resolve(); window.addEventListener("hashchange", resolve);
    return () => window.removeEventListener("hashchange", resolve);
  }, []);
  return <section aria-label="搜索和预览">
    <form action={async () => {
      const { data, response } = await api.GET("/tree/search", { params: { query: { q: query } } });
      setResults(data ?? []); setMessage(response.ok ? (data?.length ? "" : "没有匹配文件") : `HTTP ${response.status}`);
    }}><label>按文件名搜索<input value={query} onChange={e => setQuery(e.target.value)} required maxLength={255}/></label><button>搜索</button></form>
    <ul>{results.map(node => <li key={node.id}><button onClick={() => open(node)}>{node.name}</button><CopyItemLink node={node}/></li>)}</ul>
    {selected && <section aria-label="文件预览"><button onClick={() => setSelected(undefined)}>关闭预览</button><Preview node={selected}/></section>}
    {message && <p role="status">{message}</p>}
  </section>;
}
export function CopyItemLink({ node }: { node: Node }) {
  const [message, setMessage] = useState("");
  return <><button onClick={async () => {
    try { const url = new URL(location.href); url.hash = `item=${node.id}`; await navigator.clipboard.writeText(url.href); setMessage("链接已复制；接收者需登录并拥有权限"); }
    catch { setMessage("无法复制链接，请检查浏览器剪贴板权限"); }
  }}>复制链接</button>{message && <span role="status">{message}</span>}</>;
}
export function PreviewButton({ node }: { node: Node }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(!open)}>{open ? "关闭预览" : "预览"}</button>{open && <Preview node={node}/>}</>;
}
function Preview({ node }: { node: Node }) {
  const ext = node.name.split(".").at(-1)?.toLowerCase() ?? "";
  const src = `/api/tree/${node.id}/preview`;
  if (!(node.rights & 1)) return <p>无浏览权限</p>;
  if (["png","jpg","jpeg","gif","webp","avif","bmp"].includes(ext)) return <img src={src} alt={node.name} style={{maxWidth:"100%"}}/>;
  if (["mp3","wav","ogg","m4a"].includes(ext)) return <audio controls src={src}/>;
  if (["mp4","webm","mov"].includes(ext)) return <video controls src={src} style={{maxWidth:"100%"}}/>;
  if (["pdf","txt","csv","log","md","json","xml"].includes(ext)) return <iframe title={`预览 ${node.name}`} src={src} sandbox={ext === "pdf" ? undefined : ""} style={{width:"100%",height:480}}/>;
  return <p>此文件类型不支持预览</p>;
}
