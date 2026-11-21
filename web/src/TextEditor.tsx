import { useState } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
export function TextEditor({node}:{node:components["schemas"]["TreeNode"]}) {
 const [open,setOpen]=useState(false),[content,setContent]=useState(""),[base,setBase]=useState(0),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);try{const {data,response}=await api.GET("/tree/{id}/text",{params:{path:{id:node.id}}});if(data){setContent(data.content);setBase(data.versionId);setOpen(true);setMessage("");}else setMessage(`无法编辑：HTTP ${response.status}`);}finally{setBusy(false)}}
 if(!(node.rights&8)||! /\.(txt|md|csv|json|xml|log|yaml|yml|toml|ini|conf)$/i.test(node.name))return null;
 return <><button disabled={busy} onClick={()=>void load()}>编辑文本</button>{open&&<section aria-label={`文本编辑 ${node.name}`}><label>文本内容<textarea value={content} onChange={e=>setContent(e.target.value)}/></label><button disabled={busy} onClick={async()=>{setBusy(true);try{const {data,response}=await api.PUT("/tree/{id}/text",{params:{path:{id:node.id}},body:{baseVersionId:base,content}});if(data){setBase(data.versionId);setMessage("已保存为新版本");}else setMessage(response.status===409?"文件已被他人修改，请先复制您的修改，重新加载后合并。":`保存失败：HTTP ${response.status}`);}finally{setBusy(false)}}}>保存文本</button><button disabled={busy} onClick={()=>void load()}>重新加载文本</button><button onClick={()=>setOpen(false)}>关闭编辑</button></section>}{message&&<p role="status">{message}</p>}</>;
}
