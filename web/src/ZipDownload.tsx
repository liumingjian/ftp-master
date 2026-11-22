import { useState } from "react";

export function ZipDownload({ selected }: { selected: number[] }) {
  const [tooLarge, setTooLarge] = useState(false);
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
    <button className="primary" onClick={() => void download()}>打包下载所选项目</button>
    {tooLarge && <p role="alert">所选可下载文件超过 10 GB，请减少选择后重试。</p>}
  </section>;
}
