import { UploadRow, UploadPolicyEditor } from "./UploadRow";
import { useEffect, useState } from "react";
import { GrantsPanel, PermissionInspection } from "./GrantsPanel";
import { api } from "./api/client";
import type { components } from "./api/schema.gen";
type Node = components["schemas"]["TreeNode"];

export function TreePanel({ administrator }: { administrator: boolean }) {
  const [recycled,setRecycled]=useState<{id:number;originalPath:string;deletedAt:string}[]>([]);
  const [showRecycle,setShowRecycle]=useState(false);
  async function loadRecycle() { const {data}=await api.GET("/recycle-bin");setRecycled(data??[]);setShowRecycle(true); }
  async function recycleAction(id:number,action:"restore"|"purge",parentId?:number) {
    const {response}=action==="restore" ? await api.POST("/tree/{id}/restore",{params:{path:{id}},body:{parentId}}) : await api.DELETE("/tree/{id}/purge",{params:{path:{id}}});
    setMessage(response.ok ? "操作完成" : response.status===409 ? "原目录不可用或存在同名项目，请选择其他目录" : `HTTP ${response.status}`);
    await loadRecycle();setRevision(v=>v+1);
  }
  async function deleteNode(id:number) {const {response}=await api.DELETE("/tree/{id}",{params:{path:{id}}});setMessage(response.ok?"已移入回收站":`HTTP ${response.status}`);setRevision(v=>v+1);}
  const [inspectNode,setInspectNode]=useState<Node>();
  const [grantNode, setGrantNode] = useState<Node>();
  const [path, setPath] = useState<Node[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [message, setMessage] = useState("");
  const [moving, setMoving] = useState<Node>();
 const [destinations, setDestinations] = useState<Node[]>([]);
 const [destinationPath, setDestinationPath] = useState<Node[]>([]);
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
  async function rename(node: Node, form: FormData) {
    const { response } = await api.POST("/tree/{id}/rename", {params:{path:{id:node.id}},body:{name:String(form.get("name"))}});
    setMessage(response.ok ? "名称已更新" : response.status===409 ? "目标位置已有同名项目" : `HTTP ${response.status}`);
    setRevision(v=>v+1);
  }
  async function browseDestination(next: Node[]) {
    const {data} = await api.GET("/tree",{params:{query:{parentId:next.at(-1)?.id}}});
    setDestinationPath(next); setDestinations(data??[]);
  }
  async function move() {
    if (!moving) return;
    const {response}=await api.POST("/tree/{id}/move",{params:{path:{id:moving.id}},body:{parentId:destinationPath.at(-1)?.id??null}});
    setMessage(response.ok ? "项目已移动" : response.status===409 ? "目标位置已有同名项目，或目标位于自身子目录" : `HTTP ${response.status}`);
    if(response.ok) setMoving(undefined);
    setRevision(v=>v+1);
  }
  if (inspectNode) return <section><h3>{inspectNode.name}</h3><button onClick={()=>setInspectNode(undefined)}>返回目录</button><PermissionInspection node={inspectNode} administrator={administrator}/></section>;
  if (grantNode) return <GrantsPanel administrator={administrator} node={grantNode} close={() => setGrantNode(undefined)} />;
  return (
    <section aria-label="共享目录">
      <h2>共享目录</h2>
      <button onClick={()=>void loadRecycle()}>回收站</button>
      {showRecycle && <section aria-label="回收站"><h3>回收站</h3><button onClick={()=>setShowRecycle(false)}>关闭回收站</button><ul>{recycled.map(e=><li key={e.id}>{e.originalPath}<button onClick={()=>void recycleAction(e.id,"restore")}>恢复原位置</button>{administrator && <><button onClick={()=>void recycleAction(e.id,"purge")}>永久删除</button><form action={form=>recycleAction(e.id,"restore",Number(form.get("parent")))}><label>目标目录编号<input name="parent" type="number" min="1" required/></label><button>恢复到指定目录</button></form></>}</li>)}</ul></section>}
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
                {n.isFile && !!(n.rights & 2) && <a href={`/api/tree/${n.id}/download`} download>下载 {n.name}</a>}
                {!!(n.rights & 16) && <button onClick={()=>void deleteNode(n.id)}>删除 {n.name}</button>}
                {n.traversable && "（仅通行）"}
                <button onClick={()=>setInspectNode(n)}>查看有效权限</button>
                {!!(n.rights & 32) && <button onClick={() => setGrantNode(n)}>管理权限</button>}
                {(n.rights & 8)!==0 && <form action={form=>rename(n,form)}><label>新名称<input name="name" defaultValue={n.name} required maxLength={255}/></label><button>重命名</button></form>}
                {(current ? (current.rights & 16)!==0 : administrator) && <button onClick={()=>{setMoving(n);void browseDestination([]);}}>移动 {n.name}</button>}
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
            <button onClick={() => setGrantNode(current)}>管理当前权限</button>
          )}
          {moving && <section aria-label="移动目标"><h3>移动 {moving.name}</h3><button onClick={()=>void browseDestination([])}>根目录</button>{destinationPath.map((n,i)=><button key={n.id} onClick={()=>void browseDestination(destinationPath.slice(0,i+1))}>{n.name}</button>)}<ul>{destinations.filter(n=>!n.isFile && n.id!==moving.id).map(n=><li key={n.id}><button onClick={()=>void browseDestination([...destinationPath,n])}>{n.name}</button></li>)}</ul><button disabled={destinationPath.length ? !(destinationPath.at(-1)!.rights & 4) : !administrator} onClick={()=>void move()}>移动到此目录</button><button onClick={()=>setMoving(undefined)}>取消</button></section>}
          {message && <p role="status">{message}</p>}
        </div>
      </div>
    </section>
  );
}
