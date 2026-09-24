import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessM0} from '../src/governance/host.mjs';

/** Read-only evidence diagnosis. Never boots a host, installs files, or approves work. */
export async function diagnoseM0(reportPath) {
  if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath)) throw new Error('An absolute --report path is required.');
  const bytes=await fs.readFile(reportPath);
  if(bytes.length>1024*1024)throw new Error('M0 report exceeds 1 MiB.');
  const report=JSON.parse(bytes.toString('utf8'));
  if(report.kind!=='m0-live-report'||!Array.isArray(report.checks))throw new Error('Not an M0 live-probe report.');
  const assessment=assessM0(report.checks);
  return {...assessment,report:reportPath,
    authority:'Diagnostic only. Receipt labels are not independent validation or review; this command cannot grant GO.',
    implementationAuthorized:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==4||!['--report','--config','--state'].includes(process.argv[2]))throw new Error('Usage: node scripts/doctor-governance.mjs --report <absolute-report.json> | --config <absolute-config.json> | --state <absolute-config.json>');
    const report=process.argv[2]==='--report'?await diagnoseM0(process.argv[3]):await diagnoseGovernanceM4({kind:process.argv[2].slice(2),configPath:process.argv[3]});console.log(JSON.stringify(report,null,2));
    process.exitCode=process.argv[2]==='--report'?(report.decision==='NO_GO'?2:0):(report.consistent===false?2:0);
  }catch(error){console.error(error.message);process.exitCode=1;}
}

/** Closed M4 selection. Cold inspection never opens an owner, creates a lock or imports a generated entry. */
export async function diagnoseGovernanceM4(input) {
  const {ownedJson,exact,digest}=await import('../src/governance/contracts.mjs');
  const request=ownedJson(input);exact(request,['kind','configPath']);
  if(!['config','state'].includes(request.kind))throw Object.assign(new Error('M4_DOCTOR_SELECTOR'),{code:'M4_DOCTOR_SELECTOR'});
  const {readGovernanceConfigM4}=await import('./setup-governance.mjs');
  const {config,sha256}=readGovernanceConfigM4(request.configPath);
  if(request.kind==='config')return ownedJson({kind:'m4-config-diagnostic',consistent:true,mode:config.mode,configSha256:sha256,
    planDigest:digest(config.plan),origin:'unauthenticated-diagnostic',headAuthenticity:'unproven',executionEligible:false,
    reason:'STARTUP_NOT_PROBED',hostStarted:false,locksCreated:0,providerCalls:0,operationallyAccepted:false});
  const {inspectGovernanceM4}=await import('../src/governance/store.mjs');
  const {project,governance,...protectedRoots}=config.roots;
  try {
    const result=await inspectGovernanceM4({root:governance,projectRoot:project,protectedRoots:Object.values(protectedRoots)},
      {kind:'status',id:null,offset:0,limit:1,cursor:null});
    if(readGovernanceConfigM4(request.configPath).sha256!==sha256)throw Object.assign(new Error('M4_DOCTOR_CONFIG_CHANGED'),{code:'M4_DOCTOR_CONFIG_CHANGED'});
    return ownedJson(result);
  } catch(error) {
    return ownedJson({kind:'m4-state-diagnostic',consistent:false,origin:'cold-diagnostic',headAuthenticity:'unproven',
      reason:typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'STATE_INSPECTION_FAILED',
      locationId:digest(governance),executionEligible:false,hostStarted:false,locksCreated:0,operationallyAccepted:false});
  }
}
