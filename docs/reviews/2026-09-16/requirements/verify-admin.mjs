import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const prod=process.env.MEETING_QA_PRODUCTION==='1';
const base=prod?'https://chat.gamecoms.net':'http://localhost:18000';
function php(code){return execFileSync(prod?'ssh':'docker',prod?['-S','/tmp/banana-sept16-ssh','root@165.22.63.119','cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php']:['exec','-i','-w','/app','banana-chat-call-review','php'],{input:`<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,encoding:'utf8'});}
const prefix='adminqa'+Date.now(),password=randomBytes(20).toString('hex');
const fixture=JSON.parse(php(`$u=App\\Models\\User::create(['username'=>'${prefix}','display_name'=>'Capacity QA','password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en','is_system_admin'=>true]);echo json_encode(['id'=>$u->id,'capacity'=>app(App\\Services\\SettingsService::class)->int('call.max_participants')]);`));
const browser=await chromium.launch({channel:'chrome'}),page=await browser.newPage(),results=[];
try {
 await page.goto(base+'/admin/login');await page.locator('input[type=text]').first().fill(prefix);await page.locator('input[type=password]').fill(password);await page.getByRole('button',{name:/Sign in|เข้าสู่ระบบ/}).click();await expect(page.locator('.fi-sidebar')).toBeVisible({timeout:45000});
 await page.goto(base+'/admin/settings');
 const field=page.locator('input[id="data.call.max_participants"]');await expect(field).toHaveValue(String(fixture.capacity));
 await expect(page.getByText(/NEW group calls and public meeting links/i)).toBeVisible();
 results.push({test:'TC-CALL-020 admin capacity control and active-session policy visible',status:'passed'});
 if(!prod){
  await field.fill('51');await page.getByRole('button',{name:/Save|บันทึก/,exact:false}).click();await expect(page.getByText(/must not be greater than 50/i)).toBeVisible();
  await field.fill('12');await page.getByRole('button',{name:/Save|บันทึก/,exact:false}).click();
  await expect.poll(()=>Number(php("echo app(App\\Services\\SettingsService::class)->int('call.max_participants');"))).toBe(12);
  await page.reload();await expect(field).toHaveValue('12');
  results.push({test:'TC-CALL-020 admin saves capacity and rejects out-of-range value',status:'passed'});
 }
 await page.screenshot({path:new URL((prod?'production-':'')+'admin-capacity.png',import.meta.url).pathname,fullPage:true});
}catch(e){results.push({status:'failed',error:e.message});process.exitCode=1;await page.screenshot({path:new URL('admin-failure.png',import.meta.url).pathname,fullPage:true});}
finally{
 await browser.close();
 php(`${prod?'':`app(App\\Services\\SettingsService::class)->set('call.max_participants',${fixture.capacity});`}App\\Models\\User::where('id','${fixture.id}')->where('username','${prefix}')->delete();`);
 await writeFile(new URL((prod?'production-':'')+'admin-results.json',import.meta.url),JSON.stringify({results,cleanup:true},null,2));
}
console.log(JSON.stringify(results,null,2));
