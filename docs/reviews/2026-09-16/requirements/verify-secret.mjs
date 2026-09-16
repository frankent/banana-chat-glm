import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const prod=process.env.MEETING_QA_PRODUCTION==='1';
const base=prod?'https://chat.gamecoms.net':'http://127.0.0.1:5173';
const apiBase=prod?base:'http://localhost:18000';
function php(code){return execFileSync(prod?'ssh':'docker',prod?['-S','/tmp/banana-sept16-ssh','root@165.22.63.119','cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php']:['exec','-i','-w','/app','banana-chat-call-review','php'],{input:`<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,encoding:'utf8'});}
const prefix='secretqa'+Date.now(),password=randomBytes(20).toString('hex');
const fixture=JSON.parse(php(`$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Secret QA','status'=>'active']);$users=[];foreach(['Expiry host','Expiry guest'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'member']);$users[]=['id'=>$u->id,'username'=>$u->username];}echo json_encode(['workspace'=>$w->id,'users'=>$users]);`));
const browser=await chromium.launch({channel:'chrome'});
const ctx=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true,isMobile:true});
if(!prod) await ctx.route(/\/(api|broadcasting)\//,async route=>{const target=new URL(route.request().url());target.host='localhost:18000';try{const response=await route.fetch({url:target.toString()});await route.fulfill({response});}catch(e){if(!/closed|disposed/.test(e.message))throw e;}});
const page=await ctx.newPage(),results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));let token;
async function api(path,method='GET',data){return page.request.fetch(apiBase+'/api/v1'+path,{method,headers:{Authorization:'Bearer '+token,'X-Workspace-Id':prefix,Accept:'application/json'},data});}
try{
 await page.goto(base+'/login');await page.getByLabel('Username').fill(fixture.users[0].username);await page.getByLabel('Password').fill(password);
 const login=page.waitForResponse(r=>r.url().endsWith('/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'Sign in',exact:true}).click();token=(await(await login).json()).access_token;await expect(page.locator('aside')).toBeVisible();
 const ordinaryResponse=await api('/rooms','POST',{type:'dm',user_id:fixture.users[1].id});expect(ordinaryResponse.status()).toBe(201);const ordinary=(await ordinaryResponse.json()).data.room;
 await page.getByRole('button',{name:'+ DM',exact:true}).click();await page.getByTestId('secret-toggle').getByRole('checkbox').check();await page.getByTestId('secret-expiry').selectOption('1');
 await expect(page.getByTestId('secret-expiry').locator('option')).toHaveCount(30);await expect(page.getByTestId('secret-explain')).toContainText('not end-to-end encrypted');
 const dmResponse=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/rooms')&&r.request().method()==='POST');await page.getByRole('button',{name:/Expiry guest @/}).click();const secret=(await(await dmResponse).json()).data.room;
 expect(secret.id).not.toBe(ordinary.id);expect(secret.is_secret).toBe(true);expect(Date.parse(secret.secret_expires_at)-Date.now()).toBeGreaterThan(23*3600000);await expect(page).toHaveURL(new RegExp('/rooms/'+secret.id));
 results.push({test:'TC-ROOM-070 secret DM creator offers every 1..30 day lifetime and preserves ordinary DM',status:'passed'});
 await page.getByRole('button',{name:'+ Group',exact:true}).click();await page.getByPlaceholder('Group name').fill('Expiring project');await page.getByRole('button',{name:/Expiry guest @/}).click();await page.getByTestId('secret-toggle').getByRole('checkbox').check();await page.getByTestId('secret-expiry').selectOption('30');
 const groupResponse=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/rooms')&&r.request().method()==='POST');await page.getByRole('button',{name:/Create group/}).click();const group=(await(await groupResponse).json()).data.room;
 expect(group.is_secret).toBe(true);expect(Date.parse(group.secret_expires_at)-Date.now()).toBeGreaterThan(29*86400000);await expect(page).toHaveURL(new RegExp('/rooms/'+group.id));
 await page.screenshot({path:new URL((prod?'production-':'')+'secret-group.png',import.meta.url).pathname});
 results.push({test:'TC-ROOM-071 secret group creator stores 30-day expiry',status:'passed'});
 await page.setViewportSize({width:390,height:844});const composer=page.getByTestId('composer-input');await expect(composer).toBeVisible();
 const before=await page.evaluate(()=>({scale:visualViewport.scale,x:window.scrollX}));await composer.fill('Secret QA message '+prefix);await composer.focus();
 expect(await composer.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
 expect(await page.evaluate(()=>visualViewport.scale)).toBe(before.scale);expect(await page.evaluate(()=>window.scrollX)).toBe(before.x);
 expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toMatch(/user-scalable=no|maximum-scale/);
 await composer.press('Enter');await expect(page.getByText('Secret QA message '+prefix,{exact:true})).toBeVisible();
 await page.screenshot({path:new URL((prod?'production-':'')+'mobile-composer.png',import.meta.url).pathname});
 results.push({test:'TC-WEB-071 mobile composer uses 16px, types/sends without zoom or horizontal movement, keeps pinch zoom',status:'passed'});
 const messages=await api('/rooms/'+group.id+'/messages');expect(messages.ok()).toBe(true);
 php(`App\\Models\\Room::withoutGlobalScopes()->where('id','${group.id}')->where('workspace_id','${fixture.workspace}')->update(['secret_expires_at'=>now()->subSecond()]);`);
 expect((await api('/rooms/'+group.id+'/messages')).status()).toBe(410);
 if(!prod)php(`$r=App\\Models\\Room::withoutGlobalScopes()->findOrFail('${group.id}');app(App\\Jobs\\ExpireSecretRooms::class)->expireRoom($r);`);
 await expect.poll(()=>php(`echo App\\Models\\Room::withoutGlobalScopes()->where('id','${group.id}')->exists()?'exists':'gone';`),{timeout:90000,intervals:[1000,2000,5000]}).toBe('gone');
 await expect(page.getByText('Secret QA message '+prefix,{exact:true})).toHaveCount(0,{timeout:15000});
 expect((await api('/rooms/'+ordinary.id)).status()).toBe(200);
 const counts=JSON.parse(php(`echo json_encode(['messages'=>App\\Models\\Message::withoutGlobalScopes()->where('room_id','${group.id}')->count(),'members'=>App\\Models\\RoomMember::where('room_id','${group.id}')->count()]);`));expect(counts).toEqual({messages:0,members:0});
 results.push({test:'TC-ROOM-073/077 expiry denies access, scheduler deletes content, active UI evicts, ordinary DM survives',status:'passed',scheduler:prod?'real production scheduler':'direct isolated invocation'});
 expect(errors).toEqual([]);results.push({test:'TC-ROOM-080 no uncaught browser errors',status:'passed'});
}catch(e){results.push({status:'failed',error:e.message});process.exitCode=1;await page.screenshot({path:new URL('secret-failure.png',import.meta.url).pathname});}
finally{await browser.close();php(`$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->first();if($w){$ids=$w->allMemberships()->pluck('user_id');$w->delete();App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();}`);await writeFile(new URL((prod?'production-':'')+'secret-results.json',import.meta.url),JSON.stringify({results,errors,cleanup:true},null,2));}
console.log(JSON.stringify(results,null,2));
