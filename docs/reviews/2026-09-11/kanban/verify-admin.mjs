import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const require=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
function php(code){return execFileSync('docker',['compose','-f','infra/docker-compose.yml','exec','-T','-e','DB_DATABASE=orgchat_kanban_review','api','php'],{encoding:'utf8',input:`<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`});}
const run=`kanbanadmin${Date.now()}`;
const fixture=JSON.parse(php(`$u=App\\Models\\User::factory()->create(['username'=>'${run}','is_system_admin'=>true]);$w=App\\Models\\Workspace::factory()->create(['slug'=>'${run}','name'=>'Kanban admin QA']);echo json_encode(['user'=>$u->id,'workspace'=>$w->id]);`));
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(45000);
const errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://localhost:18000/admin/login');await page.locator('input[type=text]').first().fill(run);await page.locator('input[type=password]').fill('Password123!');await page.getByRole('button',{name:/Sign in|เข้าสู่ระบบ/}).click();await expect(page.locator('.fi-sidebar')).toBeVisible({timeout:45000});
 await page.goto('http://localhost:18000/admin/kanban');
 { const updated=page.waitForResponse(r=>r.url().includes('/livewire/update')&&r.request().method()==='POST'); await page.getByLabel('Workspace',{exact:true}).selectOption(fixture.workspace); await updated; }
 await expect(page.getByLabel('Lane name 1',{exact:true})).toHaveValue('To do');
 await page.getByLabel('Lane name 1',{exact:true}).fill('Backlog');
 { const updated=page.waitForResponse(r=>r.url().includes('/livewire/update')&&r.request().method()==='POST'); await page.getByRole('button',{name:'Save',exact:true}).first().click(); await updated; }
 await expect(page.getByLabel('Lane name 1',{exact:true})).toHaveValue('Backlog');
 await page.getByLabel('New lane name',{exact:true}).fill('QA review');await page.getByRole('button',{name:'Add lane',exact:true}).click();
 await expect(page.getByLabel('Lane name 4',{exact:true})).toHaveValue('QA review');
 await page.reload();{ const updated=page.waitForResponse(r=>r.url().includes('/livewire/update')&&r.request().method()==='POST'); await page.getByLabel('Workspace',{exact:true}).selectOption(fixture.workspace); await updated; }await expect(page.getByLabel('Lane name 1',{exact:true})).toHaveValue('Backlog');await expect(page.getByLabel('Lane name 4',{exact:true})).toHaveValue('QA review');
 await page.screenshot({path:new URL('admin-desktop.png',import.meta.url).pathname,fullPage:false});results.push({id:'TC-KAN-007-admin-lanes-save-reload',passed:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('admin-mobile.png',import.meta.url).pathname,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);results.push({id:'TC-KAN-007-admin-responsive',passed:true});expect(errors).toEqual([]);
}catch(e){await page.screenshot({path:new URL('admin-failure.png',import.meta.url).pathname,fullPage:true});console.log(php(`echo App\\Models\\KanbanLane::where('workspace_id','${fixture.workspace}')->get()->toJson();`));results.push({id:'TC-KAN-007',passed:false,error:e.message.split('Call log:')[0]});}
finally{await browser.close();php(`App\\Models\\Workspace::where('id','${fixture.workspace}')->delete();App\\Models\\User::where('id','${fixture.user}')->delete();`);writeFileSync(new URL('admin-results.json',import.meta.url),JSON.stringify({results,errors},null,2));console.log(JSON.stringify(results));}
if(results.some(r=>!r.passed))process.exitCode=1;
