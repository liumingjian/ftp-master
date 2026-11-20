import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];
type Grant = components["schemas"]["TreeGrantInput"];
type Source = components["schemas"]["SourcedGrant"];
const presets = [[1,"仅浏览"],[3,"只读"],[15,"读写"],[31,"读写删除"],[63,"完全控制"],[4,"投递箱"]] as const;
const rights = [[1,"浏览"],[2,"下载"],[4,"上传"],[8,"修改"],[16,"删除"],[32,"授权"]] as const;
function coherent(value: number) { if(value & 32)return 63; if(value & 8)value |= 3; if(value & 18)value |= 1; return value; }
export function GrantsPanel({ node, close }: {node: Node; close: () => void}) {
 const [sources,setSources]=useState<Source[]>([]),[add,setAdd]=useState<Grant[]>([]),[remove,setRemove]=useState<number[]>([]);
 const [value,setValue]=useState(3),[message,setMessage]=useState("");
 const [selected,setSelected]=useState(node),[children,setChildren]=useState<Node[]>([]);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{ let live=true; setAdd([]);setRemove([]);
  api.GET("/tree/{id}/grant-draft",{params:{path:{id:selected.id}}}).then(({data,response})=>{if(live){setSources(data??[]);setMessage(data?"":`HTTP ${response.status}`);}});
  api.GET("/tree",{params:{query:{parentId:selected.id}}}).then(({data})=>{if(live)setChildren(data??[]);});
  return ()=>{live=false;}; },[selected.id,revision]);
 async function save(){const {response}=await api.POST("/tree/{id}/grant-draft",{params:{path:{id:selected.id}},body:{add,remove}});setMessage(response.ok?"授权已保存":`保存失败 HTTP ${response.status}`);if(response.ok)setRevision(v=>v+1);}
 const individual=sources.filter(s=>s.grant.principalKind==="user").length+add.filter(g=>g.principalKind==="user").length;
 return <section aria-label="权限管理"><h3>权限管理：{selected.name}</h3><button onClick={close}>返回目录</button><div className="tree-layout">
 <nav aria-label="授权目录树"><button onClick={()=>setSelected(node)}>{node.name}</button>{children.map(n=><div key={n.id}><button disabled={!(n.rights&32)} onClick={()=>setSelected(n)}>{n.name}</button></div>)}<span>直接授权 {sources.filter(s=>!s.inherited).length}</span>{individual>=10&&<p role="alert">个人授权较多，建议使用组织或用户组。</p>}</nav>
 <div><table><thead><tr><th>主体</th><th>权限</th><th>范围／来源</th><th>操作</th></tr></thead><tbody>{sources.map(s=><tr key={s.grant.id}><td>{s.grant.principalKind} #{s.grant.principalId}</td><td>{rights.filter(([bit])=>s.grant.rights&bit).map(([,name])=>name).join("、")}</td><td>{s.inherited?`继承（锁定）：${s.sourcePath}`:selected.isFile?"此文件":s.grant.scope==="subtree"?"整个子树":"仅本层"}</td><td><button disabled={s.inherited||s.grant.creator} onClick={()=>setRemove(v=>v.includes(s.grant.id)?v.filter(id=>id!==s.grant.id):[...v,s.grant.id])}>{remove.includes(s.grant.id)?"撤销草稿删除":"删除授权"}</button></td></tr>)}{add.map((g,i)=><tr key={`draft${i}`}><td>{g.principalKind} #{g.principalId}</td><td>{g.rights}（待保存）</td><td>{selected.isFile?"此文件":g.scope}</td><td><button onClick={()=>setAdd(v=>v.filter((_,j)=>i!==j))}>移除草稿</button></td></tr>)}</tbody></table>
 <form action={form=>{setAdd(v=>[...v,{principalKind:form.get("kind") as Grant["principalKind"],principalId:Number(form.get("principal")),rights:value,scope:selected.isFile?"subtree":form.get("scope") as Grant["scope"]}]);}}>
 <label>主体类型<select name="kind"><option value="user">用户</option><option value="organization">组织</option><option value="user_group">用户组</option></select></label><label>主体 ID<input name="principal" type="number" min="1" required/></label>
 <label>权限<select value={value} onChange={e=>setValue(Number(e.target.value))}>{!presets.some(([v])=>v===value)&&<option value={value}>自定义</option>}{presets.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
 <fieldset><legend>权限细项</legend>{rights.map(([bit,label])=><label key={bit}><input type="checkbox" checked={!!(value&bit)} onChange={e=>{let next=e.target.checked?value|bit:value&~bit;if(!e.target.checked){if(bit===1)next&=~58;if(bit===2)next&=~40;if(bit!==32)next&=~32;}setValue(coherent(next));}}/>{label}</label>)}</fieldset>
 {!selected.isFile&&<label>范围<select name="scope"><option value="subtree">整个子树</option><option value="this_level_only">仅本层</option></select></label>}<button disabled={!value}>添加到草稿</button></form><button disabled={!add.length&&!remove.length} onClick={save}>保存全部授权</button><p role="status">{message}</p></div></div></section>;
}
