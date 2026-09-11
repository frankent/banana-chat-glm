import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const password=readFileSync('/dev/stdin','utf8').trim();
const browser=await chromium.launch();
const receiver=await browser.newPage({viewport:{width:390,height:844}}), sender=await browser.newPage();
const results=[], errors=[];
for(const p of [receiver,sender]) p.on('pageerror',e=>errors.push(e.message));
await receiver.addInitScript(()=>{window.soundStarts=0; const start=OscillatorNode.prototype.start;OscillatorNode.prototype.start=function(...args){window.soundStarts++;return start.apply(this,args)};});
async function login(p,user){await p.goto('https://chat.gamecoms.net/login');await p.getByLabel('Username').fill(user);await p.getByLabel('Password').fill(password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL('https://chat.gamecoms.net/');await expect(p.locator('aside')).toBeVisible();await expect(p.locator('.bc-sidebar-footer')).toContainText('Connected to your workspace',{timeout:30000});}
async function check(id,fn){try{await fn();results.push({id,passed:true});}catch(e){results.push({id,passed:false,error:e.message.split('Call log:')[0]});}console.log(JSON.stringify(results.at(-1)));}
try{
 await login(receiver,'tony2');await login(sender,'tony');
 await check('TC-WEB-043-production-first-login-mobile',async()=>{await expect(receiver.locator('aside a[href^="/rooms/"]').first()).toBeVisible();});
 await receiver.setViewportSize({width:1280,height:900});
 await sender.locator('aside a[href^="/rooms/"]').filter({hasText:'Tony2'}).click();
 const text=`[QA notification ${new Date().toISOString()}] Sound and tab unread verification`;
 await check('TC-NOTI-025-production-sound-title',async()=>{
   await receiver.bringToFront(); await receiver.getByRole('button',{name:'Conversations',exact:true}).click();
   const before=await receiver.evaluate(()=>window.soundStarts);
   await sender.getByTestId('composer-input').fill(text);await sender.getByTestId('send-button').click();
   await expect.poll(()=>receiver.evaluate(()=>window.soundStarts),{timeout:20000}).toBe(before+1);
   await expect(receiver).toHaveTitle(/^\([1-9]\d*\) Banana Chat$/,{timeout:15000});
 });
 await check('TC-READ-013-production-read-title',async()=>{
   await receiver.bringToFront();await receiver.locator('aside a[href^="/rooms/"]').filter({hasText:text}).click();
   await receiver.getByTestId('composer-input').click();
   await expect(receiver.getByText(text,{exact:true}).last()).toBeVisible();
   await expect(receiver).toHaveTitle('Banana Chat',{timeout:15000});
 });
 await check('TC-NOTI-025-production-preference-control',async()=>{await receiver.getByTestId('notification-bell').click();await expect(receiver.getByLabel('Notification sound')).toBeEnabled();await expect(receiver.getByLabel('Notification sound')).toBeChecked();});
 await check('TC-RT-001-production-runtime',async()=>expect(errors).toEqual([]));
 await receiver.screenshot({path:new URL('production.png',import.meta.url).pathname});
} catch(e){results.push({id:'setup',passed:false,error:e.message.split('Call log:')[0]});}
finally{for(const p of [receiver,sender]){try{await p.getByRole('button',{name:'Sign out',exact:true}).click();}catch{}}await browser.close();writeFileSync(new URL('production-results.json',import.meta.url),JSON.stringify({results,errors},null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
