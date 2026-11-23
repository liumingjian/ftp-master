import { useState } from "react";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function copiedItemId(hash: string) {
  const match = /^#item=(\d+)$/.exec(hash);
  return match ? Number(match[1]) : undefined;
}

export function CopyItemLink({ node }: { node: Node }) {
  const [message, setMessage] = useState("");
  return <div className="detail-share"><button aria-describedby={`share-note-${node.id}`} onClick={async () => {
    try { const url = new URL("/", location.origin); url.hash = `item=${node.id}`; await navigator.clipboard.writeText(url.href); setMessage("链接已复制"); }
    catch { setMessage("无法复制链接，请检查浏览器剪贴板权限"); }
  }}>复制链接</button><small id={`share-note-${node.id}`}>仅已有访问权限的人可打开链接</small>
    {message && <small role="status">{message}</small>}</div>;
}
export function previewKind(node: Node) {
  if (!node.isFile || !(node.rights & 1)) return undefined;
  const format = node.latestVersion?.format.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(format)) return "image";
  if (["mp3", "wav", "ogg", "m4a"].includes(format)) return "audio";
  if (["mp4", "webm", "mov"].includes(format)) return "video";
  if (format === "pdf") return "pdf";
  if (["txt", "csv", "log", "md", "json", "xml"].includes(format)) return "text";
}
