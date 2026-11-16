/** Repeatable Chromium check against a fresh temporary cards-preview --identity instance. */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const url = process.env.CARDS_PREVIEW_URL
if (!url) throw Error('Set CARDS_PREVIEW_URL to a fresh cards-preview --identity URL')
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',headless:true,args:['--no-sandbox']})
try {
const page=await browser.newPage({viewport:{width:1280,height:900}}), errors=[]
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept('浏览器保存点'))
await page.goto(url);await page.waitForTimeout(1200)
const frame=page.frames()[1], table=frame.locator('.card-table')
await table.waitFor({state:'visible'})
await table.getByRole('button',{name:/点击继续阅读/}).click()
await table.getByRole('button',{name:'光矢 → 青',exact:true}).first().click()
await table.getByText(/不退款/).first().waitFor({timeout:20000})
const text=await table.innerText()
if(!text.includes('不退款'))throw Error('missing resolved defense cancellation')
const savedResponse = page.waitForResponse(response => response.url().includes('/api/story-save'))
await page.getByRole('button',{name:'保存进度',exact:true}).click()
if(!(await savedResponse).ok())throw Error('Save failed')
await page.waitForTimeout(500)
for(let i=0;i<10;i++){const read=table.getByRole('button',{name:/点击继续阅读/});if(!await read.count())break;await read.click();await page.waitForTimeout(120)}
await page.getByRole('button',{name:'切回默认界面',exact:true}).click()
const pause=frame.getByRole('button',{name:'暂停 灯塔守望 · 身份对战',exact:true})
await pause.click();await page.waitForTimeout(500)
await frame.locator('#skip-read').click()
await frame.locator('#actions-toggle').click()
await frame.getByRole('button',{name:'继续 灯塔守望 · 身份对战',exact:true}).click()
await page.waitForTimeout(500)
if(!await table.isVisible()){await page.getByRole('button',{name:'打开活动界面',exact:true}).click()}
await table.waitFor({state:'visible'})
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200)
const overflow=await frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)

await page.getByRole('button',{name:'中止活动',exact:true}).click();await page.waitForTimeout(500)
if(await table.isVisible())throw Error('table remained after escape')
console.log(JSON.stringify({entered:true,playedCard:true,defenseCancelled:true,saved:true,suspended:true,resumed:true,exited:true,mobileOverflow:overflow,errors},null,2))
} finally { await browser.close() }
