import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLabCommand } from "../src/cli/lab";
import { CURSOR_ORACLE_UPSTREAM } from "../src/lab/oracle/constants";
const ROOTS: string[] = [];
function tempConfigDir(){ const d=mkdtempSync(join(tmpdir(),"ocx-test-oracle-cli-")); ROOTS.push(d); return d; }
afterEach(()=>{ for(const d of ROOTS.splice(0)) rmSync(d,{recursive:true,force:true}); });
// silence console.log from printData while testing
let origLog: typeof console.log;
beforeEach(()=>{ origLog=console.log; console.log=()=>{}; });
afterEach(()=>{ console.log=origLog; });

describe("lab oracle cursor validation",()=>{
  test("rejects malformed scenario", async()=>{
    const cfg=tempConfigDir();
    const code = await handleLabCommand(["oracle","cursor","--scenario","bad path","--model","m"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("requires --scenario", async()=>{
    const cfg=tempConfigDir();
    const code = await handleLabCommand(["oracle","cursor","--model","m"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("requires --model", async()=>{
    const cfg=tempConfigDir();
    const code = await handleLabCommand(["oracle","cursor","--scenario","cursor_smoke"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("rejects nonexistent --agent-bin", async()=>{
    const cfg=tempConfigDir();
    const code=await handleLabCommand(["oracle","cursor","--scenario","cursor_smoke","--model","test","--agent-bin","/tmp/does-not-exist-zzz"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("succeeds with /bin/echo stub and returns sanitized observation", async()=>{
    const cfg=tempConfigDir();
    const code=await handleLabCommand(["oracle","cursor","--scenario","cursor_smoke","--model","test-model","--agent-bin","/bin/echo","--json"],{configDir:cfg});
    expect(code).toBe(0);
  });
  test("keepRaw flag adds rawDir with ttl and keeps 0600", async()=>{
    const cfg=tempConfigDir();
    const stub=join(cfg,"stub-agent.mjs");
    const argvFile=join(cfg,"argv.json");
    writeFileSync(stub, `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from "node:fs";\nimport {join} from "node:path";\nconst args=process.argv.slice(2);\nif(args[0]==="--version"){console.log("2026.08.04");process.exit(0)}\nconst config=JSON.parse(readFileSync(join(process.env.CURSOR_CONFIG_DIR,"cli-config.json"),"utf8"));\nwriteFileSync(${JSON.stringify(argvFile)},JSON.stringify({args,config,endpoint:process.env.CURSOR_API_ENDPOINT}));\n`, {mode:0o700});
    if(process.platform!=="win32") chmodSync(stub,0o700);
    const code=await handleLabCommand(["oracle","cursor","--scenario","cursor_smoke","--model","tm","--agent-bin",stub,"--keep-raw","--json"],{configDir:cfg});
    expect(code).toBe(0);
    const captured=JSON.parse(readFileSync(argvFile,"utf8")) as {args:string[];config:{network?:{useHttp1ForAgent?:boolean}};endpoint?:string};
    const args=captured.args;
    expect(args).toContain("stream-json");
    expect(args).toContain("--trust");
    expect(args.slice(args.indexOf("--model"),args.indexOf("--model")+2)).toEqual(["--model","tm"]);
    expect(captured.config.network?.useHttp1ForAgent).toBe(true);
    expect(captured.endpoint).toBe(args[args.indexOf("--endpoint")+1]);
  });
});

describe("run --oracle-run validation",()=>{
  test("--oracle-run requires an id value", async()=>{
    const cfg=tempConfigDir();
    const code=await handleLabCommand(["run","--layer","protocol_conformance","--scenario","other","--model","m","--oracle-run"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("--oracle-run rejects an unknown stored id", async()=>{
    const cfg=tempConfigDir();
    const code=await handleLabCommand(["run","--layer","protocol_conformance","--scenario","cursor_smoke","--model","m","--oracle-run","cursor-missing-1234"],{configDir:cfg});
    expect(code).toBe(2);
  });
  test("persists a matching oracle reference on the manual Lab run", async()=>{
    const cfg=tempConfigDir();
    const scenario="tools-core.protocol.parallel-correlation";
    const model="m";
    const {runCursorOracle}=await import("../src/lab/oracle/runner");
    const {loadLabAutomationState}=await import("../src/lab/automation/persistence");
    const oracle=(await runCursorOracle({scenario,model,agentBin:"/bin/echo"},{configDir:cfg,timeoutMs:8000})).observation;
    const printed:string[]=[];
    console.log=(...args:unknown[])=>{printed.push(args.map(String).join(" "));};
    const code=await handleLabCommand([
      "run","--layer","protocol_conformance","--scenario",scenario,
      "--model",model,"--oracle-run",oracle.oracleRunId,"--json",
    ],{configDir:cfg});
    expect(code).toBe(0);
    const paired=loadLabAutomationState(cfg).runs.find(run=>run.oracleRunId===oracle.oracleRunId);
    expect(paired).toBeDefined();
    expect(paired?.scenarioId).toBe(scenario);
    const payload=JSON.parse(printed.find(line=>line.startsWith("{"))??"{}") as {comparison?:{status?:string}};
    expect(payload.comparison?.status).toBe("INSUFFICIENT_BEHAVIORAL_EQUIVALENCE");
  });
});

describe("direct runner isolate",()=>{
  test("runCursorOracle malformed scenario rejected", async()=>{
    const {runCursorOracle,readStoredCursorOracle}=await import("../src/lab/oracle/runner");
    await expect(runCursorOracle({scenario: "bad path", model:"m"},{configDir: tempConfigDir()})).rejects.toThrow(/invalid scenario/);
  });
  test("runCursorOracle with /bin/echo produces observation V1 shape", async()=>{
    const cfg=tempConfigDir();
    const {runCursorOracle,readStoredCursorOracle}=await import("../src/lab/oracle/runner");
    const res=await runCursorOracle({scenario:"cursor_smoke", model:"my-model", agentBin:"/bin/echo", keepRaw:false},{configDir:cfg, timeoutMs: 8000});
    const o=res.observation;
    expect(o.schemaVersion).toBe(1);
    expect(o.oracle).toBe("cursor");
    expect(o.scenario).toBe("cursor_smoke");
    expect(o.model).toBe("my-model");
    expect(o.oracleRunId).toMatch(/^cursor-/);
    expect(typeof o.startedAt).toBe("number");
    expect(typeof o.completedAt).toBe("number");
    expect(o.diagnostics.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(o)).not.toContain("rawDir");
    expect(JSON.stringify(o)).not.toContain("baseUrl");
    expect(["pass","fail","blocked","inconclusive"]).toContain(o.outcome);
    expect(JSON.stringify(o)).not.toContain("secret");
    expect(res.exitCode).toBeGreaterThanOrEqual(0);
    expect(readStoredCursorOracle(o.oracleRunId,cfg)).toEqual(o);
  });
  test("keepRaw true sets rawDir and ttl", async()=>{
    const cfg=tempConfigDir();
    const {runCursorOracle}=await import("../src/lab/oracle/runner");
    const res=await runCursorOracle({scenario:"cursor_smoke", model:"mm", agentBin:"/bin/echo", keepRaw:true},{configDir:cfg, timeoutMs: 8000});
    expect(res.rawDir).toBeDefined();
    expect(res.rawTtlMs).toBe(24*60*60*1000);
    if(res.rawDir) expect(existsSync(res.rawDir)).toBe(true);
  });
  test("timeout remains a blocked oracle result even when SIGTERM closes the child", async()=>{
    const cfg=tempConfigDir();
    const stub=join(cfg,"hanging-agent.mjs");
    writeFileSync(stub,`#!/usr/bin/env node\nif(process.argv[2]==="--version"){console.log("2026.08.04");process.exit(0)}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
    if(process.platform!=="win32") chmodSync(stub,0o700);
    const {runCursorOracle}=await import("../src/lab/oracle/runner");
    const res=await runCursorOracle({scenario:"cursor_smoke",model:"m",agentBin:stub},{configDir:cfg,timeoutMs:30});
    expect(res.exitCode).toBe(124);
    expect(res.observation.outcome).toBe("blocked");
    expect(res.observation.diagnostics).toContainEqual({code:"agent_timeout"});
  });
  test("records only the hidden rule-canary adherence boolean", async()=>{
    const cfg=tempConfigDir();
    const stub=join(cfg,"canary-agent.mjs");
    writeFileSync(stub,`#!/usr/bin/env node\nif(process.argv[2]==="--version"){console.log("2026.08.04");process.exit(0)}\nconsole.log(JSON.stringify({type:"assistant",text:"OCX_CURSOR_ORACLE_RULE_CANARY_V1"}));\n`,{mode:0o700});
    if(process.platform!=="win32") chmodSync(stub,0o700);
    const {runCursorOracle}=await import("../src/lab/oracle/runner");
    const res=await runCursorOracle({scenario:"cursor_smoke",model:"m",agentBin:stub},{configDir:cfg,timeoutMs:1000});
    expect(res.observation.behavior).toEqual({instructionCanaryObserved:true});
    expect(JSON.stringify(res.observation)).not.toContain("OCX_CURSOR_ORACLE_RULE_CANARY_V1");
  });
  test("abort terminates the child and returns a blocked observation", async()=>{
    const cfg=tempConfigDir();
    const stub=join(cfg,"aborted-agent.mjs");
    writeFileSync(stub,`#!/usr/bin/env node\nif(process.argv[2]==="--version"){console.log("2026.08.04");process.exit(0)}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
    if(process.platform!=="win32") chmodSync(stub,0o700);
    const controller=new AbortController();
    setTimeout(()=>controller.abort(),30);
    const {runCursorOracle}=await import("../src/lab/oracle/runner");
    const res=await runCursorOracle({scenario:"cursor_smoke",model:"m",agentBin:stub},{configDir:cfg,timeoutMs:1000,signal:controller.signal});
    expect(res.exitCode).toBe(130);
    expect(res.observation.outcome).toBe("blocked");
    expect(res.observation.diagnostics).toContainEqual({code:"agent_aborted"});
  });
});
