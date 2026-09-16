import { createRequire } from 'node:module';
const require=createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const {chromium}=require('@playwright/test');
const browser=await chromium.launch({channel:'chrome'});
try {
const page=await browser.newPage();await page.goto('http://127.0.0.1:5173');
const result=await page.evaluate(async()=>{
 const {createCallAudioBoost}=await import('/src/components/calls/audio-boost.ts');
 async function render(amplitude,gain){
  const c=new OfflineAudioContext(1,48000,48000),osc=c.createOscillator(),input=c.createGain(); input.gain.value=amplitude;
  const chain=createCallAudioBoost(c,gain);osc.connect(input);input.connect(chain.boost);chain.boost.connect(chain.limiter);chain.limiter.connect(c.destination);osc.start();
  const b=await c.startRendering(), samples=b.getChannelData(0).slice(24000);
  return {rms:Math.sqrt(samples.reduce((s,x)=>s+x*x,0)/samples.length),peak:Math.max(...samples.map(Math.abs))};
 }
 const normal=await render(.05,1),boosted=await render(.05,1.5),loud=await render(1,3),muted=await render(.05,0);
 return {normal,boosted,loud,muted,ratio:boosted.rms/normal.rms};
});
if(Math.abs(result.ratio-1.5)>.02 || result.loud.peak>1 || result.muted.rms!==0) throw Error(JSON.stringify(result));
console.log(JSON.stringify({test:'TC-CALL-031 rendered audio boosts quiet input by 50%, compresses loud steady input, and mutes',status:'passed',...result},null,2));
}finally{await browser.close()}
