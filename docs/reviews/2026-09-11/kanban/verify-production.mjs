import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const password=readFileSync('/dev/stdin','utf8').trim();
const slug=process.env.QA_WORKSPACE;
if(!slug)throw new Error('QA_WORKSPACE required');
const browser=await chromium.launch();
const sender=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Bangkok'}),recipient=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Bangkok'});
const errors=[],results=[];for(const p of [sender,recipient]){p.setDefaultTimeout(30000);p.on('pageerror',e=>errors.push(e.message));}
async function login(p,user){await p.goto('https://chat.gamecoms.net/login');await p.getByLabel('Username').fill(user);await p.getByLabel('Password').fill(password);const response=p.waitForResponse(r=>r.url().endsWith('/auth/login')&&r.request().method()==='POST');await p.getByRole('button',{name:'Sign in',exact:true}).click();const data=await(await response).json();await expect(p.locator('aside.bc-sidebar')).toBeVisible({timeout:30000});await p.getByLabel('Workspace',{exact:true}).selectOption(slug);await p.getByRole('button',{name:'Kanban board',exact:true}).click();await expect(p.getByRole('heading',{name:'To do',exact:true})).toBeVisible();return data;}
async function api(p,token,workspace,path,method='GET',body){return p.evaluate(async({token,workspace,path,method,body})=>{const r=await fetch('/api/v1/'+path,{method,headers:{Authorization:`Bearer ${token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status(),data:await r.json()};},{token,workspace,path,method,body});}
async function check(id,fn){try{await fn();results.push({id,passed:true});}catch(e){results.push({id,passed:false,error:e.message.split('Call log:')[0]});}console.log(JSON.stringify(results.at(-1)));}
let ticket,owner,member;
try{
 owner=await login(sender,'tony');member=await login(recipient,'tony2');
 await check('TC-KAN-008-production-create-share',async()=>{
  await sender.getByRole('button',{name:'+ Create ticket',exact:true}).click();
  await sender.getByLabel('Title',{exact:true}).fill('[QA] Kanban production deadline');
  await sender.getByLabel('Description',{exact:true}).fill('**Production verification** — isolated QA workspace, removed after testing.');
  await sender.getByLabel('Assignee',{exact:true}).selectOption(member.user.id);
  await sender.getByLabel('Priority',{exact:true}).selectOption('high');
  const due=await sender.evaluate(()=>{const d=new Date(Date.now()-60000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)});
  await sender.locator('input[type=datetime-local]').fill(due);
  await sender.getByRole('button',{name:'Save ticket',exact:true}).click();
  await expect(sender.getByRole('dialog',{name:'Ticket details'})).toBeVisible();
  await expect(recipient.getByRole('heading',{name:'[QA] Kanban production deadline',exact:true})).toBeVisible({timeout:15000});
  ticket=(await api(sender,owner.access_token,slug,'board/tickets')).data.data.tickets[0];
 });
 await check('TC-KAN-004-production-scheduled-deadline',async()=>{
  await recipient.getByTestId('notification-bell').click();
  await expect(recipient.getByText('Ticket #1 is due',{exact:true})).toBeVisible({timeout:90000});
  await recipient.getByText('Ticket #1 is due',{exact:true}).click();
  await expect(recipient).toHaveURL(new RegExp('/board/'+ticket.id+'$'));
  const feed=await api(recipient,member.access_token,slug,'me/notifications');
  expect(feed.data.data.notifications.filter(n=>n.type==='ticket_due'&&n.data.ticket_id===ticket.id)).toHaveLength(1);
 });
 await check('TC-KAN-001-production-isolation',async()=>{
  const other=owner.workspaces.find(w=>w.workspace.slug!==slug).workspace.slug;
  const result=await api(sender,owner.access_token,other,'board/tickets/'+ticket.id);
  expect(result.status).toBe(404);
  const list=await api(sender,owner.access_token,other,'board/tickets');
  expect(list.data.data.tickets.some(t=>t.id===ticket.id)).toBe(false);
 });
 await check('TC-KAN-008-production-comment-move',async()=>{
  await recipient.getByLabel('Comment',{exact:true}).fill('Production collaboration confirmed');
  await recipient.getByRole('button',{name:'Add comment',exact:true}).click();
  await expect(sender.getByText('Production collaboration confirmed',{exact:true})).toBeVisible({timeout:15000});
  await recipient.getByRole('button',{name:'Close ✕',exact:true}).click();
  const lanes=(await api(recipient,member.access_token,slug,'board')).data.data.lanes;
  await recipient.getByLabel(`Move ${slug.toUpperCase()}-1`).selectOption(lanes[2].id);
  await expect(sender.getByRole('dialog').getByText('Done',{exact:true})).toBeVisible({timeout:15000});
 });
 await check('TC-KAN-008-production-no-errors',async()=>expect(errors).toEqual([]));
 await recipient.screenshot({path:new URL('production.png',import.meta.url).pathname});
}catch(e){results.push({id:'setup',passed:false,error:e.message.split('Call log:')[0]});}
finally{for(const p of [sender,recipient]){try{await p.getByRole('button',{name:'Close ✕',exact:true}).click({timeout:500});}catch{}try{await p.getByRole('button',{name:'Sign out',exact:true}).click({timeout:2000});}catch{}}await browser.close();writeFileSync(new URL('production-results.json',import.meta.url),JSON.stringify({results,errors},null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
