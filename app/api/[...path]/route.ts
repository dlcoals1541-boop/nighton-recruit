import {database} from '@/lib/database';
const env=process.env;
import {eventStream} from '@/lib/events';
import {uid,digest,hashPassword,verify,money,text,password,publicUser,visible,totals} from '@/lib/security';
export const dynamic='force-dynamic';
export const maxDuration=300;
const db=database;
const now=()=>new Date().toISOString();
const one=(sql:string,...p:any[])=>db().prepare(sql).bind(...p).first<any>();
const all=async(sql:string,...p:any[])=> (await db().prepare(sql).bind(...p).all<any>()).results;
const run=(sql:string,...p:any[])=>db().prepare(sql).bind(...p).run();
const fail=(s:string,code=400)=>{throw Object.assign(new Error(s),{code});};
const ok=(d:any,status=200,headers:any={})=>Response.json(d,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function rate(key:string,max:number,minutes:number){const bucket=Math.floor(Date.now()/(minutes*60000));const r=await one('INSERT INTO limits(key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key+':'+bucket,Date.now()+minutes*60000);if(r.count>max)fail('시도가 너무 많습니다. 잠시 후 다시 시도하세요.',429);}
async function session(req:Request){const token=req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('nighton_session='))?.slice(16);if(!token)return null;return one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?',await digest(token),now());}
async function audit(actor:string,entity:string,id:string,action:string,before:any,after:any){await run('INSERT INTO audit(entity,entity_id,action,actor,before,after,created_at) VALUES(?,?,?,?,?,?,?)',entity,id,action,actor,before?JSON.stringify(before):null,after?JSON.stringify(after):null,now());}
export async function cleanupDatabase(){const t=now(),cut=new Date(Date.now()-7*86400000).toISOString();const id=t.slice(0,10);const claim=await run('INSERT OR IGNORE INTO cleanup(id,ran_at,deleted,note) VALUES(?,?,0,?)',id,t,'실행 중');if(!claim.meta.changes)return;try{const r=await run(`DELETE FROM calls WHERE status IN ('completed','cancelled') AND ended_at<? AND legal_hold=0 AND retain_until IS NOT NULL AND retain_until<? AND NOT EXISTS(SELECT 1 FROM payouts WHERE call_id=calls.id AND status='pending')`,cut,t);await db().batch([db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(t),db().prepare('DELETE FROM limits WHERE expires<?').bind(Date.now()),db().prepare('UPDATE cleanup SET deleted=?,note=? WHERE id=?').bind(r.meta.changes,'완료 · 보호/지급 대기 자료 제외',id)]);}catch(e){await run('UPDATE cleanup SET note=? WHERE id=?','실패 · 관리자 점검 필요',id);throw e;}}
async function handler(req:Request){try{
 const path=new URL(req.url).pathname.replace('/api/','');const isWrite=req.method!=='GET';
 if(path==='maintenance/run'){if(req.method!=='POST')fail('허용되지 않은 요청 방식입니다.',405);const key=req.headers.get('x-nighton-maintenance');if(!key||!(env as any).MAINTENANCE_TOKEN_HASH||await digest(key)!==(env as any).MAINTENANCE_TOKEN_HASH)fail('인증이 필요합니다.',403);await cleanupDatabase();return ok({cleanup:await one('SELECT * FROM cleanup ORDER BY ran_at DESC LIMIT 1')});}
 if(['auth/status','data','admin/data','events'].includes(path)?req.method!=='GET':req.method!=='POST')fail('허용되지 않은 요청 방식입니다.',405);
 if(isWrite&&req.headers.get('origin')!==new URL(req.url).origin)fail('요청 출처를 확인할 수 없습니다.',403);
 if(isWrite&&Number(req.headers.get('content-length')||0)>12000)fail('요청이 너무 큽니다.',413);
 const raw=isWrite?await req.text():'';if(raw.length>12000)fail('요청이 너무 큽니다.',413);const b=raw?JSON.parse(raw):{};
 if(path==='auth/status'){const u=await session(req);return ok({user:u?publicUser(u):null,needsSetup:!(await one("SELECT id FROM users WHERE role='admin' LIMIT 1"))});}
 if(path==='auth/register'||path==='auth/setup'){
  await rate('signup:'+await digest(req.headers.get('x-vercel-forwarded-for')?.split(',')[0]||req.headers.get('x-forwarded-for')?.split(',')[0]||'local'),8,60);
  if(!/^[a-z0-9]{4,20}$/.test(b.username||''))fail('아이디는 영문 소문자와 숫자 4~20자입니다.');
  const nick=text(b.nickname,20),pw=password(b.password);if(b.password!==b.confirm)fail('비밀번호가 일치하지 않습니다.');
  const setup=path==='auth/setup';if(setup){if(!(env as any).ADMIN_SETUP_KEY||b.setupKey!==(env as any).ADMIN_SETUP_KEY)fail('관리자 설정 키가 올바르지 않습니다.',403);if(await one("SELECT id FROM users WHERE role='admin'"))fail('초기 관리자 설정은 이미 완료되었습니다.',409);}
  try{await run('INSERT INTO users(id,username,nickname,password,status,role,created_at) VALUES(?,?,?,?,?,?,?)',uid(),b.username,nick,await hashPassword(pw),setup?'active':'pending',setup?'admin':'member',now());}catch(e){if(String(e).includes('UNIQUE'))fail('이미 사용 중인 아이디입니다.',409);throw e;}
  return ok({message:setup?'관리자 계정을 만들었습니다. 로그인해 주세요.':'가입 신청이 완료되었습니다. 관리자 승인 후 이용할 수 있습니다.'},201);
 }
 if(path==='auth/login'){
  const name=String(b.username||'').slice(0,20);await rate('login-ip:'+await digest(req.headers.get('x-vercel-forwarded-for')?.split(',')[0]||req.headers.get('x-forwarded-for')?.split(',')[0]||'local'),30,15);await rate('login-user:'+name,8,15);
  const u=await one('SELECT * FROM users WHERE username=?',name);const valid=await verify(String(b.password||'').slice(0,128),u?.password||'00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000');if(!u||!valid)fail('아이디 또는 비밀번호를 확인하세요.',401);if(['suspended','withdrawn'].includes(u.status))fail('이용이 제한된 계정입니다. 관리자에게 문의하세요.',403);
  const token=uid()+uid();await run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)',await digest(token),u.id,new Date(Date.now()+12*3600000).toISOString());return ok({user:publicUser(u) },200,{'Set-Cookie':`nighton_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`});
 }
 const u=await session(req);if(!u)fail('로그인이 필요합니다.',401);
 if(path==='auth/logout'){const token=req.headers.get('cookie')?.match(/nighton_session=([^;]+)/)?.[1];if(token)await run('DELETE FROM sessions WHERE token=?',await digest(token));return ok({ok:true},200,{'Set-Cookie':'nighton_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});}
 if(path==='auth/password'){
  if(!await verify(String(b.current||''),u.password))fail('현재 비밀번호가 일치하지 않습니다.');const pw=password(b.password);if(pw!==b.confirm)fail('비밀번호가 일치하지 않습니다.');await db().batch([db().prepare('UPDATE users SET password=?,must_change=0 WHERE id=?').bind(await hashPassword(pw),u.id),db().prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id)]);return ok({message:'비밀번호가 변경되었습니다. 다시 로그인하세요.'});
 }
 if(u.status!=='active')fail(u.status==='pending'?'관리자 승인 대기 중입니다.':'이용이 제한된 계정입니다.',403);if(u.must_change)fail('임시 비밀번호를 먼저 변경하세요.',403);
 if(path==='events')return eventStream(db(),u.id);
 if(path.startsWith('admin/')&&u.role!=='admin')fail('관리자만 접근할 수 있습니다.',403);
 if(path==='admin/data'){return ok({users:(await all('SELECT * FROM users ORDER BY created_at DESC')).map(publicUser),audit:await all('SELECT a.*,u.nickname FROM audit a LEFT JOIN users u ON a.actor=u.id ORDER BY a.id DESC LIMIT 300'),cleanup:await all('SELECT * FROM cleanup ORDER BY ran_at DESC LIMIT 30'),archives:await all(`SELECT c.*,p.status payment_status FROM calls c LEFT JOIN payouts p ON p.call_id=c.id WHERE c.ended_at<? AND (p.status IS NULL OR p.status!='pending') ORDER BY c.ended_at DESC LIMIT 300`,new Date(Date.now()-7*86400000).toISOString())});}
 if(path==='admin/member'){
  const target=await one('SELECT * FROM users WHERE id=?',b.id);if(!target)fail('회원을 찾을 수 없습니다.',404);if(target.id===u.id)fail('본인의 권한 및 상태는 변경할 수 없습니다.');
  const status=b.status||target.status,role=b.role||target.role;if(!['pending','active','suspended','withdrawn'].includes(status)||!['member','admin'].includes(role))fail('잘못된 상태입니다.');
  await db().batch([db().prepare('UPDATE users SET status=?,role=? WHERE id=?').bind(status,role,target.id),db().prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),db().prepare('INSERT INTO audit(entity,entity_id,action,actor,before,after,created_at) VALUES(?,?,?,?,?,?,?)').bind('member',target.id,'회원 변경',u.id,JSON.stringify(publicUser(target)),JSON.stringify({status,role}),now())]);return ok({ok:true});
 }
 if(path==='admin/reset'){
  const target=await one('SELECT * FROM users WHERE id=?',b.id);if(!target)fail('회원을 찾을 수 없습니다.',404);text(b.reason,300);const temporary='N!'+uid().replaceAll('-','')+'9';await db().batch([db().prepare('UPDATE users SET password=?,must_change=1 WHERE id=?').bind(await hashPassword(temporary),target.id),db().prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),db().prepare('INSERT INTO audit(entity,entity_id,action,actor,after,created_at) VALUES(?,?,?,?,?,?)').bind('member',target.id,'비밀번호 초기화',u.id,JSON.stringify({reason:b.reason}),now())]);return ok({temporary});
 }
 if(path==='admin/retention'){
  const reason=text(b.reason,500);if(typeof b.legalHold!=='boolean')fail('보존 설정을 확인하세요.');if(!b.legalHold&&(!b.retainUntil||!Number.isFinite(Date.parse(b.retainUntil))))fail('검토한 보관 만료일이 필요합니다.');await run('UPDATE calls SET legal_hold=?,retain_until=?,retention_reason=?,updated_by=?,updated_at=?,version=version+1 WHERE id=?',b.legalHold?1:0,b.legalHold?null:new Date(b.retainUntil).toISOString(),reason,u.id,now(),b.id);return ok({ok:true});
 }
 if(path==='admin/cleanup'){await cleanupDatabase();return ok({ok:true});}
 if(path==='data'){
  if(!await one('SELECT id FROM cleanup WHERE id=?',now().slice(0,10)))await cleanupDatabase();
  const cs=await all('SELECT * FROM calls ORDER BY created_at DESC LIMIT 1000');const ps=await all('SELECT * FROM payouts ORDER BY updated_at DESC LIMIT 1000');const cutoff=new Date(Date.now()-7*86400000).toISOString();const ids=new Set(cs.filter(c=>visible(c,ps.find(p=>p.call_id===c.id),cutoff)).map(c=>c.id));
  const events=await all("SELECT a.id,a.entity,a.action,a.actor,a.created_at,u.nickname FROM audit a LEFT JOIN users u ON a.actor=u.id WHERE a.entity IN ('call','payout') ORDER BY a.id DESC LIMIT 30");
  return ok({calls:cs.filter(c=>ids.has(c.id)),payouts:ps.filter(p=>ids.has(p.call_id)),members:await all("SELECT id,nickname,username FROM users"),events,serverTime:now()});
 }
 if(path==='calls/create'){
  const t=now(),id=uid();const departure=text(b.departure,40);if(!Number.isFinite(Date.parse(departure)))fail('출발 시간을 확인하세요.');await run('INSERT INTO calls(id,origin,destination,fare,amount,departure,notes,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,text(b.origin),text(b.destination),money(b.fare),money(b.amount),new Date(departure).toISOString(),String(b.notes||'').slice(0,1000),u.id,t,u.id,t);return ok({id},201);
 }
 if(path==='calls/change'){
  const c=await one('SELECT * FROM calls WHERE id=?',b.id);if(!c)fail('콜을 찾을 수 없습니다.',404);if(c.version!==b.version)fail('다른 회원이 변경했습니다. 새로고침 후 다시 시도하세요.',409);
  let sql='',params:any[]=[];const t=now();
  if(b.action==='accept'){if(c.status!=='waiting')fail('이미 수락되거나 종료된 콜입니다.',409);sql="status='accepted',assignee=?,accepted_at=?";params=[u.id,t];}
  else if(b.action==='start'||b.action==='complete'){if(c.assignee!==u.id)fail('수락한 회원만 처리할 수 있습니다.',403);if(b.action==='start'&&c.status!=='accepted'||b.action==='complete'&&!['accepted','running'].includes(c.status))fail('변경할 수 없는 상태입니다.',409);sql='status=?,ended_at=?';params=[b.action==='start'?'running':'completed',b.action==='start'?null:t];}
  else if(b.action==='cancel'){if(['completed','cancelled'].includes(c.status))fail('이미 종료된 콜입니다.',409);if(c.status!=='waiting'&&!b.confirmed)fail('진행 중인 콜 취소 확인이 필요합니다.');sql="status='cancelled',ended_at=?,reason=?";params=[t,text(b.reason,500)];}
  else if(b.action==='edit'){if(['completed','cancelled'].includes(c.status))fail('종료된 콜은 지급 관리에서 수정하세요.');if(c.status!=='waiting'&&!b.confirmed)fail('진행 중인 콜 변경 확인이 필요합니다.');if(!Number.isFinite(Date.parse(b.departure)))fail('출발 시간을 확인하세요.');sql='origin=?,destination=?,fare=?,amount=?,departure=?,notes=?';params=[text(b.origin),text(b.destination),money(b.fare),money(b.amount),new Date(b.departure).toISOString(),String(b.notes||'').slice(0,1000)];}
  else fail('잘못된 작업입니다.');
  const r=await run(`UPDATE calls SET ${sql},updated_by=?,updated_at=?,version=version+1 WHERE id=? AND version=?`,...params,u.id,t,c.id,c.version);if(!r.meta.changes)fail('다른 회원이 먼저 변경했습니다.',409);return ok({ok:true});
 }
 if(path==='payouts/change'){
  const p=await one('SELECT * FROM payouts WHERE id=?',b.id);if(!p)fail('지급 내역을 찾을 수 없습니다.',404);if(p.version!==b.version)fail('다른 회원이 변경했습니다.',409);if(p.status==='paid'&&!b.confirmed)fail('지급 완료 내역 변경 확인이 필요합니다.');let sql='',params:any[]=[];const t=now();
  if(b.action==='paid'){if(p.status!=='pending')fail('지급 대기 건만 완료할 수 있습니다.',409);sql="status='paid',processed_by=?,processed_at=?";params=[u.id,t];}
  else if(b.action==='edit'){sql='amount=?,notes=?';params=[money(b.amount),String(b.notes||'').slice(0,1000)];}
  else if(b.action==='cancel'){if(p.status==='cancelled')fail('이미 취소된 기록입니다.',409);sql="status='cancelled',reason=?,processed_by=?,processed_at=?";params=[text(b.reason,500),u.id,t];}
  else fail('잘못된 작업입니다.');
  const r=await run(`UPDATE payouts SET ${sql},updated_by=?,updated_at=?,version=version+1 WHERE id=? AND version=?`,...params,u.id,t,p.id,p.version);if(!r.meta.changes)fail('다른 회원이 먼저 변경했습니다.',409);return ok({ok:true});
 }
 if(path==='admin/delete'){
  const c=await one('SELECT * FROM calls WHERE id=?',b.id);if(!c)fail('콜을 찾을 수 없습니다.',404);if(c.legal_hold||!c.retain_until||c.retain_until>now())fail('보관 의무 검토 또는 보존 기간이 남아 삭제할 수 없습니다.');if(!['completed','cancelled'].includes(c.status)||await one("SELECT id FROM payouts WHERE call_id=? AND status='pending'",c.id))fail('진행 중이거나 지급 대기인 자료는 삭제할 수 없습니다.');text(b.reason,500);await audit(u.id,'admin',c.id,'삭제 승인 사유',null,{reason:b.reason});await run('DELETE FROM calls WHERE id=? AND version=? AND legal_hold=0',c.id,c.version);return ok({ok:true});
 }
 fail('요청을 찾을 수 없습니다.',404);
 }catch(e:any){const code=e.code||400;const safe=String(e.message||'');return ok({error:safe.includes('D1_')||safe.includes('SQLITE')?'서버 처리 오류입니다. 관리자에게 문의하세요.':safe||'요청을 처리하지 못했습니다.'},code);}}
export const GET=handler;export const POST=handler;
