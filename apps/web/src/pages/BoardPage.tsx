import {useEffect, useState} from 'react';
import {useInfiniteQuery, useQuery, useQueryClient} from '@tanstack/react-query';
import {useNavigate, useParams} from 'react-router-dom';
import type {KanbanLane, KanbanTicket, TicketDetail, TicketInput, TicketType, TicketPriority, TicketPerson, TicketComment} from '@banana-chat/shared';
import {ticketKey, deadlineState} from '@banana-chat/chat-core';
import {endpoints} from '../lib/api';
import {useSession} from '../state/session';
import {useEcho} from '../echo/EchoProvider';
import {Avatar, Icon} from '../components/Visual';
import {Markdown} from '../components/ai/Markdown';

/** TASK-WEB-041: shared workspace board; remount drafts at the workspace boundary. */
export function BoardPage() {
  const workspace=useSession(s=>s.currentWorkspace);
  return workspace ? <Board key={workspace.workspace.id} slug={workspace.workspace.slug} name={workspace.workspace.name} wid={workspace.workspace.id}/> : null;
}
function Board({slug,name,wid}:{slug:string;name:string;wid:string}) {
  const me=useSession(s=>s.me)!;
  const navigate=useNavigate(), {ticketId}=useParams();
  const qc=useQueryClient(), {echo}=useEcho();
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
  const [search,setSearch]=useState(''),[mine,setMine]=useState(false),[priority,setPriority]=useState('');
  const [creating,setCreating]=useState(false),[lanesOpen,setLanesOpen]=useState(false),[error,setError]=useState(''),[moving,setMoving]=useState(false);
  const key=['kanban',wid,me.id];
  const board=useQuery({queryKey:[...key,'lanes'],queryFn:()=>endpoints.board(slug),refetchInterval:30000});
  const tickets=useInfiniteQuery({queryKey:[...key,'tickets',search,mine,priority],initialPageParam:'',queryFn:({pageParam})=>endpoints.boardTickets(slug,{q:search,assignee:mine?'me':'',priority,cursor:pageParam}),getNextPageParam:p=>p.next_cursor??undefined,refetchInterval:30000});
  const detail=useQuery({queryKey:[...key,'ticket',ticketId],queryFn:()=>endpoints.boardTicket(slug,ticketId!),enabled:!!ticketId});
  const people=useInfiniteQuery({queryKey:[...key,'people'],initialPageParam:'',queryFn:({pageParam})=>endpoints.directoryPage(slug,'',pageParam),getNextPageParam:p=>p.next_cursor??undefined});
  const members=people.data?.pages.flatMap(p=>p.members)??[];
  const refresh=()=>qc.invalidateQueries({queryKey:key});
  useEffect(()=>{
    if(!echo)return;
    const channel=echo.private(`workspace.${wid}`), changed=()=>{void qc.invalidateQueries({queryKey:['kanban',wid]});};
    channel.listen('.board.changed',changed);
    return ()=>{channel.stopListening('.board.changed',changed);};
  },[echo,wid,qc]);
  const lanes=board.data?.lanes??[], rows=tickets.data?.pages.flatMap(p=>p.tickets)??[];
  async function move(ticket:KanbanTicket,lane_id:string) {
    if(moving||ticket.lane_id===lane_id)return;
    setMoving(true);setError('');
    try {await endpoints.updateTicket(slug,ticket.id,{lane_id,version:ticket.version});await refresh();}
    catch(e){setError(e instanceof Error?e.message:'Unable to move ticket');void refresh();}
    finally{setMoving(false);}
  }
  return <section className="bc-board">
    <header className="bc-board-header"><div><span className="bc-eyebrow">{name} / WORKSPACE</span><h1>Board<span>.</span></h1><p>A shared view of what’s next.</p></div><div className="bc-board-actions">{board.data?.can_manage&&<button onClick={()=>setLanesOpen(true)} className="bc-board-secondary">Manage lanes</button>}<button className="bc-primary" disabled={!lanes.length} onClick={()=>setCreating(true)}>+ Create ticket</button></div></header>
    <div className="bc-board-toolbar"><label><Icon name="search" size={16}/><input aria-label="Search tickets" placeholder="Search title or ticket number" value={search} onChange={e=>setSearch(e.target.value)}/></label><button className={mine?'selected':''} aria-pressed={mine} onClick={()=>setMine(!mine)}>Assigned to me</button><select aria-label="Filter priority" value={priority} onChange={e=>setPriority(e.target.value)}><option value="">All priorities</option>{['urgent','high','medium','low'].map(p=><option key={p}>{p}</option>)}</select><span>{rows.length}{tickets.hasNextPage?'+':''} tickets</span></div>
    {(error||board.error||tickets.error)&&<p role="alert" className="bc-board-error">{error||board.error?.message||tickets.error?.message} <button onClick={()=>void refresh()}>Reload board</button></p>}
    {(board.isLoading||tickets.isLoading)&&<p>Loading board…</p>}
    <div className="bc-board-lanes">{lanes.map(lane=><section className="bc-board-lane" key={lane.id} aria-label={`${lane.name} lane`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const t=rows.find(t=>t.id===e.dataTransfer.getData('text/plain'));if(t)void move(t,lane.id);}}>
      <header><i style={{background:lane.color}}/><h2>{lane.name}</h2><span>{rows.filter(t=>t.lane_id===lane.id).length}</span>{lane.is_done&&<small>✓</small>}</header>
      <div className="bc-board-cards">{rows.filter(t=>t.lane_id===lane.id).map(ticket=><article key={ticket.id} className="bc-ticket-card" draggable={!moving} onDragStart={e=>e.dataTransfer.setData('text/plain',ticket.id)}>
        <button className="bc-ticket-open" onClick={()=>navigate(`/board/${ticket.id}`)}><div className="bc-ticket-meta"><span>{ticketKey(slug,ticket.number)}</span><b className={`priority-${ticket.priority}`}>{ticket.priority}</b></div><h3>{ticket.title}</h3><div className="bc-ticket-labels">{ticket.labels.map(l=><span key={l}>{l}</span>)}</div></button>
        <div className="bc-ticket-bottom"><span className={`bc-ticket-type type-${ticket.type}`}>{ticket.type==='bug'?'◈':ticket.type==='story'?'▣':'✓'} {ticket.type}</span>{ticket.assignee?<span title={`Assigned to ${ticket.assignee.display_name}`}><Avatar name={ticket.assignee.display_name}/></span>:<small>Unassigned</small>}</div>
        {ticket.due_at&&<span className={`bc-ticket-due ${deadlineState(ticket.due_at,lane.is_done,now)}`}>{deadlineState(ticket.due_at,lane.is_done,now)==='overdue'?'Overdue · ':''}{new Date(ticket.due_at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>}
        <select aria-label={`Move ${ticketKey(slug,ticket.number)}`} value={ticket.lane_id} disabled={moving} onChange={e=>void move(ticket,e.target.value)}>{lanes.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>
      </article>)}{!rows.some(t=>t.lane_id===lane.id)&&<div className="bc-lane-empty">No tickets here</div>}</div>
    </section>)}</div>
    {tickets.hasNextPage&&<button className="bc-board-secondary" disabled={tickets.isFetchingNextPage} onClick={()=>void tickets.fetchNextPage()}>Load more tickets</button>}
    {creating&&<TicketEditor slug={slug} lanes={lanes} members={members} morePeople={people.hasNextPage?()=>void people.fetchNextPage():undefined} onClose={()=>setCreating(false)} onSaved={async t=>{setCreating(false);await refresh();navigate(`/board/${t.id}`);}}/>}
    {ticketId&&<div className="bc-ticket-overlay"><button className="bc-ticket-shade" aria-label="Close ticket" onClick={()=>navigate('/board')}/><aside className="bc-ticket-drawer" role="dialog" aria-label="Ticket details" aria-modal="true"><button className="bc-ticket-close" onClick={()=>navigate('/board')}>Close ✕</button>{detail.isLoading?<p>Loading ticket…</p>:detail.error?<p role="alert">{detail.error.message}</p>:detail.data&&<TicketDetails key={ticketId} ticket={detail.data} slug={slug} lanes={lanes} members={members} morePeople={people.hasNextPage?()=>void people.fetchNextPage():undefined} refresh={refresh}/>}</aside></div>}
    {lanesOpen&&<LaneSettings slug={slug} lanes={lanes} onClose={()=>setLanesOpen(false)} refresh={refresh}/>}
  </section>;
}

function TicketEditor({slug,lanes,members,ticket,onClose,onSaved,morePeople}:{slug:string;lanes:KanbanLane[];members:TicketPerson[];ticket?:TicketDetail;onClose:()=>void;onSaved:(ticket:KanbanTicket)=>void|Promise<void>;morePeople?:()=>void}) {
  const [input,setInput]=useState<TicketInput>({title:ticket?.title??'',description:ticket?.description??'',lane_id:ticket?.lane_id??lanes[0]?.id??'',type:ticket?.type??'task',priority:ticket?.priority??'medium',assignee_id:ticket?.assignee_id??null,labels:ticket?.labels??[],due_at:ticket?.due_at??null});
  const [version]=useState(ticket?.version),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [labels,setLabels]=useState(ticket?.labels.join(', ')??'');
  const [due,setDue]=useState(()=>ticket?.due_at?localDate(ticket.due_at):'');
  const patch=(data:Partial<TicketInput>)=>setInput({...input,...data});
  useEffect(()=>{const fn=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn);},[onClose]);
  const form=<form className="bc-ticket-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const data={...input,labels:labels.split(',').map(s=>s.trim()).filter(Boolean),due_at:due?new Date(due).toISOString():null};const result=ticket?await endpoints.updateTicket(slug,ticket.id,{...data,version:version!}):await endpoints.createTicket(slug,data);await onSaved(result);}catch(err){setError(err instanceof Error?err.message:'Unable to save ticket');}finally{setBusy(false);}}}>
    <h2>{ticket?'Edit ticket':'Create ticket'}</h2><label>Title<input autoFocus required maxLength={200} value={input.title} onChange={e=>patch({title:e.target.value})}/></label><label>Description<textarea rows={6} maxLength={20000} placeholder="What needs to happen? Markdown supported." value={input.description??''} onChange={e=>patch({description:e.target.value})}/></label>
    <div className="bc-ticket-fields"><label>Status<select aria-label="Status" value={input.lane_id} onChange={e=>patch({lane_id:e.target.value})}>{lanes.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label>Type<select aria-label="Type" value={input.type} onChange={e=>patch({type:e.target.value as TicketType})}>{['task','bug','story'].map(t=><option key={t}>{t}</option>)}</select></label><label>Priority<select aria-label="Priority" value={input.priority} onChange={e=>patch({priority:e.target.value as TicketPriority})}>{['low','medium','high','urgent'].map(p=><option key={p}>{p}</option>)}</select></label><label>Assignee<select aria-label="Assignee" value={input.assignee_id??''} onChange={e=>patch({assignee_id:e.target.value||null})}><option value="">Unassigned</option>{ticket?.assignee&&!members.some(m=>m.id===ticket.assignee_id)&&<option value={ticket.assignee_id!}>{ticket.assignee.display_name}</option>}{members.map(m=><option key={m.id} value={m.id}>{m.display_name} (@{m.username})</option>)}</select></label><label>Deadline<input type="datetime-local" value={due} onChange={e=>setDue(e.target.value)}/><small>Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></label><label>Labels<input value={labels} maxLength={300} placeholder="design, release" onChange={e=>setLabels(e.target.value)}/></label></div>
    {morePeople&&<button type="button" onClick={morePeople}>Load more assignees</button>}{error&&<p role="alert" className="bc-board-error">{error}</p>}<footer><button type="button" className="bc-board-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="bc-primary" disabled={busy}>{busy?'Saving…':'Save ticket'}</button></footer>
  </form>;
  return ticket?form:<div className="bc-ticket-overlay"><button className="bc-ticket-shade" aria-label="Cancel create ticket" onClick={onClose}/><aside className="bc-ticket-drawer" role="dialog" aria-label="Create ticket" aria-modal="true">{form}</aside></div>;
}
function localDate(value:string) {const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function TicketDetails({ticket,slug,lanes,members,refresh,morePeople}:{ticket:TicketDetail;slug:string;lanes:KanbanLane[];members:TicketPerson[];refresh:()=>Promise<void>;morePeople?:()=>void}) {
  const [editing,setEditing]=useState(false),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [older,setOlder]=useState<TicketComment[]>([]),[cursor,setCursor]=useState<string|null|undefined>(undefined);
  if(editing)return <TicketEditor ticket={ticket} slug={slug} lanes={lanes} members={members} morePeople={morePeople} onClose={()=>setEditing(false)} onSaved={async()=>{setEditing(false);await refresh();}}/>;
  return <div className="bc-ticket-detail"><span className="bc-eyebrow">{ticketKey(slug,ticket.number)} · {ticket.type}</span><h2>{ticket.title}</h2><div className="bc-ticket-detail-meta"><span>{lanes.find(l=>l.id===ticket.lane_id)?.name}</span><b className={`priority-${ticket.priority}`}>{ticket.priority}</b><button className="bc-board-secondary" onClick={()=>setEditing(true)}>Edit ticket</button></div><dl><dt>Assignee</dt><dd>{ticket.assignee?.display_name??'Unassigned'}</dd><dt>Reporter</dt><dd>{ticket.reporter?.display_name??'Former member'}</dd><dt>Deadline</dt><dd>{ticket.due_at?new Date(ticket.due_at).toLocaleString():'No deadline'}</dd><dt>Labels</dt><dd>{ticket.labels.join(', ')||'None'}</dd></dl><div className="bc-markdown"><Markdown content={ticket.description||'_No description yet._'}/></div>
    <h3>Comments</h3><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await endpoints.commentTicket(slug,ticket.id,body);setBody('');await refresh();}catch(err){setError(err instanceof Error?err.message:'Unable to comment');}finally{setBusy(false);}}}><textarea aria-label="Comment" placeholder="Add context or an update…" required maxLength={10000} value={body} onChange={e=>setBody(e.target.value)}/><button className="bc-primary" disabled={busy||!body.trim()}>Add comment</button></form>{error&&<p role="alert">{error}</p>}
    {[...ticket.comments,...older].filter((c,i,a)=>a.findIndex(x=>x.id===c.id)===i).map(c=><article className="bc-ticket-comment" key={c.id}><strong>{c.author?.display_name??'Former member'}</strong><small>{new Date(c.created_at).toLocaleString()}</small><Markdown content={c.body}/></article>)}
    {(cursor===undefined?ticket.comments_cursor:cursor)&&<button className="bc-board-secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const page=await endpoints.boardTicket(slug,ticket.id,(cursor===undefined?ticket.comments_cursor:cursor)!);setOlder([...older,...page.comments]);setCursor(page.comments_cursor);}catch(e){setError(e instanceof Error?e.message:'Unable to load comments');}finally{setBusy(false);}}}>Older comments</button>}
    <h3>Activity <small>Latest 100 changes</small></h3>{ticket.history.map(h=><div className="bc-ticket-history" key={h.id}><strong>{h.actor?.display_name??'Former member'}</strong> updated {Object.keys(h.changes).join(', ')}<time>{new Date(h.created_at).toLocaleString()}</time></div>)}
  </div>;
}
function LaneSettings({slug,lanes,onClose,refresh}:{slug:string;lanes:KanbanLane[];onClose:()=>void;refresh:()=>Promise<void>}) {
  const [draft,setDraft]=useState(lanes),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function run(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refresh();setDraft((await endpoints.board(slug)).lanes);}catch(e){setError(e instanceof Error?e.message:'Unable to update lanes');}finally{setBusy(false);}}
  return <div className="bc-ticket-overlay"><button className="bc-ticket-shade" aria-label="Close lane settings" onClick={onClose}/><aside className="bc-ticket-drawer" role="dialog" aria-label="Manage lanes" aria-modal="true"><button className="bc-ticket-close" onClick={onClose}>Close ✕</button><h2>Workflow lanes</h2><p>Completed lanes stop deadline reminders. Move tickets out before deleting a lane.</p>{error&&<p role="alert">{error}</p>}{draft.map((lane,i)=><div className="bc-lane-editor" key={lane.id}><input aria-label={`Lane name ${i+1}`} value={lane.name} maxLength={60} onChange={e=>setDraft(draft.map(l=>l.id===lane.id?{...l,name:e.target.value}:l))}/><input aria-label={`Lane color ${i+1}`} type="color" value={lane.color} onChange={e=>setDraft(draft.map(l=>l.id===lane.id?{...l,color:e.target.value}:l))}/><input aria-label={`Lane position ${i+1}`} type="number" min={0} max={100} value={lane.position} onChange={e=>setDraft(draft.map(l=>l.id===lane.id?{...l,position:Number(e.target.value)}:l))}/><label><input type="checkbox" checked={lane.is_done} onChange={e=>setDraft(draft.map(l=>l.id===lane.id?{...l,is_done:e.target.checked}:l))}/>Completed</label><button disabled={busy} onClick={()=>void run(()=>endpoints.saveBoardLane(slug,lane,lane.id))}>Save</button><button disabled={busy} onClick={()=>{if(confirm('Delete this empty lane?'))void run(()=>endpoints.deleteBoardLane(slug,lane.id));}}>Delete</button></div>)}<form onSubmit={e=>{e.preventDefault();void run(async()=>{await endpoints.saveBoardLane(slug,{name});setName('');});}}><input aria-label="New lane name" required maxLength={60} placeholder="New lane name" value={name} onChange={e=>setName(e.target.value)}/><button className="bc-primary" disabled={busy}>Add lane</button></form></aside></div>;
}
