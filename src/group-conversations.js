import { randomUUID } from 'node:crypto';
import { selectedGroup } from './group-workspace.js';

/** Called only inside the authorized selection write; never fetches historical messages. */
export function prepareSelectedGroupConversations(tenant, channel) {
  const choices=channel.transport==='baileys'?(channel.allowedGroups||[]).map(id=>({id,title:channel.groupNames?.[id]||'Grupo WhatsApp'})):
    channel.transport==='telegram-bot'?(channel.telegramGroups?.known||[]).map(group=>({id:group.id,title:group.name||'Grupo Telegram',aliases:group.aliases||[]})):[];
  const department=(tenant.departments||[]).find(item=>item.active!==false&&item.id===tenant.defaultDepartmentId);
  let created=0;
  for(const choice of choices){
    const peer=channel.transport==='baileys'?{remoteJid:choice.id}:{remoteChatId:choice.id,chatAliases:choice.aliases};
    if(!selectedGroup(channel,{channelId:channel.id,...peer}))continue;
    const aliases=[choice.id,...(choice.aliases||[])];
    if((tenant.conversations||[]).some(item=>item.channelId===channel.id&&item.conversationKind==='group'&&(channel.transport==='baileys'?aliases.includes(item.remoteJid):[item.remoteChatId,...(item.chatAliases||[])].some(id=>aliases.includes(id)))))continue;
    const name=String(choice.title).replace(/\p{Cc}/gu,'').slice(0,80)||'Grupo';
    tenant.conversations.unshift({id:randomUUID(),contact:name,initials:name.slice(0,2).toUpperCase(),channelId:channel.id,...peer,conversationKind:'group',department:department?.name||'Suporte',departmentId:department?.id||null,owner:'queue',assignedUserId:null,status:'open',version:1,unread:0,agentId:null,tags:[channel.transport==='baileys'?'Grupo WhatsApp':'Grupo Telegram'],messages:[]});
    created++;
  }
  return created;
}
