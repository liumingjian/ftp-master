import { useState } from "react";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function copiedItemId(hash: string) {
  const match = /^#item=(\d+)$/.exec(hash);
  return match ? Number(match[1]) : undefined;
}

export function CopyItemLink({ node }: { node: Node }) {
  const [message, setMessage] = useState("");
  return <><button onClick={async () => {
    try { const url = new URL("/", location.origin); url.hash = `item=${node.id}`; await navigator.clipboard.writeText(url.href); setMessage("链接已复制；接收者需登录并拥有权限"); }
    catch { setMessage("无法复制链接，请检查浏览器剪贴板权限"); }
  }}>复制链接</button>{message && <span role="status">{message}</span>}</>;
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
