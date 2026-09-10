// Reads the supplied test-account password from stdin; never writes credentials to disk.
// PROD_MEDIA=1 additionally verifies a 60 MiB multipart upload on the live deployment.
import { createRequire } from 'node:module';
import { readFile, writeFile, unlink } from 'node:fs/promises';
const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const password = (await readFile('/dev/stdin', 'utf8')).trim();
const browser = await chromium.launch();
const results = [], errors = [];
const run = `[QA ${new Date().toISOString()}]`;
const users = [];
let uploadPath;
async function api(user, path, body) {
 return user.page.evaluate(async ({path,body,token}) => {
  const r = await fetch('/api/v1'+path,{ method:body ? 'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Workspace-Id':'banana'},...(body ? {body:JSON.stringify(body)}:{}) });
  const json=await r.json(); if(!r.ok) throw Error(`${r.status}: ${json.error?.code}`); return json.data;
 },{path,body,token:user.token});
}
async function check(id, fn){try{await fn();results.push({id,passed:true});}catch(e){results.push({id,passed:false,error:e.message});}console.log(JSON.stringify(results.at(-1)));}
try {
 for(const username of ['tony','tony2']) {
  const context=await browser.newContext(); const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket', ws=>ws.on('framereceived', frame=>{
   try { const event=JSON.parse(String(frame.payload));const envelope=typeof event.data==='string'?JSON.parse(event.data):event.data;
    const message=envelope?.data?.message;
    if(event.event==='message.created' && message?.body?.startsWith(run))console.log(JSON.stringify({receivedBy:username,seq:message.seq,attachments:message.attachments?.map(a=>a.original_name)}));
   }catch{}
  }));
  await page.goto('https://chat.gamecoms.net/login');
  await page.getByLabel('Username').fill(username);await page.getByLabel('Password').fill(password);
  const response=page.waitForResponse(r=>r.url().endsWith('/auth/login') && r.request().method()==='POST');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const auth=await (await response).json();const login=auth.data??auth; if(!login?.access_token) throw Error('Login failed for '+username);
  await expect(page.locator('aside')).toBeVisible();
  await page.waitForFunction(()=>window.Pusher?.instances.at(-1)?.connection.state==='connected');
  users.push({page,token:login.access_token,id:login.user.id});
 }
 const [sender,recipient]=users;
 const before=await api(recipient,'/rooms');
 const existing=before.find(r=>r.room.type==='dm' && r.other_user?.id===sender.id);
 await sender.page.getByRole('button',{name:'+ DM',exact:true}).click();
 await sender.page.getByPlaceholder('Search people…').fill('tony2');
 await sender.page.getByRole('button',{name:/@tony2/}).click();
 await expect(sender.page.getByTestId('composer-input')).toBeVisible();
 const dm=sender.page.url().split('/rooms/')[1]?.split('?')[0];if(!dm)throw Error('No DM URL');
 const row=recipient.page.locator(`aside a[href="/rooms/${dm}"]`);
 await check('TC-ROOM-006-DM-room-list',async()=>{await expect(row).toBeVisible();});
 console.log(JSON.stringify({dmExistedBefore:!!existing}));
 // Keep recipient on another screen through SPA navigation, no room reset/deletion.
 await recipient.page.evaluate(()=>{history.pushState({},'','/search');dispatchEvent(new PopStateEvent('popstate'));});
 const base=(await api(recipient,'/rooms')).find(r=>r.room.id===dm)?.unread_count??0;
 const message=run+' ตรวจรับข้อความขณะเปิดหน้าอื่น';
 await check('TC-READ-011-background-delivery',async()=>{
  await sender.page.getByTestId('composer-input').fill(message);await sender.page.getByTestId('send-button').click();
  await expect(row).toContainText(message,{timeout:15000});
  await expect.poll(async()=> (await api(recipient,'/rooms')).find(r=>r.room.id===dm).unread_count).toBe(base+1);
  await expect(row.locator(':scope > span').nth(1)).toHaveText(String(base+1));
 });
 await check('TC-READ-003-workspace-badge',async()=>{
  const summaries=await api(recipient,'/me/workspaces');const summary=summaries.find(w=>w.workspace.slug==='banana');
  await expect(recipient.page.getByRole('combobox',{name:'Workspace'}).locator('option:checked')).toContainText(`(${summary.unread_rooms_count})`);
 });
 await check('TC-READ-001-open-room',async()=>{
  await row.click();await expect(recipient.page.getByTestId('message').filter({hasText:message})).toHaveCount(1);
  await expect.poll(async()=> (await api(recipient,'/rooms')).find(r=>r.room.id===dm).unread_count).toBe(0);
 });
 if (process.env.PROD_MEDIA === '1') await check('TC-MEDIA-010-real-S3-multipart', async()=>{
  const fileName=`qa-multipart-${Date.now()}.txt`;
  uploadPath='/tmp/'+fileName;
  await writeFile(uploadPath,Buffer.alloc(60*1024*1024,'a'));
  const ticketResponse=sender.page.waitForResponse(r=>r.url().endsWith('/uploads')&&r.request().method()==='POST');
  const completed=sender.page.waitForResponse(r=>/\/uploads\/[^/]+\/complete$/.test(r.url()),{timeout:120000});
  completed.catch(()=>undefined); ticketResponse.catch(()=>undefined);
  await sender.page.locator('input[type=file]').setInputFiles(uploadPath);
  const ticket=await (await ticketResponse).json();expect(ticket.data.multipart.part_urls.length).toBeGreaterThan(1);
  const response=await completed;expect(response.ok()).toBe(true);
  const chip=sender.page.getByTestId('composer-attachment').filter({hasText:fileName});
  await expect(chip).toHaveAttribute('data-status','ready',{timeout:120000});
  const sent=sender.page.waitForResponse(r=>r.url().endsWith(`/rooms/${dm}/messages`)&&r.request().method()==='POST');
  await sender.page.getByTestId('composer-input').fill(run+' Multipart upload verification');
  await sender.page.getByTestId('send-button').click();
  const delivered=await sent;console.log(JSON.stringify({sendStatus:delivered.status(),multipartBytes:60*1024*1024,parts:ticket.data.multipart.part_urls.length}));
  await expect(recipient.page.getByTestId('message').filter({hasText:fileName})).toHaveCount(1,{timeout:15000}).catch(async error=>{
   console.log(JSON.stringify({recipientUrl:recipient.page.url(),fileName,qaMessages:await recipient.page.getByTestId('message').filter({hasText:run}).allTextContents(),senderPending:await sender.page.getByTestId('outbox-message').allTextContents(),channels:await recipient.page.evaluate(()=>Object.keys(window.Pusher.instances.at(-1).channels.channels))}));throw error;
  });
  console.log(JSON.stringify({multipartBytes:60*1024*1024,parts:ticket.data.multipart.part_urls.length,completed:true}));
 });
 await check('TC-RT-001-no-runtime-errors',async()=>expect(errors).toEqual([]));
} finally {
 for(const user of users){try{await api(user,'/auth/logout',{});}catch{}}
 await browser.close();
 if(uploadPath)await unlink(uploadPath).catch(()=>undefined);
 await writeFile(new URL('results.json', import.meta.url),JSON.stringify({run,results,errors},null,2));
}
