const Koa = require('koa');
const sass = require('sass');
const chromium = require('chrome-aws-lambda');
const less = require('less');
const puppeteer = require('puppeteer');
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
	const reg = /<style([^>]*)?>([\s\S]*?)<\/style>/g;
    const match = reg.exec(vueComponentCode);
    if(match){
		const typeReg=/lang=(\S+)/
	    const [_,type]=typeReg.exec(match[1])||['','css']
        return [type,match[2]]
    }else{
        return
    }
}
async function createBrowser(){
	return await puppeteer.launch({
		args: [...chromium.args, "--hide-scrollbars", "--disable-web-security"],
		defaultViewport: chromium.defaultViewport,
		executablePath: await chromium.executablePath,
		headless: 'new',
		ignoreHTTPSErrors: true,
	})
}
async function renderHtmlToScreenshot(htmlCode, styleType, styleCode, {
	width,
	height,
	ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36'
}) {
	const browser = await createBrowser()
	const page = await browser.newPage();
	await page.setViewport({
		width,
		height
	})
	await page.setUserAgent(ua)
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

async function renderVueComponentToScreenshot(userVueComponent,config) {
	const cssInfo=extractCss(userVueComponent)
	 let styleCode='',styleType='css'
	if(cssInfo) {
		[styleType,styleCode]=cssInfo
		userVueComponent=userVueComponent.replace(/<style([^>]*)>([\s\S]*?)<\/style>/,'')
	}
	const parsedComponent = parseComponent(userVueComponent);

	const appHtml = `<div id="app">${parsedComponent.template.content}</div>`;
	return renderHtmlToScreenshot(appHtml,styleType,styleCode,config)
}
async function renderUrlToScreenshot(url, {
	width,
	height,
	ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36'
}) {
	if(!url.startsWith('http')) url=`http://${url}`
	const browser = await createBrowser()
    const page = await browser.newPage()
    await page.setViewport({
        width,
        height
    })
    await page.setUserAgent(ua)
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
router.get('url','', async (ctx, next) => {
	const {width = 1920, url = '', height = 1080, ua} = ctx.query || {}
	if(!url) return next()
	ctx.set('content-type', 'image/png')
	ctx.body = await renderUrlToScreenshot(url, {
        width: +width,
        height: +height,
        ua
    })
})
router.all('vue','', async (ctx, next) => {
	const {width = 1920, height = 1080, ua} = ctx.query || {}
	const template=ctx.query.template || ctx.request.body.template
    if(!template) return next()
    ctx.set('content-type', 'image/png')
    ctx.body = await renderVueComponentToScreenshot(template, {
		width: +width,
        height: +height,
        ua
    })
})
router.all('html','',async (ctx, next) => {
	const {width = 1920, height = 1080, ua} = ctx.query || {}
    const html=ctx.query.style||ctx.request.body?.html
	const type=ctx.query.type
	const style=ctx.query.style||ctx.request.body?.style
    if(!html) return next()
    ctx.set('content-type', 'image/png')
    ctx.body = await renderHtmlToScreenshot(html,type,style,{
		width: +width,
        height: +height,
        ua
    })
})
router.get('docs', '', async (ctx, next) => {
	await next()
	ctx.body=`
	<html>
	    <head>
	        <title>
	        	web shot
	    	</title>
	    	<style type="text/css">
	    		th,td{
	    		    border: 1px solid;
	    			text-align: center;
	    		}
			</style>
	    </head>
	    <body>
	    	<h1>welcome to web shot</h1>
	    	<h2>shot with url</h2>
	    	<table>
	    		<tr>
                    <th>params</th>
                    <th>type</th>
                    <th>required</th>
                    <th>body</th>
                    <th>desc</th>
                    <th>default</th>
                </tr>
                <tr>
                    <td>width</td>
                    <td>number</td>
                    <td>false</td>
                    <td>false</td>
                    <td>viewport width</td>
                    <td>1920</td>
				</tr>
				<tr>
				    <td>height</td>
				    <td>number</td>
                    <td>false</td>
				    <td>false</td>
				    <td>viewport height</td>
				    <td>1080</td>
				</tr>
				<tr>
				    <td>ua</td>
				    <td>string</td>
                    <td>false</td>
				    <td>false</td>
				    <td>userAgent</td>
				    <td>Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36</td>
				</tr>
				<tr>
				    <td>url</td>
				    <td>string</td>
                    <td>true</td>
				    <td>false</td>
				    <td>shot url</td>
				    <td>-</td>
				</tr>
            </table>
            <h3>example</h3>
            <a href="/?url=baidu.com" target="_blank">shot baidu.com</a>
            <h2>shot with vue</h2>
            <table>
            	<tr>
                    <th>params</th>
                    <th>type</th>
                    <th>required</th>
                    <th>body</th>
                    <th>desc</th>
                    <th>default</th>
                </tr>
                <tr>
                    <td>width</td>
                    <td>number</td>
                    <td>false</td>
                    <td>false</td>
                    <td>viewport width</td>
                    <td>1920</td>
                </tr>
                <tr>
                    <td>height</td>
                    <td>number</td>
                    <td>false</td>
                    <td>false</td>
                    <td>viewport height</td>
                    <td>1080</td>
                </tr>
                <tr>
                	<td>ua</td>
                    <td>string</td>
                    <td>false</td>
                    <td>false</td>
                    <td>userAgent</td>
                    <td>Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36</td>
                </tr>
                <tr>
                    <td>template</td>
                    <td>string</td>
                    <td>true</td>
                    <td>true</td>
                    <td>vue template</td>
                    <td>-</td>
                </tr>
			</table>
            <h3>example</h3>
            <a href="/?template=<template><h1>hello world</h1></template><style>h1{color:red;}</style>" target="_blank">shot red h1</a>
			<h2>shot with html</h2>
			<table>
				<tr>
				    <th>params</th>
				    <th>type</th>
				    <th>required</th>
				    <th>body</th>
				    <th>desc</th>
				    <th>default</th>
				</tr>
				<tr>
				    <td>width</td>
				    <td>number</td>
				    <td>false</td>
				    <td>false</td>
				    <td>viewport width</td>
				    <td>1920</td>
				</tr>
				<tr>
				    <td>height</td>
				    <td>number</td>
				    <td>false</td>
				    <td>false</td>
				    <td>viewport height</td>
				    <td>1080</td>
				</tr>
				<tr>
					<td>ua</td>
					<td>string</td>
					<td>false</td>
					<td>false</td>
					<td>userAgent</td>
					<td>Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36</td>
				</tr>
				<tr>
					<td>html</td>
					<td>string</td>
					<td>true</td>
					<td>true</td>
					<td>html</td>
					<td>-</td>
				</tr>
				<tr>
					<td>type</td>
                    <td>css | less | sass</td>
                    <td>false</td>
                    <td>false</td>
                    <td>css type</td>
                    <td>css</td>
                </tr>
                <tr>
                    <td>style</td>
                    <td>string</td>
                    <td>false</td>
                    <td>true</td>
                    <td>css style</td>
                    <td>-</td>
                </tr>
			</table>
            <h3>example</h3>
            <a href="/?html=<h1>hello world</h1>&style=h1{color:red;}" target="_blank">shot red h1</a>
	    </body>
	</html>
	`
})
koa.listen(3030, () => {
	console.log('服务启动于 http://localhost:3030')
})
