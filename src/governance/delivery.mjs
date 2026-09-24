import {randomBytes,randomUUID} from 'node:crypto';
import {ownedJson,digest,same,need,exact,boundedResponseM4,validateQualifyRequestM4B,validateExportRequestM4B,validateQualificationRecordM4B,validateDeliveryReservationM4B,validateDeliveryReceiptM4B,validateDeliveryMarkerM4B,qualificationReferencesM4B,ACCEPTANCE_EVENT_V2,validateAcceptRequestV2,validateAcceptanceReceiptV2,acceptanceScopeCleanV2,evaluateAcceptanceV2,acceptanceDigestV2} from './contracts.mjs';
import {claimGovernanceDeliveryOwnerM4B} from './controller.mjs';
import {verifyDeliveryDestinationM4B,prepareCustodyDeliveryM4B,inspectDeliveryOutputM4B} from './workspace.mjs';
import {inspectGovernanceStoreV2,inspectGovernanceM4,readQualificationArtifactM4B} from './store.mjs';

const flags=Object.freeze({schemaVersion:1,qualificationOnly:true,operationallyAccepted:false,gateActive:false});
const nonce=()=>randomBytes(32).toString('hex');
function workPacket(state,next){
  const findings=new Map();for(const result of state?.results??[])for(const finding of result.submission?.findings??[]){const key=result.role+':'+finding.id;if(finding.status==='resolved'){if(['completed-pass','completed-fail'].includes(result.outcome))findings.delete(key);}else findings.set(key,{role:result.role,id:finding.id,criterionId:finding.criterionId,status:finding.status,severity:finding.severity});}
  need(findings.size<=64,'WORK_PACKET_FINDING_LIMIT');return {jobId:state?.jobId??null,planDigest:state?digest(state.plan):null,criteriaDigest:state?digest(state.plan.criteria):null,businessPhase:state?.phase??'EMPTY',candidateDigest:state?.candidate??null,findings:[...findings.values()],attemptsUsed:state?.attempts.length??0,allowedNextAction:next};
}
export function createDeliveryCoordinatorM4B(token){
  const grant=claimGovernanceDeliveryOwnerM4B(token),{owner,bridge,destination,failpoint}=grant,destinationId=verifyDeliveryDestinationM4B(destination).destinationId;
  let phase='none',qualification=null,qualificationEvent=null,reservation=null,receipt=null,receiptEvent=null,copy=null,active=null,stopped=false,closing=null,consumed=false,accepted=null;const ownerReads=new Set();
  const check=()=>{need(!stopped,'DELIVERY_STOPPED');bridge.check();need(verifyDeliveryDestinationM4B(destination).destinationId===destinationId,'DESTINATION_CHANGED');return true;};
  const hit=async(name,data={})=>{if(failpoint)await failpoint(name,ownedJson(data));check();};
  function stopDelivery(){if(closing)return closing;stopped=true;consumed=true;copy?.revoke();closing=(async()=>{await Promise.allSettled([...(active?[active]:[]),...ownerReads]);if(copy)await copy.close();})();return closing;}
  bridge.installStop(stopDelivery);
  async function readOwner(fn){need(!stopped&&!active,'DELIVERY_BUSY_OR_STOPPED');const task=Promise.resolve().then(fn);ownerReads.add(task);try{const value=await task;need(!stopped,'DELIVERY_STOPPED');return value;}finally{ownerReads.delete(task);}}
  function run(fn){need(!stopped&&!active,'DELIVERY_BUSY_OR_STOPPED');need(ownerReads.size===0,'QUALIFICATION_NOT_IDLE');bridge.begin();const task=Promise.resolve().then(fn);active=task;task.then(()=>{if(active===task)active=null;bridge.end();},()=>{if(active===task)active=null;bridge.end();});return task;}
  const common=(kind,state,head)=>({...flags,kind,id:randomUUID(),nonce:nonce(),jobId:state.jobId,projectId:state.projectId,generation:state.generation,priorHeadDigest:head,candidateDigest:state.candidate});
  function description(state){const next=stopped?'none':phase==='completed'?'none':qualification&&!consumed&&phase==='none'?'export':!qualification&&state?.phase==='DIAGNOSTIC_READY'?'qualify':'stage';return {qualificationOnly:true,operationallyAccepted:false,gateActive:false,qualifiedAccepted:!!qualification&&!stopped&&phase!=='uncertain',finalizationId:qualification?.id??null,qualificationReceiptDigest:qualification?digest(qualification):null,destinationId,deliveryPhase:phase,deliveryReceiptDigest:receipt?digest(receipt):null,allowedNextAction:next,workPacket:workPacket(state,next)};}
  async function status(){return readOwner(async()=>{const page=await owner.status();return boundedResponseM4({...page,qualification:description(bridge.state())});});}
  async function accept(request){const r=validateAcceptRequestV2(request);return run(async()=>{
    need(!accepted&&!qualification&&!consumed&&phase==='none','ACCEPTANCE_NOT_ALLOWED');check();
    const before=await bridge.head();check();need(before.eventDigest===r.headDigest&&before.payload.candidate===r.candidateDigest,'STALE_ACCEPT_REQUEST');
    const proof=await bridge.evidence();check();need(proof.state.phase==='DIAGNOSTIC_READY'&&proof.state.candidate===r.candidateDigest,'ACCEPTANCE_NOT_READY');
    const identityRecheck=check()===true;let custodyVerified;try{custodyVerified=proof.custody.verify()===true;}catch{custodyVerified=false;}
    const scopeClean=acceptanceScopeCleanV2(proof.state.plan,proof.descriptor,proof.state.candidate);
    const stable=await bridge.head();check();const journalHealthy=stable.eventDigest===before.eventDigest&&bridge.journal()===true;
    const facts={custodyVerified,journalHealthy,scopeClean,identityRecheck},evaluation=evaluateAcceptanceV2(proof.state,facts);need(evaluation.predicatesHold===true,'ACCEPTANCE_PREDICATES_FAILED');
    const receipt=validateAcceptanceReceiptV2({schemaVersion:1,kind:'acceptance-recorded',operationallyAccepted:false,gateActive:false,id:randomUUID(),nonce:nonce(),jobId:proof.state.jobId,projectId:proof.state.projectId,generation:proof.state.generation,priorHeadDigest:before.eventDigest,candidateDigest:proof.state.candidate,planDigest:digest(proof.state.plan),acceptanceDigest:acceptanceDigestV2(proof.state.plan),facts,...qualificationReferencesM4B(proof.state)});
    let attempted=false;try{await hit('acceptance.record.beforeRecord',{candidateDigest:r.candidateDigest});attempted=true;const event=await bridge.record(ACCEPTANCE_EVENT_V2,receipt);check();const read=await bridge.readArtifact(digest(receipt));check();need(same(read,receipt),'ACCEPTANCE_ARTIFACT_CHANGED');await hit('acceptance.record.afterAck',{eventDigest:event.eventDigest});accepted=receipt;return boundedResponseM4({schemaVersion:1,qualificationOnly:true,operationallyAccepted:false,gateActive:false,acceptanceRecorded:true,acceptanceReceiptDigest:digest(receipt),candidateDigest:receipt.candidateDigest,headDigest:event.eventDigest,allowedNextAction:'qualify'});}catch(error){if(attempted){consumed=true;phase='uncertain';bridge.poison();}throw error;}
  });}
  async function qualify(request){const r=validateQualifyRequestM4B(request);return run(async()=>{
    need(!qualification&&!consumed&&phase==='none','QUALIFICATION_ALREADY_FINALIZED');check();const before=await bridge.head();check();need(before.eventDigest===r.headDigest&&before.payload.candidate===r.candidateDigest,'STALE_QUALIFICATION_REQUEST');
    const proof=await bridge.evidence();check();need(proof.state.phase==='DIAGNOSTIC_READY'&&proof.state.candidate===r.candidateDigest,'QUALIFICATION_NOT_READY');const stable=await bridge.head();check();need(stable.eventDigest===before.eventDigest,'QUALIFICATION_HEAD_CHANGED');
    const record=validateQualificationRecordM4B({...common('qualification-finalized',proof.state,before.eventDigest),qualifiedAccepted:true,planDigest:digest(proof.state.plan),environmentDigest:proof.state.plan.environmentDigest,executionPolicyDigest:digest(proof.state.plan.executionPolicy),...qualificationReferencesM4B(proof.state)});
    let attempted=false;try{await hit('qualification.finalize.beforeRecord',{candidateDigest:r.candidateDigest});attempted=true;const event=await bridge.record('QUALIFICATION_FINALIZED',record);check();const read=await bridge.readArtifact(digest(record));check();need(same(read,record),'QUALIFICATION_ARTIFACT_CHANGED');await hit('qualification.finalize.afterAck',{eventDigest:event.eventDigest});qualification=record;qualificationEvent=event;return boundedResponseM4({...flags,qualifiedAccepted:true,finalizationId:record.id,qualificationReceiptDigest:digest(record),candidateDigest:record.candidateDigest,headDigest:event.eventDigest,allowedNextAction:'export'});}catch(error){if(attempted){consumed=true;phase='uncertain';bridge.poison();}throw error;}
  });}
  async function deliver(request){const r=validateExportRequestM4B(request);return run(async()=>{
    need(qualification&&!consumed&&phase==='none'&&r.qualificationReceiptDigest===digest(qualification)&&r.destinationId===destinationId,'DELIVERY_NOT_AUTHORIZED');check();consumed=true;phase='reserved';
    try{
      const before=await bridge.head();check();need(before.eventDigest===qualificationEvent.eventDigest,'FINALIZATION_HEAD_CHANGED');
      const proof=await bridge.evidence();check();const qualified=await bridge.readArtifact(r.qualificationReceiptDigest);check();need(same(qualified,qualification)&&same(qualificationReferencesM4B(proof.state),qualificationReferencesM4B(before.payload))&&proof.descriptor.candidateDigest===qualification.candidateDigest,'QUALIFICATION_ARTIFACT_CHANGED');
      const reservation=validateDeliveryReservationM4B({...common('delivery-reserved',proof.state,before.eventDigest),qualificationReceiptDigest:r.qualificationReceiptDigest,destinationId,descriptorDigest:digest(proof.descriptor),payloadInventoryDigest:digest(proof.descriptor.files)});
      const reservationEvent=await bridge.record('DELIVERY_RESERVED',reservation);check();await hit('delivery.reserve.afterAck',{eventDigest:reservationEvent.eventDigest,destinationId});
      receipt=validateDeliveryReceiptM4B({...common('delivery-completed',proof.state,reservationEvent.eventDigest),qualificationReceiptDigest:r.qualificationReceiptDigest,reservationId:reservation.id,reservationEventDigest:reservationEvent.eventDigest,destinationId,descriptorDigest:reservation.descriptorDigest,payloadInventoryDigest:reservation.payloadInventoryDigest});
      copy=await prepareCustodyDeliveryM4B(proof.custody,{destination,qualificationReceipt:receipt,authorize:check,...(failpoint?{failpoint}:{})});check();await copy.copy();check();copy.verify();
      receiptEvent=await bridge.record('DELIVERY_COMPLETED',receipt);check();const stored=await bridge.readArtifact(digest(receipt));check();need(same(stored,receipt),'DELIVERY_RECEIPT_CHANGED');await hit('delivery.completed.afterAck',{eventDigest:receiptEvent.eventDigest,receiptHash:digest(receipt)});
      const marker=validateDeliveryMarkerM4B({...flags,kind:'qualification-delivery-complete',eventDigest:receiptEvent.eventDigest,receiptHash:digest(receipt),candidateDigest:receipt.candidateDigest,destinationId});await copy.complete(marker);check();copy.verify();const final=await bridge.head();check();need(final.eventDigest===receiptEvent.eventDigest,'DELIVERY_HEAD_CHANGED');phase='completed';return boundedResponseM4({...flags,deliveryPhase:'completed',candidateDigest:receipt.candidateDigest,destinationId,qualificationReceiptDigest:r.qualificationReceiptDigest,deliveryReceiptDigest:digest(receipt),eventDigest:receiptEvent.eventDigest,allowedNextAction:'none'});
    }catch(error){phase='uncertain';copy?.revoke();bridge.poison();if(copy)try{await copy.close();}catch(cleanup){throw new AggregateError([error,cleanup],'DELIVERY_AND_CLEANUP_FAILED');}throw error;}
  });}
  return Object.freeze({...owner,status,read:request=>readOwner(async()=>{const page=await owner.read(request);return boundedResponseM4({...page,qualification:description(bridge.state())});}),reassess:headDigest=>readOwner(()=>owner.reassess(headDigest)),diagnosticReadiness:()=>readOwner(()=>owner.diagnosticReadiness()),accept,qualify,export:deliver});
}

const defaultRead=()=>({kind:'status',id:null,offset:0,limit:1,cursor:null});
export async function inspectGovernanceM4B(storeOptions,deliveryConfig,request=defaultRead()){
  const snapshot=await inspectGovernanceStoreV2(storeOptions),page=await inspectGovernanceM4(storeOptions,request);need(snapshot.latest?.eventDigest===page.headDigest,'STALE_CURSOR');
  const qualified=snapshot.history.find(e=>e.type==='QUALIFICATION_FINALIZED'),reservation=snapshot.history.find(e=>e.type==='DELIVERY_RESERVED'),completed=snapshot.history.find(e=>e.type==='DELIVERY_COMPLETED');let phase=reservation?'reserved':'none',receiptHash=completed?.artifacts[0]??null;
  if(completed){
    try{const receiptPage=await inspectGovernanceM4(storeOptions,{kind:'artifact',id:receiptHash,offset:0,limit:8192,cursor:null});need(receiptPage.headDigest===page.headDigest,'STALE_CURSOR');
      // Cold output verification requires the exact protected receipt, not a public projection.
      const exactReceipt=await readQualificationArtifactM4B(storeOptions,{revision:completed.revision,hash:receiptHash});await inspectDeliveryOutputM4B(deliveryConfig,exactReceipt,completed.eventDigest);phase='completed';
    }catch{phase='uncertain';}
  }
  const after=await inspectGovernanceStoreV2(storeOptions);need(after.latest?.eventDigest===page.headDigest,'STALE_CURSOR');return boundedResponseM4({...page,qualification:{qualificationOnly:true,operationallyAccepted:false,gateActive:false,qualifiedAccepted:false,finalizationId:null,qualificationReceiptDigest:qualified?.artifacts[0]??null,destinationId:deliveryConfig.destinationId,deliveryPhase:phase,deliveryReceiptDigest:receiptHash,allowedNextAction:'none',headAuthenticity:'unproven',workPacket:workPacket(snapshot.latest?.payload??null,'none')}});
}
