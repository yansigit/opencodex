import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ORACLE_UPSTREAM, CURSOR_ORACLE_LOOPBACK_HOST, CURSOR_ORACLE_SCRATCH_SUBDIR, CURSOR_ORACLE_RAW_TTL_MS, CURSOR_ORACLE_MAX_RAW_BYTES } from "../src/lab/oracle/constants";
import { createIsolatedOracleEnv, ensureOracleRawDir, writeRawScratch, purgeExpiredRaw, assertUnderRoot } from "../src/lab/oracle/isolate";
import { createLoopbackProxy } from "../src/lab/oracle/loopback";
import { labScratchDir } from "../src/lab/paths";
const ROOTS: string[] = [];
function tempConfigDir(): string { const d = mkdtempSync(join(tmpdir(), "ocx-test-oracle-")); ROOTS.push(d); return d; }
afterEach(()=>{ for(const d of ROOTS.splice(0)) try{rmSync(d,{recursive:true,force:true})}catch{}});
describe("oracle constants are hard-coded",()=>{test("upstream is api2.cursor.sh and loopback is 127.0.0.1",()=>{expect(CURSOR_ORACLE_UPSTREAM).toBe("https://api2.cursor.sh");expect(CURSOR_ORACLE_LOOPBACK_HOST).toBe("127.0.0.1");expect(CURSOR_ORACLE_SCRATCH_SUBDIR).toBe("oracle-raw");expect(CURSOR_ORACLE_RAW_TTL_MS).toBe(24*60*60*1000);expect(CURSOR_ORACLE_MAX_RAW_BYTES).toBe(2*1024*1024);});});
describe("createIsolatedOracleEnv",()=>{test("creates config/data/workspace/home under tmp with 0700 and cleans up",()=>{const cfg=tempConfigDir();const env=createIsolatedOracleEnv({configDir:cfg});ROOTS.push(env.root);expect(existsSync(env.root)).toBe(true);expect(existsSync(env.configDir)).toBe(true);expect(existsSync(env.dataDir)).toBe(true);expect(existsSync(env.workspaceDir)).toBe(true);expect(existsSync(env.homeDir)).toBe(true);if(process.platform!=="win32"){for(const d of [env.root,env.configDir,env.dataDir,env.workspaceDir,env.homeDir]) expect((statSync(d).mode & 0o777)).toBe(0o700);} const root=env.root;env.cleanup();expect(existsSync(root)).toBe(false);});});
describe("ensureOracleRawDir",()=>{test("creates lab scratch oracle-raw 0700 idempotently",()=>{const cfg=tempConfigDir();const dir=ensureOracleRawDir(cfg);expect(dir).toBe(join(labScratchDir(cfg),CURSOR_ORACLE_SCRATCH_SUBDIR));expect(existsSync(dir)).toBe(true);if(process.platform!=="win32") expect((statSync(dir).mode & 0o777)).toBe(0o700);expect(ensureOracleRawDir(cfg)).toBe(dir);});});
describe("writeRawScratch and purgeExpiredRaw",()=>{test("writes 0600 file with random suffix and correct content",()=>{const cfg=tempConfigDir();const p=writeRawScratch({configDir:cfg,prefix:"oracle-req",bytes:Buffer.from("hello"),suffix:".bin"});expect(existsSync(p)).toBe(true);expect(readFileSync(p).toString()).toBe("hello");if(process.platform!=="win32") expect((statSync(p).mode & 0o777)).toBe(0o600);expect(writeRawScratch({configDir:cfg,prefix:"oracle-req",bytes:Buffer.from("world"),suffix:".bin"})).not.toBe(p);});test("purgeExpiredRaw removes only old regular files",()=>{const cfg=tempConfigDir();const fresh=writeRawScratch({configDir:cfg,prefix:"oracle-req",bytes:Buffer.from("fresh"),suffix:".bin"});const old=writeRawScratch({configDir:cfg,prefix:"oracle-req",bytes:Buffer.from("old"),suffix:".bin"});const past=Date.now()-CURSOR_ORACLE_RAW_TTL_MS-1000;const t=new Date(past);utimesSync(old,t,t);const target=join(cfg,"outside.bin");writeFileSync(target,"outside");const link=join(ensureOracleRawDir(cfg),"linked.bin");if(process.platform!=="win32") symlinkSync(target,link);expect(purgeExpiredRaw(cfg,Date.now())).toBe(1);expect(existsSync(old)).toBe(false);expect(existsSync(fresh)).toBe(true);expect(existsSync(target)).toBe(true);if(process.platform!=="win32") expect(existsSync(link)).toBe(true);});});
describe("assertUnderRoot",()=>{test("passes inside root and throws on escape",()=>{const cfg=tempConfigDir();const env=createIsolatedOracleEnv({configDir:cfg});ROOTS.push(env.root);expect(()=>assertUnderRoot(env.root,join(env.root,"a/b"))).not.toThrow();expect(()=>assertUnderRoot(env.root,"/tmp")).toThrow();env.cleanup();});});
describe("createLoopbackProxy",()=>{test("binds to 127.0.0.1 random port hard-coded upstream and sanitizes",async()=>{const cfg=tempConfigDir();const proxy=await createLoopbackProxy({configDir:cfg,keepRaw:false,fetchImpl:async()=>new Response("ok")});try{expect(proxy.host).toBe("127.0.0.1");expect(proxy.upstream).toBe(CURSOR_ORACLE_UPSTREAM);expect(proxy.port).toBeGreaterThan(0);expect(proxy.baseUrl).toBe(`http://127.0.0.1:${proxy.port}`);const res=await fetch(proxy.baseUrl+"/v1/test?token=secret",{method:"POST",headers:{"Authorization":"Bearer secret-value","x-cursor-api-key":"key123","content-type":"application/json"},body:JSON.stringify({hello:"world"})});const obs=proxy.getObservation();expect(obs.method).toBe("POST");expect(obs.path).toBe("/v1/test");expect(JSON.stringify(obs)).not.toContain("secret-value");expect(JSON.stringify(obs)).not.toContain("key123");expect(obs.requestByteLength).toBeGreaterThan(0);expect(obs.requestSanitized).toBe(true);expect(obs.rawPaths).toBeUndefined();expect(await res.text()).toBe("ok");}finally{await proxy.close();}});test("keepRaw true writes 0600 raw files",async()=>{const cfg=tempConfigDir();const proxy=await createLoopbackProxy({configDir:cfg,keepRaw:true,fetchImpl:async()=>new Response("raw-response")});try{await fetch(proxy.baseUrl+"/v1/ping",{method:"POST",body:"raw-body"});const obs=proxy.getObservation();expect(obs.rawPaths?.length).toBe(2);for(const p of obs.rawPaths??[]) {expect(existsSync(p)).toBe(true);if(process.platform!=="win32") expect((statSync(p).mode & 0o777)).toBe(0o600);} }finally{await proxy.close();}});test("never observes or retains auth exchange bodies",async()=>{const cfg=tempConfigDir();const proxy=await createLoopbackProxy({configDir:cfg,keepRaw:true,admissionToken:"expected",fetchImpl:async()=>new Response("auth-response")});try{expect((await fetch(proxy.baseUrl+"/auth/exchange_user_api_key",{method:"POST",body:"auth-request"})).status).toBe(200);const obs=proxy.getObservation();expect(obs.rawPaths).toEqual([]);expect(obs.endpointCounts).toEqual({});expect(obs.requestByteLength).toBe(0);expect(obs.responseByteLength).toBe(0);expect(JSON.stringify(obs)).not.toContain("auth");}finally{await proxy.close();}});});

test("oracle admission header rejects unrelated local callers", async () => {
  const cfg=tempConfigDir();
  const proxy=await createLoopbackProxy({configDir:cfg,admissionToken:"expected"});
  try {
    expect((await fetch(proxy.baseUrl+"/agent.v1.AgentService/Run",{method:"POST"})).status).toBe(403);
  } finally { await proxy.close(); }
});

test("oracle rejects off-origin request targets without forwarding credentials", async () => {
  const cfg=tempConfigDir();
  let forwarded=false;
  const proxy=await createLoopbackProxy({
    configDir:cfg,
    admissionToken:"expected",
    fetchImpl:async()=>{forwarded=true;return new Response("unexpected");},
  });
  try {
    const res=await new Promise<Response>((resolve,reject)=>{
      const socket=Bun.connect({
        hostname:proxy.host,
        port:proxy.port,
        socket:{
          open(s){s.write("POST //evil.example/steal HTTP/1.1\r\nHost: 127.0.0.1\r\nx-ocx-oracle-token: expected\r\nAuthorization: Bearer secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");},
          data(_s,data){resolve(new Response(data));},
          error(_s,error){reject(error);},
        },
      });
      void socket.catch(reject);
    });
    expect(await res.text()).toContain("403 Forbidden");
    expect(forwarded).toBe(false);
  } finally { await proxy.close(); }
});

test("oracle disables upstream redirects", async () => {
  const cfg=tempConfigDir();
  let redirect:RequestRedirect|undefined;
  const proxy=await createLoopbackProxy({configDir:cfg,fetchImpl:async(_input,init)=>{redirect=init?.redirect;return new Response("ok");}});
  try {
    expect((await fetch(proxy.baseUrl+"/v1/ping")).status).toBe(200);
    expect(redirect).toBe("error");
  } finally { await proxy.close(); }
});

test("official bootstrap RPCs remain opaque without agent-only admission headers", async () => {
  const cfg=tempConfigDir();
  const proxy=await createLoopbackProxy({configDir:cfg,keepRaw:true,admissionToken:"expected",fetchImpl:async()=>new Response("bootstrap")});
  try {
    expect((await fetch(proxy.baseUrl+"/aiserver.v1.DashboardService/GetMe",{method:"POST",body:"identity"})).status).toBe(200);
    const obs=proxy.getObservation();
    expect(obs.endpointCounts).toEqual({});
    expect(obs.requestByteLength).toBe(0);
    expect(obs.rawPaths).toEqual([]);
  } finally { await proxy.close(); }
});
