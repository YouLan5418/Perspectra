import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FRONTEND_SDK } from '../../packages/frontend/src/client.ts'
import { DEFAULT_PAGE, DEFAULT_STYLE, DEFAULT_SCRIPT } from '../../packages/frontend/src/default-template.ts'
import type { PackWeb } from './playtest-pack-web.ts'
export interface FrontendPolicy { mode: 'sandbox'|'trusted'; origin: string; revision: number }
export function frontendAsset(request:IncomingMessage,response:ServerResponse,pack:PackWeb|undefined,hostOrigin:string,mode:'sandbox'|'trusted'):boolean{
  const url=new URL(request.url??'/','http://127.0.0.1')
  if(request.method!=='GET'||!url.pathname.startsWith('/frontend/'))return false
  const origin='http://'+request.headers.host
  const builtins:Record<string,{contentType:string;bytes:string}>={
    '/frontend/sdk.js':{contentType:'text/javascript; charset=utf-8',bytes:FRONTEND_SDK},
    '/frontend/default.html':{contentType:'text/html; charset=utf-8',bytes:DEFAULT_PAGE},
    '/frontend/default.css':{contentType:'text/css; charset=utf-8',bytes:DEFAULT_STYLE},
    '/frontend/default.js':{contentType:'text/javascript; charset=utf-8',bytes:DEFAULT_SCRIPT},
  }
  let path=''
  try{path=decodeURIComponent(url.pathname)}catch{/* unknown asset */}
  const asset=builtins[path]??pack?.assets.get(path)
  response.setHeader('cache-control','no-store')
  response.setHeader('x-content-type-options','nosniff')
  response.setHeader('referrer-policy','no-referrer')
  response.setHeader('x-dns-prefetch-control','off')
  response.setHeader('permissions-policy','camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()')
  response.setHeader('access-control-allow-origin','*')
  response.setHeader('cross-origin-resource-policy','cross-origin')
  const sandbox="default-src 'none'; sandbox allow-scripts; script-src "+origin+"/frontend/; style-src "+origin+"/frontend/ 'unsafe-inline'; img-src "+origin+"/frontend/ data:; font-src "+origin+"/frontend/; media-src "+origin+"/frontend/; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors "+hostOrigin
  const trusted="default-src 'none'; sandbox allow-scripts allow-same-origin; script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:; style-src 'self' 'unsafe-inline' http: https:; img-src 'self' data: blob: http: https:; font-src 'self' data: http: https:; media-src 'self' blob: http: https:; connect-src http: https:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors "+hostOrigin
  response.setHeader('content-security-policy',mode==='trusted'?trusted:sandbox)
  if(!asset){response.statusCode=404;response.end('包资源不存在');return true}
  response.setHeader('content-type',asset.contentType);response.end(asset.bytes);return true
}

export function createTrustedFrontendServer(pack:PackWeb,policy:FrontendPolicy,hostOrigin:()=>string){
 return createServer((request,response)=>{
  if(policy.mode!=='trusted'||!/^127\.0\.0\.1:[0-9]+$/.test(request.headers.host??'')){response.writeHead(410);response.end();return}
  if(!frontendAsset(request,response,pack,hostOrigin(),'trusted')){response.writeHead(404);response.end()}
 })
}
