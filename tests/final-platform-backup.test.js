import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/server.js';
import {createLocalBackup,validateBackup} from '../src/backup.js';

const secret=()=>`Synthetic-${randomBytes(16).toString('hex')}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const status=code=>error=>error.status===code;
const denied=async()=>{throw new Error('External transport forbidden in backup fixture');};
const protectedTables=[
  'support_grants','support_audit','auth_google_identities',
  'service_principals','service_principal_usage','service_principal_receipts','service_principal_audit','service_handoff_requests',
  'billing_contracts','billing_contract_versions','billing_invoices','billing_usage','billing_settlements','billing_settlement_reversals','billing_audit','billing_requests',
  'commercial_account_requests','commercial_account_audit',
  'auth_invitations','auth_sessions','auth_session_ids','auth_password_resets','auth_email_challenges',
  'team_chat_rooms','team_chat_members','team_chat_messages','team_chat_audit','email_outbox'
];
function fingerprints(db){
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  return Object.fromEntries(names.map(name=>{
    const rows=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key] instanceof Uint8Array?{binary:Buffer.from(row[key]).toString('hex')}:row[key]])))).sort();
    return [name,{count:rows.length,sha256:sha(JSON.stringify(rows))}];
  }));
}
function application(databasePath,key,providerCall=async()=>({text:'Proposta sintética preservada no backup.'})){return createApp({databasePath,serviceKey:key,providerCall,gatewayOptions:{authKey:key,socketFactory:denied},telegramOptions:{authKey:key,polling:false,fetchImpl:denied},emailOptions:{key,apiKey:'',from:'',fetchImpl:denied},googleOptions:{clientId:''},mcpFetchImpl:denied});}
async function closeApp(app){
  for(const controller of app.runtime.controllers.values())controller.abort();
  app.server.emit('close');
  await Promise.all([app.gateway.close(),app.telegram.close(),app.email.close(),app.bridge.close()]);
  app.store.close();
}
// validateBackup owns the normal temporary restore. This second, test-only restore
// opens the authenticated format to verify the application's recovered authority.
async function restoreFixture(file,key,target){
  const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString(),'MEPCHATB');assert.equal(bytes[8],1);assert.equal(bytes[9],1);
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(10,22));decipher.setAAD(bytes.subarray(0,10));decipher.setAuthTag(bytes.subarray(22,38));
  const plaintext=Buffer.concat([decipher.update(bytes.subarray(38)),decipher.final()]);
  try{await writeFile(target,plaintext,{flag:'wx',mode:0o600});}finally{plaintext.fill(0);}
}
async function seed(app){
  const now=Date.now();let clock=now;
  app.auth.now=app.support.now=app.servicePrincipals.now=()=>clock;
  const ownerPassword=secret(),memberPassword=secret(),owner=await app.auth.setup({name:'Administrador sintético de recuperação',username:'backup.owner',email:'owner-backup@example.test',password:ownerPassword});
  const tenant=app.store.createTenant(owner.actor,{name:'Empresa sintética de recuperação',segment:'Teste'}),tenantId=tenant.id,conversationId='backup-conversation';
  app.store.mutate(owner.actor,tenantId,'Fixture integrada de recuperação',state=>{
    state.channels=[{id:'backup-channel',name:'Canal sintético',kind:'telegram',transport:'telegram-bot',state:'planned'}];
    state.departments=[{id:'backup-support',name:'Suporte',active:true,memberIds:[],distribution:'manual',version:1}];
    state.agents=[{id:'backup-hermes',name:'Hermes sintético',provider:'hermes',mode:'copilot',configured:true,version:1,description:'Teste',tools:[]}];
    state.conversations=[{id:conversationId,channelId:'backup-channel',departmentId:'backup-support',department:'Suporte',contact:'Pessoa sintética',status:'open',owner:'human',assignedUserId:owner.actor.userId,assignedUserName:owner.actor.name,version:1,tags:[],messages:[{id:'backup-customer',kind:'customer',text:'Conteúdo sintético que precisa sobreviver.',createdAt:new Date(now).toISOString()}],updatedAt:new Date(now).toISOString()}];
  });
  const invitationInput={requestId:randomUUID(),name:'Pessoa convidada sintética',email:'member-backup@example.test',role:'operator',tenantIds:[tenantId],permissions:['inbox.read','inbox.reply'],scopeRules:{[tenantId]:{channelIds:['backup-channel'],departmentIds:['backup-support']}}};
  const accepted=await app.auth.createInvitation(owner.actor,invitationInput),member=await app.auth.acceptInvitation(accepted.token,{name:'Pessoa convidada sintética',username:'backup.member',password:memberPassword});
  const revokedInvite=await app.auth.createInvitation(owner.actor,{...invitationInput,requestId:randomUUID(),email:'revoked-backup@example.test'});app.auth.revokeInvitation(owner.actor,revokedInvite.invitation.id);
  clock=now-2*3600000;const expiredInvite=await app.auth.createInvitation(owner.actor,{...invitationInput,requestId:randomUUID(),email:'expired-backup@example.test',expiresInHours:1});clock=now;
  const pendingInput={...invitationInput,requestId:randomUUID(),email:'pending-backup@example.test'},pendingInvite=await app.auth.createInvitation(owner.actor,pendingInput);
  const revokedSession=await app.auth.login({username:'backup.owner',password:ownerPassword});app.auth.logout(revokedSession.token);
  clock=now-9*3600000;const expiredSession=await app.auth.login({username:'backup.member',password:memberPassword});clock=now;
  const alias='reserved-google-backup@example.test';app.auth.linkGoogle(owner.actor,{sub:'google-backup-stable-subject',email:alias,email_verified:true,name:'Perfil Google sintético'});
  clock=now-3600000;const expiredReset=app.auth.passwordResetChallenge('member-backup@example.test');clock=now;
  const pendingReset=app.auth.passwordResetChallenge('owner-backup@example.test'),verification=app.auth.emailChallenge(member.actor.userId);
  await app.email.enqueueInvitation({invitationId:pendingInvite.invitation.id,userId:owner.actor.userId,email:'pending-backup@example.test',name:'Pessoa sintética',token:pendingInvite.token,expiresAt:pendingInvite.invitation.expiresAt});
  await app.email.enqueuePasswordReset(pendingReset);
  const external=await app.auth.register({fiscalDocument:syntheticFiscalDocument(),name:'Suporte sintético',email:'support-backup@example.test',company:'Workspace de suporte sintético',password:secret()},{provision:input=>app.store.provisionReseller(input)});
  const grantInput={requestId:randomUUID(),supportUserId:external.actor.userId,tenantIds:[tenantId],permissions:['inbox.read','inbox.reply'],scopeRules:{[tenantId]:{channelIds:['backup-channel'],departmentIds:['backup-support']}},reason:'Recuperação sintética autorizada',ticket:'BACKUP-QA',ttlMinutes:60};
  const activeGrant=app.support.create(owner.actor,grantInput),revokedGrant=app.support.create(owner.actor,{...grantInput,requestId:randomUUID()});app.support.revoke(owner.actor,revokedGrant.id,{version:revokedGrant.version,reason:'Delegação encerrada antes do backup'});
  clock=now-180000;const expiredGrant=app.support.create(owner.actor,{...grantInput,requestId:randomUUID(),ttlMinutes:1});clock=now;app.support.sweep();
  const principalInput={name:'Serviço sintético',agentId:'backup-hermes',capabilities:['conversation.read','reply.draft','handoff.request'],channelIds:['backup-channel'],departmentIds:['backup-support'],dailyRequests:10,dailyBudgetMicros:0,estimatedRequestMicros:0,maxConcurrent:1,ttlHours:1};
  const activeService=app.servicePrincipals.create(owner.actor,tenantId,principalInput),serviceActor=app.servicePrincipals.authenticate(`Bearer ${activeService.token}`);
  const draftBody={requestId:'backup-draft-request-001',conversationId,version:1,instruction:'Prepare uma proposta sintética.'},draft=await app.serviceApi.draft(serviceActor,draftBody);assert.equal(draft.receipt.state,'confirmed');
  const handoff=app.serviceApi.handoff(serviceActor,{requestId:'backup-handoff-request-001',conversationId,version:1,reason:'Revisão humana sintética.'});app.serviceApi.decide(owner.actor,tenantId,conversationId,handoff.request.id,{version:1,action:'acknowledge',reason:'Revisado na fixture'});
  const revokedService=app.servicePrincipals.create(owner.actor,tenantId,principalInput);app.servicePrincipals.revoke(owner.actor,tenantId,revokedService.principal.id,{revision:1});
  clock=now-2*3600000;const expiredService=app.servicePrincipals.create(owner.actor,tenantId,principalInput);clock=now;
  const contractBody={requestId:randomUUID(),scope:'workspace',tenantId,name:'Contrato sintético de recuperação',currency:'BRL',items:[{kind:'subscription',label:'Mensalidade configurada na fixture',unitCents:2000,units:1,metered:false},{kind:'email',label:'Consumo configurado na fixture',unitCents:2,units:0,metered:true}],quotas:{email:5},periodMonths:1,startsAt:'2026-10-01',endsAt:null,graceDays:2,state:'active',reason:'Preço apenas sintético'};
  const contract=app.billing.createContract(owner.actor,contractBody);app.billing.recordUsage(owner.actor,contract.id,{requestId:randomUUID(),version:1,periodStart:'2026-10-01',periodEnd:'2026-10-31',metric:'email',quantity:7,reason:'Consumo sintético conferido'});
  const invoice=app.billing.createInvoice(owner.actor,contract.id,{requestId:randomUUID(),version:1,periodStart:'2026-10-01',periodEnd:'2026-10-31',dueDate:'2026-11-05',reason:'Cobrança sintética'});app.billing.changeInvoice(owner.actor,invoice.id,{requestId:randomUUID(),version:1,action:'issue',usageReviewed:true,reason:'Emissão sintética'});
  const settlementBody={requestId:randomUUID(),version:2,action:'settle',amountCents:14,reference:'SYNTHETIC-BACKUP-RECEIPT',settledAt:'2026-10-03',reason:'Recebimento apenas sintético'};app.billing.changeInvoice(owner.actor,invoice.id,settlementBody);
  const settlement=app.billing.invoiceDetail(owner.actor,invoice.id).settlements[0],reversalBody={requestId:randomUUID(),version:3,action:'reverse',settlementId:settlement.id,reason:'Correção contábil sintética preservada'};app.billing.changeInvoice(owner.actor,invoice.id,reversalBody);
  app.billing.changeInvoice(owner.actor,invoice.id,{...settlementBody,requestId:randomUUID(),version:4,reference:'SYNTHETIC-CORRECTED-RECEIPT'});
  const commercialInput={requestId:randomUUID(),name:'Revenda sintética preservada',accountKind:'reseller',parentWorkspaceId:owner.actor.resellerId,initialTenantName:'Empresa inicial sintética'},commercial=app.accounts.create(owner.actor,commercialInput);
  const childAccount=app.accounts.create(owner.actor,{requestId:randomUUID(),name:'Cliente sintético preservado',accountKind:'business',parentWorkspaceId:commercial.account.id});
  app.accounts.update(owner.actor,childAccount.account.id,{version:1,name:'Cliente sintético revisado'});
  const platformContract=app.billing.createContract(owner.actor,{...contractBody,requestId:randomUUID(),scope:'platform',tenantId:undefined,targetKind:'reseller',targetWorkspaceId:commercial.account.id,name:'Plano sintético da revenda'});
  const room=app.teamChat.createRoom(owner.actor,tenantId,{name:'Sala privada sintética',memberIds:[member.actor.userId]});app.teamChat.send(owner.actor,tenantId,room.id,{version:room.version,text:'Conteúdo interno privado de recuperação.',requestId:'backup-team-request-001',conversationId});app.teamChat.markRead(member.actor,tenantId,room.id,{sequence:1});
  return {now,owner,member,external,tenantId,conversationId,alias,accepted,revokedInvite,expiredInvite,pendingInvite,pendingInput,revokedSession,expiredSession,expiredReset,pendingReset,verification,activeGrant,revokedGrant,expiredGrant,activeService,revokedService,expiredService,draft,draftBody,contract,invoice,settlementBody,reversalBody,commercialInput,commercial,childAccount,platformContract,room,secrets:[ownerPassword,memberPassword,owner.token,member.token,external.token,accepted.token,revokedInvite.token,expiredInvite.token,pendingInvite.token,revokedSession.token,expiredSession.token,expiredReset.token,pendingReset.token,verification,activeService.token,revokedService.token,expiredService.token]};
}

test('backup cifrado integrado restaura namespaces privados, hashes, autoridade e replay sem reativar revogados/expirados',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'elozi-final-backup-test-')),key=randomBytes(32),destination=join(directory,'backups'),apps=[];
  t.after(async()=>{for(const app of apps.reverse())await closeApp(app);assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('elozi-final-backup-test-'));await rm(directory,{recursive:true,force:true});key.fill(0);});
  let providerCalls=0;const app=application(':memory:',key,async()=>{providerCalls++;return {text:'Proposta sintética preservada no backup.'};});apps.push(app);const data=await seed(app),before=fingerprints(app.store.db);assert.equal(providerCalls,1);
  for(const name of protectedTables)assert.ok(before[name]?.count>0,`${name} precisa conter dados sintéticos reais do módulo`);
  assert.equal(app.store.db.prepare('SELECT token_hash FROM auth_sessions WHERE user_id=? AND token_hash=?').get(data.owner.actor.userId,sha(data.owner.token)).token_hash,sha(data.owner.token));
  assert.equal(app.store.db.prepare('SELECT token_hash FROM auth_invitations WHERE id=?').get(data.pendingInvite.invitation.id).token_hash,sha(data.pendingInvite.token));
  assert.equal(app.store.db.prepare('SELECT token_hash FROM auth_password_resets WHERE user_id=? AND consumed_at IS NULL').get(data.owner.actor.userId).token_hash,sha(data.pendingReset.token));
  const credentialRows=JSON.stringify([...app.store.db.prepare('SELECT * FROM auth_invitations').all(),...app.store.db.prepare('SELECT * FROM auth_sessions').all(),...app.store.db.prepare('SELECT * FROM auth_password_resets').all(),...app.store.db.prepare('SELECT * FROM service_principals').all()]);for(const value of data.secrets)assert.equal(credentialRows.includes(value),false);
  assert.deepEqual(app.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const backup=await createLocalBackup(app.store.db,{destination,key});assert.equal(backup.verification.integrity,'ok');assert.equal(backup.verification.foreignKeys,'ok');assert.equal(backup.verification.restoreVerified,true);assert.equal(backup.verification.media.count,0);
  const checked=await validateBackup(backup.file,{key});assert.equal(checked.restoreVerified,true);for(const name of protectedTables)assert.ok(checked.tables.includes(name));
  const encrypted=await readFile(backup.file),publicMetadata=JSON.stringify({metadata:JSON.parse(await readFile(backup.metadataFile,'utf8')),manifest:JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'))});
  for(const value of [...data.secrets,key.toString('hex'),data.alias,'Conteúdo interno privado de recuperação.']){assert.equal(encrypted.includes(Buffer.from(value)),false);assert.equal(publicMetadata.includes(value),false);}
  assert.equal(encrypted.includes(Buffer.from('SQLite format 3')),false);assert.equal((await readdir(destination)).some(name=>name.startsWith('.mepchat-backup-')||name.endsWith('.sqlite')),false);
  await assert.rejects(validateBackup(backup.file,{key:randomBytes(32)}));assert.deepEqual(fingerprints(app.store.db),before);
  const restoredFile=join(directory,'restored.sqlite');await restoreFixture(backup.file,key,restoredFile);const restored=application(restoredFile,key,denied);apps.push(restored);
  restored.auth.now=restored.support.now=restored.servicePrincipals.now=()=>data.now;
  assert.deepEqual(fingerprints(restored.store.db),before);assert.deepEqual(restored.store.db.prepare('PRAGMA integrity_check').get(),Object.assign(Object.create(null),{integrity_check:'ok'}));assert.deepEqual(restored.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(restored.auth.authenticate(data.owner.token).userId,data.owner.actor.userId);assert.equal(restored.auth.authenticate(data.member.token).userId,data.member.actor.userId);for(const session of [data.revokedSession,data.expiredSession])assert.throws(()=>restored.auth.authenticate(session.token),status(401));
  for(const invitation of [data.accepted,data.revokedInvite,data.expiredInvite])assert.throws(()=>restored.auth.previewInvitation(invitation.token),status(400));assert.equal(restored.auth.previewInvitation(data.pendingInvite.token).id,data.pendingInvite.invitation.id);
  const replayInvite=await restored.auth.createInvitation(data.owner.actor,data.pendingInput);assert.equal(replayInvite.token,data.pendingInvite.token);assert.equal(replayInvite.invitation.id,data.pendingInvite.invitation.id);assert.throws(()=>restored.auth.resetForToken(data.expiredReset.token),status(400));assert.equal(restored.auth.resetForToken(data.pendingReset.token).row.id,data.owner.actor.userId);
  assert.equal(restored.auth.me(data.owner.actor).email,'owner-backup@example.test');assert.equal(restored.auth.me(data.owner.actor).googleLinked,true);assert.equal(restored.store.db.prepare('SELECT email FROM auth_google_identities WHERE user_id=?').get(data.owner.actor.userId).email,data.alias);
  await assert.rejects(restored.auth.register({fiscalDocument:syntheticFiscalDocument(),name:'Duplicata sintética',email:data.alias,company:'Outra empresa sintética',password:secret()},{provision:input=>restored.store.provisionReseller(input)}),status(409));
  for(const grant of [data.revokedGrant,data.expiredGrant])assert.throws(()=>restored.auth.resolveActor({userId:data.external.actor.userId,resellerId:data.owner.actor.resellerId,supportGrantId:grant.id}),status(403));const delegated=restored.auth.resolveActor({userId:data.external.actor.userId,resellerId:data.owner.actor.resellerId,supportGrantId:data.activeGrant.id});assert.equal(delegated.role,'operator');assert.equal(delegated.supportGrantId,data.activeGrant.id);
  for(const service of [data.revokedService,data.expiredService])assert.throws(()=>restored.servicePrincipals.authenticate(`Bearer ${service.token}`),status(401));const serviceActor=restored.servicePrincipals.authenticate(`Bearer ${data.activeService.token}`);assert.equal(restored.servicePrincipals.getReceipt(serviceActor,data.draft.receipt.id).state,'confirmed');
  const replay=await restored.serviceApi.draft(serviceActor,data.draftBody);assert.equal(replay.receipt.id,data.draft.receipt.id);assert.equal(replay.run.draft,data.draft.run.draft);assert.equal(providerCalls,1);assert.equal(restored.serviceApi.handoffs(data.owner.actor,data.tenantId,data.conversationId).requests[0].state,'acknowledged');
  const originalPrincipal=app.store.db.prepare('SELECT token_hash FROM service_principals WHERE id=?').get(data.activeService.principal.id);assert.equal(originalPrincipal.token_hash,sha(data.activeService.token));assert.equal(restored.store.db.prepare('SELECT token_hash FROM service_principals WHERE id=?').get(data.activeService.principal.id).token_hash,originalPrincipal.token_hash);
  assert.equal(restored.billing.reconcile(data.owner.actor,data.invoice.id).balanced,true);assert.equal(restored.billing.reconcile(data.owner.actor,data.invoice.id).providerConfirmed,false);const settled=restored.billing.changeInvoice(data.owner.actor,data.invoice.id,data.settlementBody);assert.equal(settled.paidCents,14);assert.equal(settled.outstandingCents,2000);
  const reversed=restored.billing.changeInvoice(data.owner.actor,data.invoice.id,data.reversalBody);assert.equal(reversed.paidCents,0);assert.equal(restored.billing.reconcile(data.owner.actor,data.invoice.id).reversedCents,14);assert.equal(restored.billing.reconcile(data.owner.actor,data.invoice.id).ledgerPaidCents,14);
  assert.equal(restored.accounts.create(data.owner.actor,data.commercialInput).account.id,data.commercial.account.id);const child=restored.accounts.overview(data.owner.actor,data.childAccount.account.id);assert.equal(child.accountKind,'business');assert.equal(child.parentWorkspaceId,data.commercial.account.id);assert.equal(child.version,2);assert.equal(restored.billing.detail(data.owner.actor,data.platformContract.id).contract.targetKind,'reseller');
  const history=restored.teamChat.messages(data.member.actor,data.tenantId,data.room.id);assert.equal(history.messages.length,1);assert.equal(history.messages[0].text,'Conteúdo interno privado de recuperação.');assert.equal(restored.teamChat.listRooms(data.member.actor,data.tenantId).rooms[0].readSequence,1);assert.throws(()=>restored.teamChat.getRoom(data.external.actor,data.tenantId,data.room.id),status(404));
  assert.equal(restored.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,0);assert.equal(restored.email.status().configured,false);assert.equal(restored.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE state='pending'").get().n,2);
  assert.deepEqual(fingerprints(app.store.db),before);assert.deepEqual(fingerprints(restored.store.db),before);t.diagnostic(`${Object.keys(before).length} tabelas com fingerprints iguais; ${protectedTables.length} namespaces sensíveis populados; FKs válidas, zero envio externo.`);
});
