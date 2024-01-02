const Koa = require('koa');
const sass = require('sass');
const chromium = require('@sparticuz/chromium');
const less = require('less');
const puppeteer = require('puppeteer-core');
const KoaBodyParser = require("koa-bodyparser");
const { compile, parseComponent } = require('vue-template-compiler');
const Router = require("@koa/router");
const dotenv=require('dotenv')
dotenv.config()
const router = new Router();
function compileLessToCss(lessCode){
	return new Promise((resolve,reject)=>{
		less.render(lessCode,(err,code)=>{
			if(err){
                reject(err)
            }else{
                resolve(code)
            }
		})
	})
}
function compileSassToCSS(sassCode) {
	return sass.compileString({
		data: sassCode
	}).css
}
function extractCss(vueComponentCode){
	const reg = /<style([^>]*)>([\s\S]*?)<\/style>/g;
    const match = reg.exec(vueComponentCode);
    if(match){
		const typeReg=/lang=(\S+)/
	    const [_,type]=typeReg.exec(match[1])||['','css']
        return [type,[match[2]]]
    }else{
        return
    }
}
async function createBrowser(){
	const connectUrl=process.env.LESSTOKEN?`wss://chrome.browserless.io?token=${process.env.LESSTOKEN}`:''
	const executePath=process.env.CHROME_EXECUTABLE_PATH || (await chromium.executablePath)
	if(connectUrl) return await puppeteer.connect({
		browserWSEndpoint:connectUrl
	})
	return await puppeteer.launch({
		args: chromium.args,
		executablePath: executePath || (await chromium.executablePath),
		headless: true,
		ignoreHTTPSErrors: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--single-process",
		],
		ignoreDefaultArgs: ["--disable-extensions"],
		ignoreHTTPSErrors: true,
	})
}
async function renderHtmlToScreenshot(htmlCode, styleType, styleCode,width,height) {
	const browser = await createBrowser()
	const page = await browser.newPage();
	await page.setViewport({
		width,
		height
	})
	if(styleType==='sass') styleCode=compileSassToCSS(styleCode)
	if(styleType==='less') styleCode=await compileLessToCss(styleCode)
	const style=`<style type="text/css">${styleCode}</style>`
	const html = `
    <html>
      <head>
      ${style}
		</head>
      <body>
        ${htmlCode}
      </body>
    </html>
  `;

	await page.setContent(html);

	// 等待一段时间以确保组件已经渲染
	await new Promise((resolve)=>setTimeout(resolve,1000))

	// 截取屏幕截图
	const screenshot = await page.screenshot({fullPage: true});

	await browser.close();

	return screenshot;
}

async function renderVueComponentToScreenshot(userVueComponent,width,height) {
	const cssInfo=extractCss(userVueComponent)
	 let styleCode='',styleType='css'
	if(!cssInfo) {
		[styleType,styleCode]=cssInfo
		userVueComponent=userVueComponent.replace(/<style([^>]*)>([\s\S]*?)<\/style>/,'')
	}
	const parsedComponent = parseComponent(userVueComponent);

	const appHtml = `<div id="app">${parsedComponent.template.content}</div>`;
	return renderHtmlToScreenshot(appHtml,styleType,styleCode,width,height)
}
async function renderUrlToScreenshot(url,width,height) {
	if(!url.startsWith('http')) url=`http://${url}`
	const browser = await createBrowser()
    const page = await browser.newPage()
    await page.setViewport({
        width,
        height
    })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36')
    await page.goto(url.toString(), {waitUntil: 'domcontentloaded'})
    const result = await page.screenshot({
        fullPage: true,
        type: 'png',
        encoding: 'binary'
    })
    page.close()
    return result
}
const koa = new Koa()
koa.use(KoaBodyParser()).use(router.routes()).use(router.allowedMethods());

router.all('shot', '', async (ctx, next) => {
	const {width = 1920, url = '', height = 1080, ua} = ctx.query || {}
	const vue=ctx.query.vue||ctx.request?.body?.vue;
	const html=ctx.query.html||ctx.request.body?.html;
	const style=ctx.query.style||ctx.request.body?.style
	const type=ctx.query.style||ctx.request.body?.type
	let imgBuf=url?await renderUrlToScreenshot(url,+width,+height):
		vue? await renderVueComponentToScreenshot(vue,+width,+height):
			html?
			await renderHtmlToScreenshot(html,type,style,+width,+height):undefined
	if(!imgBuf) {
        ctx.status = 400
        ctx.body = '参数错误'
        return
    }
	ctx.set('content-type', 'image/png')

	ctx.set('content-type', 'image/png')
	ctx.body = imgBuf
})
koa.listen(3030, () => {
	console.log('服务启动于 http://localhost:3030')
})
