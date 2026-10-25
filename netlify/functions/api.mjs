import { createHmac, timingSafeEqual } from 'node:crypto';
const env = name => globalThis.Netlify?.env.get(name) ?? process.env[name];
const response = (status, body, extra={}) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const sign=value=>createHmac('sha256',env('SESSION_SECRET')).update(value).digest('hex');
const cookie=(value,maxAge)=>`beauty_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
function session(req){try{const raw=(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('beauty_session='))?.slice(15);if(!raw)return false;const [exp,sig]=raw.split('.');return Number(exp)>Date.now()&&equal(sig||'',sign(exp));}catch{return false;}}
let tokenCache={token:null,expires:0};
async function jsonFetch(url,options){const res=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});return res.json();}
async function accessToken(){if(tokenCache.token&&tokenCache.expires>Date.now())return tokenCache.token;const body=new URLSearchParams({grant_type:'client_credentials',client_id:env('BAIDU_API_KEY'),client_secret:env('BAIDU_SECRET_KEY')});const d=await jsonFetch('https://aip.baidubce.com/oauth/2.0/token',{method:'POST',body});if(!d.access_token)throw new Error('百度鉴权失败，请检查服务端 API Key 和 Secret Key。');tokenCache={token:d.access_token,expires:Date.now()+(Number(d.expires_in||3600)-60)*1000};return d.access_token;}
const errors={6:'该应用尚未开通人脸检测权限。',17:'每日调用量已超限。',18:'检测请求频率超限，请稍后再试。',19:'接口调用额度已用完。',110:'访问令牌无效，请稍后重试。',111:'访问令牌已过期，请稍后重试。',216201:'图片格式不正确。',222202:'未检测到人脸，请使用清晰正面照。',222203:'图片无法读取，请更换照片。',222207:'未检测到有效人脸。',222209:'人脸未完整显示，请更换照片。'};
export function buildReport(data){const result=data.result||{},faces=result.face_list||[];if(result.face_num!==1||faces.length!==1)throw new Error('请上传仅包含一张清晰正面人脸的照片。');const f=faces[0],quality=f.quality||{},pose=f.angle||{},shape=f.face_shape||{},names={square:'方形',triangle:'三角形',oval:'椭圆形',heart:'心形',round:'圆形'},name=names[shape.type]||'暂未返回',prob=Number(shape.probability||0),warnings=[];
if(Math.max(0,...Object.values(pose).map(Math.abs))>15)warnings.push('照片存在较明显偏转，建议使用正面照。');if(quality.blur>.5)warnings.push('照片较模糊，建议重新拍摄。');if(quality.illumination!==undefined&&quality.illumination<40)warnings.push('光照偏暗，建议在均匀自然光下重拍。');if(quality.completeness===0)warnings.push('人脸未完整显示。');if(Math.max(0,...Object.values(quality.occlusion||{}))>.5)warnings.push('部分五官存在遮挡。');
return {provider:'百度智能云',requestId:String(data.log_id||''),landmarkCount:(f.landmark150||f.landmark||[]).length,beauty:typeof f.beauty==='number'?{score:f.beauty}:{},skin:[],pose,quality,shape:{name,probability:prob},warnings,tips:[],summary:`本次脸型倾向：${name}，分类置信度 ${Math.round(prob*100)}%。建议根据检测结果与通用妆容规则整理。`};}
export default async function handler(req){
 const path=new URL(req.url).pathname;
 if(!['/api/status','/api/login','/api/logout','/api/analyze'].includes(path))return response(404,{error:'接口不存在。'});
 if(req.method==='GET'&&path==='/api/status')return response(200,{provider:'百度智能云',configured:!!(env('BAIDU_API_KEY')&&env('BAIDU_SECRET_KEY')&&env('SITE_PASSWORD')&&env('SESSION_SECRET'))});
 if(req.method!=='POST')return response(405,{error:'请求方式不支持。'},{Allow:'POST'});
 if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)return response(403,{error:'请求来源不匹配。'});
 if(!env('SITE_PASSWORD')||!env('SESSION_SECRET')||env('SESSION_SECRET').length<32)return response(503,{error:'请先配置网站密码及至少 32 字符的 SESSION_SECRET，再重新部署。'});
 if(!req.headers.get('content-type')?.includes('application/json'))return response(415,{error:'请求格式不正确。'});
 let body;try{const raw=await req.text();if(raw.length>2200000)return response(413,{error:'图片过大，请选择较小照片。'});body=JSON.parse(raw);if(!body||typeof body!=='object')throw new Error();}catch{return response(400,{error:'请求格式不正确。'});}
 if(path==='/api/login'){if(!equal(String(body.password||''),env('SITE_PASSWORD')))return response(401,{error:'密码不正确，请重新输入。'});const exp=String(Date.now()+3600000);return response(200,{ok:true},{'Set-Cookie':cookie(exp+'.'+sign(exp),3600)});}
 if(path==='/api/logout')return response(200,{ok:true},{'Set-Cookie':cookie('',0)});
 if(!session(req))return response(401,{error:'登录已过期，请退出空间后重新登录。'});
 if(body.consent!==true)return response(400,{error:'请先同意上传照片进行分析。'});
 if(!env('BAIDU_API_KEY')||!env('BAIDU_SECRET_KEY'))return response(503,{error:'请配置百度智能云凭据并重新部署。'});
 const image=String(body.image||''),match=/^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
 if(!match||match[1].length>2*1024*1024)return response(400,{error:'图片无效或过大，请重新选择。'});
 const bytes=Buffer.from(match[1],'base64');if(!(bytes.subarray(0,3).equals(Buffer.from([255,216,255]))||bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))return response(400,{error:'请选择有效 JPG 或 PNG 图片。'});
 try{let d;for(let attempt=0;attempt<3;attempt++){const token=await accessToken();d=await jsonFetch('https://aip.baidubce.com/rest/2.0/face/v3/detect?access_token='+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:match[1],image_type:'BASE64',face_field:'beauty,face_shape,landmark150,quality',max_face_num:2,face_type:'LIVE'})});if([110,111].includes(d.error_code)&&attempt<2){tokenCache={token:null,expires:0};continue;}if(d.error_code===18&&attempt<2){await new Promise(r=>setTimeout(r,attempt?4000:2000));continue;}break;}
 if(d.error_code)return response(d.error_code===18?429:422,{error:errors[d.error_code]||'检测服务调用失败，请检查权限与额度。',code:d.error_code});return response(200,buildReport(d));
 }catch(e){return response(502,{error:e.message?.startsWith('百度鉴权')||e.message?.startsWith('请上传')?e.message:'检测服务连接超时或返回异常，请稍后重试。'});}
}
export const config={path:'/api/*',rateLimit:{action:'rate_limit',aggregateBy:['ip','domain'],windowSize:60,windowLimit:20}};
