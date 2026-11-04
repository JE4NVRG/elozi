import { registerTranslations } from './i18n.js';
const copy = `
Agente via MCP|Agent via MCP
Aberta|Open
Pendente|Pending
Encerrada|Closed
Na fila|Queued
Preparando resposta|Preparing response
Aguardando sua aprovação|Awaiting your approval
Executando ferramenta|Running tool
Execução não confirmada|Execution unconfirmed
Ferramenta recusada|Tool rejected
Rascunho pronto|Draft ready
Cancelada|Cancelled
Contexto atualizado|Context updated
Falha|Failed
Aguardando|Waiting
Copiloto|Copilot
Com aprovação|With approval
Autônomo|Autonomous
Canal|Channel
Desconectado|Disconnected
Iniciando|Starting
Aguardando QR|Waiting for QR
Conectando|Connecting
Reconectando|Reconnecting
Conectado|Connected
Sessão encerrada|Session ended
Número diferente|Different number
Falha de conexão|Connection failed
Configurado · validar recebimento|Configured · validate reception
Administrador da plataforma|Platform administrator
Administrador da empresa|Company administrator
Administrador da revenda|Reseller administrator
Atendente|Operator
 · Com você| · Assigned to you
Com a equipe|Assigned to team
Copiloto atribuído|Copilot assigned
Imagem|Image
Áudio|Audio
Vídeo|Video
Arquivo|File
Anexo|Attachment
Senha atual incorreta.|Incorrect current password.
Entre para continuar.|Sign in to continue.
O arquivo excede o limite de envio. Reduza o tamanho ou divida a importação em lotes.|The file exceeds the upload limit. Reduce its size or split the import into batches.
O serviço está temporariamente indisponível. Tente novamente em alguns instantes.|The service is temporarily unavailable. Try again shortly.
Não foi possível concluir a solicitação. Tente novamente.|Unable to complete the request. Try again.
O servidor retornou uma resposta inválida. Tente novamente.|The server returned an invalid response. Try again.
Assuma este atendimento antes de responder ao grupo.|Take ownership of this conversation before replying to the group.
O responsável pelo atendimento pode agendar mensagens para o grupo.|The assigned operator can schedule group messages.
Suporte à conta|Account support
O administrador da conta pode conceder acesso em Suporte com prazo, escolhendo empresas, canais e validade. Depois disso, a conta aparece no seu seletor de acesso temporário.|The account administrator can grant access in Temporary support, choosing companies, channels and expiry. The account then appears in your temporary access selector.
Entendi|Got it
Como administrador principal, você também pode usar o acesso administrativo registrado no painel de contas.|As the main administrator, you can also use the recorded administrative access in the accounts panel.
Acessar como administrador|Access as administrator
Seu acesso administrativo a esta conta será registrado. Você poderá gerenciar a operação, equipe, canais e agentes deste painel.|Your administrative access to this account will be recorded. You can manage its operation, team, channels and agents.
Esta ação é exclusiva do administrador principal e não concede acesso à revenda responsável.|This action is exclusive to the main administrator and does not grant access to the parent reseller.
Cancelar|Cancel
Registrar acesso e abrir painel|Record access and open panel
O acesso não foi confirmado. Atualize os dados da conta.|Access was not confirmed. Refresh the account details.
Limite de notas em rascunho atingido. Salve ou limpe uma nota antes de trocar.|Note draft limit reached. Save or clear a note before switching.
Limite de rascunhos atingido. Envie ou limpe uma mensagem.|Draft limit reached. Send or clear a message.
Limite de rascunhos atingido. Envie ou limpe uma mensagem antes de trocar.|Draft limit reached. Send or clear a message before switching.
Entre novamente para acessar o arquivo.|Sign in again to access the file.
Não foi possível carregar o arquivo.|Unable to load the file.
Este arquivo ultrapassa o limite de download desta versão.|This file exceeds the download limit for this version.
Confira o envio pendente ou descarte o rascunho antes de trocar ou editar.|Check the pending send or discard the draft before switching or editing.
O envio anterior precisa de confirmação. Confira antes de alterar a resposta.|The previous send needs confirmation. Check it before changing the reply.
Conferir envio|Check send
Descartar rascunho|Discard draft
Confira o envio anterior antes de alterar texto, arquivo ou citação.|Check the previous send before changing text, file or quoted message.
O arquivo mudou. Abra novamente a galeria.|The file changed. Open the gallery again.
Finalize a gravação ou o envio antes de trocar.|Finish recording or sending before switching.
O atendimento mudou. Abra novamente o encaminhamento.|The conversation changed. Open forwarding again.
Preparando resposta…|Preparing response…
Rascunhos e fontes para revisão|Drafts and sources for review
Seu acesso a este atendimento mudou. A caixa será atualizada.|Your access to this conversation changed. The inbox will refresh.
O servidor retornou dados inválidos do workspace. Tente novamente.|The server returned invalid workspace data. Try again.
Escolha uma foto PNG, JPEG ou WebP.|Choose a PNG, JPEG or WebP photo.
Escolha uma foto com até 5 MB.|Choose a photo up to 5 MB.
O conteúdo do arquivo não corresponde ao formato da foto.|The file content does not match the photo format.
Não foi possível preparar esta foto. Escolha outra imagem PNG, JPEG ou WebP.|Unable to prepare this photo. Choose another PNG, JPEG or WebP image.
Abrindo o workspace escolhido…|Opening the selected workspace…
Workspace alterado.|Workspace changed.
Não foi possível abrir o workspace.|Unable to open the workspace.
Tentar novamente|Try again
Painel principal|Main dashboard
Contas comerciais|Business accounts
Usuários globais|Global users
Visão geral|Overview
Atendimento|Inbox
Grupos|Groups
Chat da equipe|Team chat
Contatos|Contacts
Indicadores|Metrics
Canais|Channels
Agentes|Agents
Conhecimento|Knowledge
Fluxos|Flows
Automações e SLA|Automations and SLA
Equipe|Team
Empresas e filiais|Companies and branches
Integrações|Integrations
Marca própria|Branding
Suporte com prazo|Temporary support
Agentes conectados|Connected agents
Financeiro|Billing
Cobrança da plataforma|Platform billing
Minha conta|My account
Guia e APIs|Guide and APIs
Mapa do produto|Product map
PLATAFORMA|PLATFORM
OPERAÇÃO|OPERATIONS
AUTOMAÇÃO|AUTOMATION
GESTÃO DA CONTA|ACCOUNT MANAGEMENT
AJUDA|HELP
O limite de rascunhos foi atingido. Envie ou limpe uma mensagem antes de trocar.|Draft limit reached. Send or clear a message before switching.
Pular para o conteúdo|Skip to content
Fechar menu|Close menu
CENTRAL DE ATENDIMENTO|SUPPORT CENTER
Conta: {8}|Account: {8}
Navegação principal|Main navigation
Abrir mapa do produto|Open product map
Abrir Minha conta|Open My account
Sair da conta|Sign out
Recolher menu lateral|Collapse sidebar
Abrir menu|Open menu
Disponibilidade|Availability
Disponibilidade para atendimento|Availability for support
Atualizar workspace|Refresh workspace
Minha conta: {29}|My account: {29}
Administração principal|Main administration
Empresa e filiais|Company and branches
Revenda white label|White label reseller
Ambiente de teste|Test environment
Workspace atual|Current workspace
 · suporte temporário| · temporary support
Gestão das contas|Account management
Configure sua primeira unidade|Set up your first unit
Caixa das empresas autorizadas|Inbox for authorized companies
Empresa|Company
Empresa atual|Current company
Ambiente de teste · dados sintéticos e conexões simuladas.|Test environment · synthetic data and simulated connections.
Suporte temporário · {1} · até {2}|Temporary support · {1} · until {2}
Sair do suporte|Exit support
Não foi possível abrir os grupos. Atualize a página e tente novamente.|Unable to open groups. Refresh the page and try again.
Conta Google vinculada.|Google account linked.
O Google não carregou. Tente atualizar esta página.|Google did not load. Try refreshing this page.
Configurar canal {1}|Configure channel {1}
Ver conexão|View connection
Conectar número|Connect number
Conectar bot|Connect bot
Ver caminho {1}|View setup {1}
Demonstração|Demo
Integração pendente|Integration pending
Conversa atual|Current conversation
Todas as empresas autorizadas, com cada origem preservada.|All authorized companies, with each source preserved.
&nbsp;não lidos|&nbsp;unread
Novo atendimento|New conversation
Novo|New
Escolha um atendimento.|Choose a conversation.
A origem e o responsável continuam visíveis ao acompanhar uma conversa.|The source and assigned operator remain visible throughout a conversation.
WhatsApp QR e Telegram conectados ao atendimento.|WhatsApp QR and Telegram connected to your inbox.
Pareie um número de teste pelo QR ou conecte seu bot Telegram. Selecione os grupos de WhatsApp que a equipe deve atender. Os canais de demonstração continuam sem envio externo.|Pair a test number via QR or connect your Telegram bot. Select the WhatsApp groups your team will handle. Demo channels do not send external messages.
Conexões cadastradas|Registered connections
Conexão|Connection
Tipo|Type
Integração|Integration
Configuração|Configuration
Um núcleo, adaptadores independentes.|One core, independent adapters.
CONEXÕES|CONNECTIONS
Cada canal, no seu lugar.|Every channel in its place.
A mesma operação pode reunir vários números e plataformas.|One operation can bring together multiple numbers and platforms.
Adicionar canal|Add channel
Workspace isolado|Isolated workspace
Adicione o primeiro canal.|Add your first channel.
Número próprio, mensagens diretas e grupos escolhidos por conexão.|Your own number, direct messages and groups selected per connection.
Bot próprio para conversas privadas, grupos e tópicos na mesma inbox.|Your own bot for private chats, groups and topics in the same inbox.
API oficial adiada por decisão atual do projeto.|Official API postponed by the current project decision.
Envio pelo MepMail. Recebimento por relay assinado, com conexão à caixa de e-mail necessária.|Sending via MepMail. Reception via signed relay requires a mailbox connection.
Widget próprio para os sites e produtos da revenda.|Your own widget for the reseller's websites and products.
Eventos normalizados na mesma caixa de atendimento.|Normalized events in the same inbox.
Adaptador disponível|Adapter available
Adiado|Postponed
Configurar e validar|Configure and validate
FERRAMENTAS PARA O HERMES|TOOLS FOR HERMES
Mais contexto. A mesma revisão humana.|More context. The same human review.
SEU AGENTE EXISTENTE|YOUR EXISTING AGENT
Claude, Codex, OpenClaw ou Hermes podem usar seu cliente MCP para consultar atendimentos e entregar rascunhos. Cadastre um Agente via MCP e crie uma identidade em Agentes conectados, com chave privada, escopo e cotas. Conecte o cliente MCP do seu agente com o endpoint desta implantação e valide a primeira chamada.|Claude, Codex, OpenClaw or Hermes can use their MCP client to query conversations and deliver drafts. Register an Agent via MCP and create an identity in Connected agents with a private key, scope and quotas. Connect your agent's MCP client to this deployment's endpoint and validate the first call.
Resposta com revisão humana.|Replies with human review.
O cadastro não inicia nem conecta automaticamente o seu agente. As capacidades e os canais são definidos por identidade; a equipe revisa o rascunho e envia ao cliente.|Registration does not automatically start or connect your agent. Capabilities and channels are set per identity; the team reviews the draft and sends it to the customer.
EQUIPE HÍBRIDA|HYBRID TEAM
Um copiloto para cada operação.|A copilot for every operation.
Adicionar agente|Add agent
Adicione o primeiro copiloto desta empresa.|Add this company's first copilot.
Gerenciar ferramentas|Manage tools
Ver guia e APIs|View guide and APIs
Identidade a personalizar|Identity to customize
Empresa cliente|Customer company
Sua revenda|Your reseller
Marca de {3}|Brand for {3}
Logotipo da marca|Brand logo
Uma imagem sua no painel e na identidade da empresa.|Your image in the dashboard and company identity.
Escolher imagem|Choose image
Remover|Remove
Nome do produto|Product name
Sigla|Initials
Cor principal|Primary color
Domínio desejado|Preferred domain
Preferência de marca. Abra Domínio e HTTPS para vincular o endereço à conta.|Brand preference. Open Domain and HTTPS to link the address to this account.
PRÉVIA DA MARCA|BRAND PREVIEW
Atendimento da sua empresa|Your company's support
Como podemos|How can we
Seu cliente reconhece a marca em cada conversa.|Your customer recognizes your brand in every conversation.
Olá! Conte com a nossa equipe.|Hello! Our team is here to help.
Equipe {20}|Team {20}
Escreva sua mensagem…|Write your message…
{22} Prévia da identidade. O widget é instalado em Canais → Webchat.|{22} Identity preview. Install the widget in Channels → Webchat.
Revenda e cliente têm identidades próprias.|Reseller and customer have their own identities.
Alterar a revenda atualiza a identidade deste painel. Cada empresa mantém sua própria marca e contexto.|Changing the reseller updates this panel's identity. Each company keeps its own brand and context.
IDENTIDADE WHITE LABEL|WHITE LABEL IDENTITY
A experiência leva a sua marca.|Your brand throughout the experience.
Personalize a empresa e confira a identidade antes de publicar.|Customize the company and check its identity before publishing.
Identidade do painel da revenda.|Identity of the reseller panel.
Configuração salva nesta empresa.|Configuration saved for this company.
Domínio e HTTPS|Domain and HTTPS
MEU PERFIL|MY PROFILE
Escolher foto|Choose photo
Remover foto|Remove photo
PNG, JPEG ou WebP · até 5 MB.|PNG, JPEG or WebP · up to 5 MB.
Nome|Name
Telefone|Phone
Como você participa da operação?|How do you contribute to the operation?
Até 180 caracteres.|Up to 180 characters.
IDENTIDADE DE ACESSO|ACCESS IDENTITY
Usuário|User
Não informado|Not provided
Confirmação|Verification
LOGIN GOOGLE|GOOGLE SIGN-IN
Mais um jeito de entrar.|Another way to sign in.
SEU ACESSO|YOUR ACCESS
Sua conta, sempre com você.|Your account, always with you.
Edite seu perfil e confira os métodos disponíveis para entrar.|Edit your profile and check available sign-in methods.
Preparando a foto…|Preparing photo…
Foto alterada. Salve o perfil para confirmar.|Photo changed. Save your profile to confirm.
Sua foto aparece na equipe e nas conversas internas.|Your photo appears in the team and internal conversations.
Adicione sua foto para a equipe reconhecer você nas conversas.|Add your photo so the team recognizes you in conversations.
Confirmação pendente|Verification pending
Sem e-mail|No email
Enviar confirmação|Send verification
A confirmação é enviada pelo MepMail.|Verification is sent via MepMail.
O administrador da plataforma ainda precisa ativar o provedor de e-mail.|The platform administrator still needs to enable the email provider.
Sua conta Google já está vinculada a este acesso.|Your Google account is already linked to this access.
O login Google estará disponível após a configuração da plataforma.|Google sign-in will be available after platform setup.
Google vinculado|Google linked
A configuração de integrações pertence ao proprietário da plataforma.|Integration settings belong to the platform owner.
Entrar e criar conta.|Sign in and create an account.
Cadastre um Client ID do tipo aplicação web no Google Cloud.|Register a web application Client ID in Google Cloud.
Client ID web|Web Client ID
Origens autorizadas:|Authorized origins:
O modelo do seu copiloto.|Your copilot's model.
DeepSeek V4.1 Flash pela API CommandCode. A chave fica cifrada no servidor e só o administrador da plataforma pode alterá-la.|DeepSeek V4.1 Flash via the CommandCode API. The key is encrypted on the server and only the platform administrator can change it.
Chave da API CommandCode|CommandCode API key
Use a chave do Studio CommandCode. Não envie tokens no chat.|Use your Studio CommandCode key. Do not send tokens in chat.
Desativar acesso ao modelo|Disable model access
Modelo: deepseek/deepseek-v4.1-flash · rascunhos com revisão humana|Model: deepseek/deepseek-v4.1-flash · drafts with human review
Cadastro e notificações.|Registration and notifications.
Remetente verificado|Verified sender
Chave de envio|Sending key
Use uma chave exclusiva, restrita ao domínio do remetente.|Use a dedicated key restricted to the sender's domain.
Desativar envio de e-mails|Disable email sending
{8} pendentes · {9} aceitos pelo provedor · {10} sem confirmação|{8} pending · {9} accepted by provider · {10} unconfirmed
{11} Salvar integrações|{11} Save integrations
RECUPERAÇÃO|RECOVERY
Uma cópia protegida do piloto.|A protected copy of the pilot.
Gere um backup cifrado dos dados locais. A cópia é verificada antes de confirmar a criação.|Generate an encrypted backup of local data. The copy is verified before creation is confirmed.
CONEXÕES DA PLATAFORMA|PLATFORM CONNECTIONS
Login e e-mails, com a nossa identidade.|Sign-in and emails with our identity.
Configure os provedores usados nos cadastros e notificações.|Configure providers for registration and notifications.
Configurado|Configured
Aguardando Client ID|Waiting for Client ID
Deixe vazio para manter a chave|Leave blank to keep the key
Cadastre a chave válida da API|Enter a valid API key
Chave cadastrada|Key registered
Aguardando chave|Waiting for key
Chave exclusiva de envio MepMail|Dedicated MepMail sending key
MepMail configurado|MepMail configured
Aguardando configuração|Waiting for configuration
Criar backup|Create backup
ENTRADA|INPUT
Canais e números|Channels and numbers
Outros canais em evolução|More channels in development
NÚCLEO ELOZI|ELOZI CORE
Conversa + contexto|Conversation + context
Empresa · permissões · histórico|Company · permissions · history
Fila · estado · eventos · auditoria|Queue · state · events · audit
ATENDIMENTO|SUPPORT
Humano + agentes|People + agents
MCP · aprovação · transferência|MCP · approval · transfer
O que funciona nesta versão|What works in this version
Próximos cortes verificáveis|Next verifiable milestones
Persistência PostgreSQL|PostgreSQL persistence
Banco exclusivo sincronizado. Evoluir a operação para PostgreSQL como fonte principal e provar restauração.|Dedicated database synchronized. Move operations to PostgreSQL as the primary source and verify restoration.
Novos adaptadores de agentes|New agent adapters
Hermes e ferramentas MCP configurados. Evoluir outros provedores e autonomia com permissões explícitas.|Hermes and MCP tools configured. Extend other providers and autonomy with explicit permissions.
Pagamentos e domínios da revenda|Reseller payments and domains
Contratos, cotas, faturas e conciliação manual disponíveis. Integrar pagamento e provisionamento de domínios.|Contracts, quotas, invoices and manual reconciliation available. Integrate payments and domain provisioning.
Novos canais e migração piloto|New channels and pilot migration
Canário isolado antes de migrar a operação.|An isolated canary before migrating operations.
Atividade deste workspace|Workspace activity
Alterações registradas na empresa selecionada.|Changes recorded for the selected company.
DIREÇÃO DO PRODUTO|PRODUCT DIRECTION
Independência no núcleo. Liberdade nas conexões.|An independent core. Freedom to connect.
Canais, contas e fluxos em uma operação própria. As integrações evoluem junto com o produto.|Channels, accounts and flows in your own operation. Integrations evolve with the product.
Publicada|Published
Entrar com conta individual e alternar empresas permitidas|Sign in with an individual account and switch between authorized companies
Reunir vários canais na caixa de entrada|Bring multiple channels together in the inbox
Enviar e receber textos e anexos no WhatsApp e Telegram|Send and receive text and attachments on WhatsApp and Telegram
Configurar copilotos com revisão e envio humanos|Configure copilots with human review and sending
Gerenciar equipe, contatos e responsáveis por atendimento|Manage your team, contacts and assigned operators
Personalizar marca, automatizar rotas e acompanhar SLA|Customize branding, automate routing and track SLA
Implementação pendente|Implementation pending
{2} · {3} às {4}|{2} · {3} at {4}
As ações no workspace aparecerão aqui.|Workspace actions will appear here.
{1} · aprovação humana|{1} · human approval
Crie uma identidade em Agentes conectados e cadastre o endpoint e a chave privada no cliente MCP do seu agente.|Create an identity in Connected agents and configure the endpoint and private key in your agent's MCP client.
Cadastro MCP|MCP registration
Configuração salva|Configuration saved
Configuração pendente|Configuration pending
Conector em evolução|Connector in development
Conectar em Agentes conectados|Connect in Connected agents
Configurar copiloto|Configure copilot
Ver configuração|View configuration
Conhecer integração|Explore integration
Modo deste piloto|Pilot mode
Copiloto · envio humano|Copilot · human sending
Modelo|Model
Ferramentas autorizadas {1}|Authorized tools {1}
Fontes de conhecimento|Knowledge sources
Verificar serviço {1}|Check service {1}
Verificado em {0}|Checked on {0}
Entrada|Input
Condição|Condition
Etiqueta|Tag
Departamento|Department
Transferência|Transfer
Concluir|Complete
 Versão | Version 
Alterações da conversa invalidam respostas preparadas no contexto anterior.|Conversation changes invalidate responses prepared with the previous context.
Cadastro vinculado.|Contact linked.
União desfeita. Cadastros e vínculos restaurados.|Merge undone. Records and links restored.
Contatos unidos. O cadastro de origem foi preservado.|Contacts merged. The source record was preserved.
Seu acesso aos contatos mudou. Atualize o workspace.|Your contact access changed. Refresh the workspace.
SUPORTE COM PRAZO|TEMPORARY SUPPORT
Acesso temporário para uma pessoa da equipe, com empresas, ações e validade definidos.|Temporary access for a team member with defined companies, actions and expiry.
AGENTES CONECTADOS|CONNECTED AGENTS
Uma identidade para cada integração.|An identity for every integration.
Escolha o adaptador, as ações e os limites de cada serviço.|Choose the adapter, actions and limits for each service.
Suporte|Support
Mensagem|Message
Responsável|Assigned operator
contém|contains
é igual a|equals
Adicionar|Add
Revise o departamento|Review the department
Escolha o departamento|Choose a department
Atendimento humano|Human support
Fila da equipe|Team queue
Receber contexto da conversa|Receive conversation context
Aplicar o resultado da rota|Apply routing result
Não|No
Selecione um passo para editar.|Select a step to edit.
Comparar|Compare
Texto da mensagem|Message text
Tipo de canal|Channel type
Regra|Rule
Contém|Contains
É igual a|Equals
Existe|Exists
Valor|Value
Operação|Operation
Departamento{0}|Department{0}
Destino|Destination
Atendente humano|Human operator
Há destinos indisponíveis neste fluxo. Escolha novamente os departamentos antes de salvar e publicar. A publicação anterior foi preservada.|Some destinations in this flow are unavailable. Select departments again before saving and publishing. The previous publication was preserved.
Este passo delimita a rota do atendimento.|This step defines the support route.
Seus fluxos|Your flows
ROTAS DO ATENDIMENTO|SUPPORT ROUTING
Desenhe o caminho da conversa.|Design the conversation's path.
Condições, etiquetas e transferências em fluxos versionados.|Conditions, tags and transfers in versioned flows.
Novo fluxo|New flow
{4} · edição v{5}|{4} · editing v{5}
Publicada v{0}|Published v{0}
Rascunho|Draft
Comece com um fluxo de triagem para sua equipe.|Start with a triage flow for your team.
Editar estrutura avançada|Edit advanced structure
Veja o caminho e o resultado antes de aplicar em uma conversa.|Check the route and result before applying it to a conversation.
Mensagem de teste|Test message
Ex.: Preciso de suporte para meu pedido|E.g. I need help with my order
Alterações locais|Local changes
Rascunho salvo|Draft saved
Salvar|Save
Publicar|Publish
Adicionar antes da conclusão|Add before completion
Tipo de novo passo|New step type
Adicionar passo|Add step
Etiquetas|Tags
Resultado aplicado|Result applied
Resultado da simulação|Simulation result
Mantido|Unchanged
Fila|Queue
Agente|Agent
Nenhuma|None
A próxima conversa pode seguir uma rota.|The next conversation can follow a route.
Comece pela triagem: identifique o assunto, marque a conversa e encaminhe para a equipe.|Start with triage: identify the subject, tag the conversation and route it to the team.
Resumo do atendimento|Conversation summary
Sem departamento|No department
Grupo · tópico |Group · topic 
Grupo|Group
Colaborando|Collaborating
Observando|Observing
Colaborando neste atendimento|Collaborating in this conversation
Responder por esta conexão|Reply using this connection
Buscar nesta conversa|Search this conversation
Arquivos da conversa|Conversation files
Participantes do atendimento|Conversation participants
Participantes|Participants
Marcar como |Mark as 
não lida|unread
Reabrir atendimento|Reopen conversation
Transferir atendimento|Transfer conversation
Devolver à fila|Return to queue
Retomar atendimento|Resume conversation
Marcar como pendente|Mark as pending
Encerrar atendimento|Close conversation
Respostas para este grupo estão bloqueadas. Confira a seleção, a presença do bot e possíveis conflitos em Canais → Grupos. O histórico e as notas internas continuam disponíveis.|Replies to this group are blocked. Check its selection, bot membership and possible conflicts in Channels → Groups. History and internal notes remain available.
O Telegram restringiu respostas de texto neste grupo. Você pode anexar os tipos de arquivo permitidos; as notas internas continuam disponíveis.|Telegram restricted text replies in this group. You can attach permitted file types; internal notes remain available.
Janela de resposta encerrada. Aguarde uma nova mensagem do contato. As notas internas continuam disponíveis.|The reply window has closed. Wait for a new message from the contact. Internal notes remain available.
· {1} coordena o atendimento. Você pode responder, enviar arquivos e registrar notas internas.|· {1} coordinates the conversation. You can reply, send files and record internal notes.
O responsável|The assigned operator
Atendimento encerrado. Reabra para voltar à fila.|Conversation closed. Reopen to return to the queue.
Observando · atendimento com |Observing · assigned to 
Assuma o atendimento para responder.|Take ownership to reply.
Reabrir|Reopen
Assumir de |Take over from 
Assumir|Take ownership
O copiloto prepara. Você revisa e envia.|The copilot prepares. You review and send.
O responsável coordena o copiloto, os agendamentos e os encaminhamentos.|The assigned operator coordinates the copilot, schedules and forwarding.
O acesso mudou. Confira no destino o envio anterior sem confirmação.|Access changed. Check the previous unconfirmed send at its destination.
Voltar à caixa de entrada|Back to inbox
Conversas|Conversations
Expandir chat|Expand chat
Ver mensagens novas {21}|View new messages {21}
Tipo de mensagem|Message type
Resposta ao cliente|Customer reply
Nota interna|Internal note
Respostas rápidas|Quick replies
Respostas|Replies
Inserir emoji|Insert emoji
Mensagens agendadas|Scheduled messages
Preparar resposta com copiloto|Prepare reply with copilot
Enviar {48}|Send {48}
{50} Somente sua equipe. Não é enviada ao cliente nem ao copiloto.|{50} Team only. Not sent to the customer or copilot.
Nota interna do atendimento|Internal conversation note
Registre o contexto para sua equipe…|Record context for your team…
Visível no histórico deste atendimento.|Visible in this conversation's history.
Salvar nota {54}|Save note {54}
Mostrar|Show
Recolher|Collapse
Memória do agente|Agent memory
Fatos revisados por cliente e operação|Reviewed facts for the customer and operation
Legenda do arquivo (opcional)|File caption (optional)
Mensagem ao cliente|Message to customer
Adicione uma legenda ou envie o arquivo…|Add a caption or send the file…
Anexe um arquivo permitido neste grupo…|Attach a file permitted in this group…
Escreva uma resposta…|Write a reply…
Resposta para o grupo|Group reply
Resposta pelo |Reply via 
Conversa de demonstração|Demo conversation
Histórico|History
Enviando|Sending
Enviado|Sent
Entregue|Delivered
Lido|Read
Falhou|Failed
Não confirmado|Unconfirmed
Nota interna · |Internal note · 
· só equipe|· team only
Participante|Participant
O servidor não confirmou as execuções deste atendimento. Atualize a consulta.|The server did not confirm this conversation's executions. Refresh the query.
Recolher contexto do atendimento|Collapse conversation context
CLIENTE E ATENDIMENTO|CUSTOMER AND CONVERSATION
{6} Responsável|{6} Assigned operator
{9} Organização|{9} Organization
Cliente, Suporte|Customer, Support
Separe por vírgulas.|Separate with commas.
Salvar contexto|Save context
Escolher agente|Choose agent
Aplicar uma rota publicada atualiza etiquetas, departamento e responsável.|Applying a published route updates tags, department and assigned operator.
Escolher fluxo|Choose flow
{24} Versão {25}|{24} Version {25}
Contato do |Contact from 
Contato fictício da prévia|Sample preview contact
Escolha quem prepara a resposta|Choose who prepares the reply
Fechar janela|Close window
O atendimento mudou. Abra esta ação novamente.|The conversation changed. Open this action again.
O atendimento mudou. Atualize a tela.|The conversation changed. Refresh the screen.
Mensagem de texto|Text message
Data e hora (seu fuso local)|Date and time (your local time zone)
O envio depende do canal conectado, do seu acesso e de você continuar responsável por este atendimento. Seu rascunho fica preservado.{4}{5}|Sending requires a connected channel, your access and continued ownership of this conversation. Your draft is preserved.{4}{5}
Fechar|Close
Agendar texto {7}|Schedule text {7}
Histórico de agendamentos|Schedule history
Agendamentos deste atendimento|Schedules for this conversation
 A resposta deve ocorrer antes de {0}, dentro da janela Meta.| Reply before {0}, within the Meta window.
 Novos agendamentos estão bloqueados até esta conexão permitir responder.| New schedules are blocked until this connection allows replies.
Agendada|Scheduled
Enviada|Sent
Envio bloqueado|Sending blocked
Falha no envio|Send failed
Envio sem confirmação|Send unconfirmed
Confira o responsável, o canal e as permissões antes de criar um novo agendamento.|Check the assigned operator, channel and permissions before creating a new schedule.
Cancelar agendamento|Cancel schedule
Nenhuma mensagem agendada.|No scheduled messages.
O responsável coordena agendamentos e encaminhamentos.|The assigned operator coordinates schedules and forwarding.
Somente o responsável ou a gestão pode organizar este atendimento.|Only the assigned operator or management can organize this conversation.
Atendimentos atualizados.|Conversations updated.
Devolver atendimento à fila|Return conversation to queue
Marcar atendimento como pendente|Mark conversation as pending
Motivo (opcional)|Reason (optional)
Contexto para sua equipe|Context for your team
O atendimento ficará disponível para outro atendente assumir.|The conversation will be available for another operator to take ownership.
Você poderá reabrir este atendimento quando precisar.|You can reopen this conversation when needed.
Ao reabrir, o atendimento volta à fila. Assuma para responder.|Reopening returns the conversation to the queue. Take ownership to reply.
Atualiza o status sem enviar uma mensagem ao cliente.|Updates the status without sending a customer message.
Confirmar|Confirm
Agendamento indisponível.|Schedule unavailable.
Agendamento cancelado.|Schedule cancelled.
Assuma outro atendimento conectado nesta empresa para encaminhar.|Take ownership of another connected conversation in this company to forward.
Encaminhar mensagem|Forward message
O conteúdo será enviado ao destino escolhido pelo número ou bot desse atendimento.|Content will be sent to the selected destination using its number or bot.
Atendimento de destino|Destination conversation
Selecione um atendimento com você|Select a conversation assigned to you
Encaminhar {3}|Forward {3}
Escolha um emoji para sua resposta.|Choose an emoji for your reply.
Assuma antes de responder.|Take ownership before replying.
A mensagem atingiu o limite.|The message reached the limit.
Confira novamente o atendimento de destino.|Check the destination conversation again.
Encaminhamento aceito pelo canal de destino.|Forwarding accepted by the destination channel.
Esta conexão não permite responder agora.|This connection does not currently allow replies.
Agende dentro da janela de resposta Meta exibida.|Schedule within the displayed Meta reply window.
Informe data e hora válidas.|Enter a valid date and time.
Mensagem de texto agendada.|Text message scheduled.
Atendimento devolvido à fila.|Conversation returned to queue.
Status do atendimento atualizado.|Conversation status updated.
Escolha uma empresa.|Choose a company.
O atendimento mudou. Abra novamente as respostas rápidas.|The conversation changed. Open quick replies again.
O contexto mudou. Abra novamente as respostas.|Context changed. Open replies again.
Gerenciar respostas rápidas|Manage quick replies
O contexto mudou. Abra novamente as respostas rápidas.|Context changed. Open quick replies again.
Assuma a conversa antes de usar uma resposta.|Take ownership before using a reply.
O atendimento mudou.|The conversation changed.
A atribuição mudou. Atualize antes de usar a resposta.|Assignment changed. Refresh before using the reply.
Esta resposta foi desativada. Abra a lista novamente.|This reply was disabled. Open the list again.
Somente administradores gerenciam respostas rápidas.|Only administrators manage quick replies.
Resposta indisponível. Reabra o catálogo.|Reply unavailable. Reopen the catalog.
Nova resposta rápida|New quick reply
Editar resposta rápida|Edit quick reply
Resposta indisponível.|Reply unavailable.
Resposta desativada.|Reply disabled.
Resposta reativada.|Reply reactivated.
O acesso ou a empresa mudou. Abra o catálogo novamente.|Access or company changed. Open the catalog again.
Salvo na empresa de origem. Reabra o catálogo atual.|Saved in the source company. Reopen the current catalog.
Resposta rápida salva.|Quick reply saved.
Salvar cadastro|Save record
O envio anterior pode ter chegado ao destino.|The previous send may have reached its destination.
Confira a entrega no destino antes de enviar outra mensagem. Descartar remove apenas o rascunho desta tela; o registro do envio fica preservado.|Check delivery at the destination before sending another message. Discarding removes only this screen's draft; the send record is preserved.
Voltar|Back
Descartar sem reenviar|Discard without resending
Rascunho descartado. Nenhuma mensagem reenviada.|Draft discarded. No message resent.
O responsável coordena o copiloto deste atendimento.|The assigned operator coordinates this conversation's copilot.
Mostrar contexto do atendimento|Show conversation context
Workspace atualizado.|Workspace refreshed.
Confirmação colocada na fila de envio.|Verification queued for sending.
Confirmação na fila. O proprietário precisa ativar o MepMail.|Verification queued. The owner needs to enable MepMail.
Backup cifrado criado e restauração local verificada.|Encrypted backup created and local restoration verified.
Logotipo removido da prévia. Salve a identidade para confirmar.|Logo removed from preview. Save identity to confirm.
Foto removida. Salve o perfil para confirmar.|Photo removed. Save profile to confirm.
Nova conversa no WhatsApp|New WhatsApp conversation
Escolha o número de origem e o contato. Você escreverá a mensagem na conversa antes de enviar.|Choose the source number and contact. You will write your message in the conversation before sending.
Número de origem|Source number
Nome do contato|Contact name
WhatsApp com DDD|WhatsApp with area code
Abrir conversa|Open conversation
Escolha o canal. Depois de criar, configure a conexão e valide o recebimento.|Choose a channel. After creation, configure its connection and validate reception.
Nome da conexão|Connection name
Número A · demonstração|Number A · demo
Número B · demonstração|Number B · demo
Widget de demonstração|Demo widget
Webchat por origens autorizadas|Webchat for authorized origins
Webchat desativado|Webchat disabled
Meta configurada · aceite da conta pendente|Meta configured · account approval pending
Meta desativada|Meta disabled
Webhook Meta recebido|Meta webhook received
MepMail e relay assinado; caixa postal externa necessária|MepMail and signed relay; external mailbox required
Canal de e-mail desativado|Email channel disabled
Bot aguardando conexão|Bot awaiting connection
Aguardando configuração do canal|Awaiting channel setup
Número de teste · final {0}|Test number · ending {0}
Atualize o atendimento antes de enviar.|Refresh the conversation before sending.
Não foi possível preparar este envio.|This send could not be prepared.
Preparar conexão real|Prepare real connection
Número esperado com DDD|Expected number with area code
Preencha somente para WhatsApp. O token Telegram será cadastrado no passo Conectar bot.|Fill in for WhatsApp only. Enter the Telegram token at the Connect bot step.
Personalizar bot Telegram|Customize Telegram bot
Nome, apresentação e comandos serão publicados no perfil deste bot.|Name, description and commands will be published on this bot's profile.
Nome público|Public name
Sobre|About
Apresentação|Description
Os comandos entram na caixa de atendimento como solicitações. Respostas de agentes serão conectadas em uma próxima etapa.|Commands enter the inbox as requests. Agent replies will be connected in a later step.
Publicar identidade|Publish identity
Adicionar copiloto|Add copilot
O agente prepara rascunhos. O envio continua sob controle da equipe.|The agent prepares drafts. Sending remains under the team's control.
Nome do agente|Agent name
Tipo de agente|Agent type
Função do agente|Agent role
Para Claude, Codex, OpenClaw ou Hermes que você já executa, escolha Agente via MCP. Descreva a função desta integração e depois crie seu acesso em Agentes conectados. O cadastro mantém o modo copiloto e não inicia uma conexão.|For an existing Claude, Codex, OpenClaw or Hermes agent, choose Agent via MCP. Describe the integration's role, then create its access in Connected agents. Registration keeps copilot mode and does not start a connection.
O administrador da empresa configura o acesso deste agente via MCP.|The company administrator configures this agent's MCP access.
Para agentes via MCP, configure uma identidade em Agentes conectados.|For agents via MCP, configure an identity in Connected agents.
Configurar runtime|Configure runtime
Conecte {0} a um serviço autorizado para preparar respostas.|Connect {0} to an authorized service to prepare replies.
Endpoint do runtime|Runtime endpoint
Hermes ou API compatível em um host autorizado pela operação.|Hermes or a compatible API on a host authorized by the operation.
Token de acesso|Access token
A conexão prepara rascunhos; ferramentas MCP e envio autônomo exigem configuração própria.|The connection prepares drafts; MCP tools and autonomous sending require separate configuration.
Deixe vazio para manter o token já cadastrado.|Leave blank to keep the existing token.
A chave é guardada cifrada e não aparece nas consultas.|The key is encrypted and does not appear in queries.
Salvar configuração|Save configuration
Escolha uma rota inicial e adapte os passos à sua operação.|Choose a starting route and adapt its steps to your operation.
Nome do fluxo|Flow name
Descrição|Description
Começar com|Start with
Entrada → fila da equipe|Input → team queue
Triagem: suporte ou fila|Triage: support or queue
Criar rascunho|Create draft
Rascunho do fluxo salvo.|Flow draft saved.
Versão publicada. A rota está disponível no atendimento.|Version published. The route is available in the inbox.
Nova etiqueta|New tag
Este passo não tem saída. Ajuste a estrutura avançada.|This step has no output. Adjust the advanced structure.
Estrutura avançada|Advanced structure
Ajuste os passos e as conexões. A validação completa acontece ao salvar.|Adjust steps and connections. Full validation happens on save.
Grafo do fluxo|Flow graph
Usar no editor|Use in editor
O adaptador da Meta terá onboarding e webhooks próprios. Cloud API e QR serão conexões distintas com capacidades diferentes.|The Meta adapter has its own onboarding and webhooks. Cloud API and QR are separate connections with different capabilities.
O adaptador normalizará mensagens, estados e anexos para a caixa de atendimento, respeitando as capacidades da plataforma.|The adapter normalizes messages, states and attachments for the inbox, respecting each platform's capabilities.
Nenhum QR falso ou credencial de produção é usado nesta prévia.|This preview uses no fake QR or production credentials.
Entendido|Got it
Integração externa pendente|External integration pending
Agente externo via MCP|External agent via MCP
Use o endpoint desta implantação e valide a primeira conexão no cliente do seu agente. Texto produzido pelo seu agente vira rascunho para revisão e envio humano.|Use this deployment's endpoint and validate the first connection in your agent's client. Its generated text becomes a draft for human review and sending.
Conectar em Agentes conectados {1}|Connect in Connected agents {1}
Copiloto desta empresa|Company copilot
{3} ferramentas concedidas. Cada execução depende da aprovação do responsável pelo atendimento.|{3} tools granted. Each execution requires the assigned operator's approval.
O copiloto prepara rascunhos para revisão. O envio continua com o atendente.|The copilot prepares drafts for review. The operator handles sending.
Modelo: {0}|Model: {0}
O runtime receberá empresa, conversa, versão e ID de execução. MCP fornece ferramentas e contexto com acesso delimitado.|The runtime receives company, conversation, version and execution ID. MCP provides tools and context with scoped access.
Transferência para humano precisa cancelar ou invalidar a resposta pendente. As sessões do desktop não são acessadas automaticamente.|Human handoff must cancel or invalidate the pending reply. Desktop sessions are not accessed automatically.
Adaptador planejado|Planned adapter
Assumir atendimento|Take ownership
O responsável atual é |Currently assigned to 
Motivo|Reason
Você assumiu a conversa.|You took ownership of the conversation.
Atribuição salva. O runtime externo ainda não está conectado.|Assignment saved. The external runtime is not yet connected.
Rascunho de demonstração|Demo draft
Texto simulado pelo sandbox. Nenhum modelo externo foi chamado.|Text simulated by the sandbox. No external model was called.
Conversa v{1} · {2}|Conversation v{1} · {2}
Descartar|Discard
Usar e editar|Use and edit
Assuma a conversa para usar o rascunho.|Take ownership of the conversation to use the draft.
Este agente prepara o texto no seu cliente MCP. Use Agentes conectados para configurar o acesso e entregar o rascunho.|This agent prepares text in its MCP client. Use Connected agents to configure access and deliver the draft.
Configure o runtime do agente selecionado antes de preparar a resposta.|Configure the selected agent's runtime before preparing a reply.
O copiloto tem uma execução ativa. Aguarde, decida sobre a ferramenta ou cancele.|The copilot has an active execution. Wait, decide on the tool or cancel.
A conexão MCP é verificada no cliente do seu agente, com a identidade criada em Agentes conectados.|The MCP connection is checked in your agent's client using the identity created in Connected agents.
O serviço Hermes respondeu com o modelo configurado.|Hermes responded using the configured model.
Execução cancelada.|Execution cancelled.
O atendimento ou seu texto mudou. Revise antes de usar o rascunho.|The conversation or your text changed. Review before using the draft.
Este rascunho não corresponde ao contexto atual. Prepare uma nova resposta.|This draft does not match the current context. Prepare a new reply.
Rascunho copiado. Revise antes de enviar.|Draft copied. Review before sending.
Aplicar fluxo à conversa|Apply flow to conversation
Veja o resultado antes de atualizar o atendimento. Esta ação não envia mensagens.|Check the result before updating the conversation. This action sends no messages.
Fluxo publicado|Published flow
Ver resultado|View result
Escolha novamente o fluxo.|Select the flow again.
Fluxo aplicado ao contexto da conversa.|Flow applied to conversation context.
Finalize ou descarte a gravação antes de abrir a lista.|Finish or discard the recording before opening the list.
Preparando o logotipo…|Preparing logo…
Logotipo pronto. Salve a identidade para confirmar.|Logo ready. Save identity to confirm.
Escolha outra imagem.|Choose another image.
Disponibilidade atualizada.|Availability updated.
Foto pronta. Salve o perfil para confirmar.|Photo ready. Save profile to confirm.
Limite de notas em rascunho atingido.|Note draft limit reached.
Aguarde a preparação da foto.|Wait for the photo to be prepared.
Salvando perfil…|Saving profile…
Salvar perfil|Save profile
Perfil salvo.|Profile saved.
Aguarde a imagem terminar de carregar.|Wait for the image to finish loading.
Identidade e logotipo salvos.|Identity and logo saved.
Integrações salvas.|Integrations saved.
Assuma este atendimento antes de salvar uma nota.|Take ownership before saving a note.
Escreva a nota antes de salvar.|Write the note before saving.
Nota salva somente para a equipe.|Note saved for the team only.
Finalize ou descarte a gravação antes de enviar.|Finish or discard the recording before sending.
Assuma esta conversa antes de responder.|Take ownership of this conversation before replying.
Escreva uma mensagem ou escolha um arquivo antes de enviar.|Write a message or choose a file before sending.
Este grupo está bloqueado para respostas. Seu rascunho foi preservado.|Replies to this group are blocked. Your draft was preserved.
A janela de resposta desta conexão expirou. Seu rascunho foi preservado.|This connection's reply window expired. Your draft was preserved.
A legenda do arquivo deve ter até 1.024 caracteres. Seu texto foi preservado.|The file caption must contain up to 1,024 characters. Your text was preserved.
Áudio no WhatsApp é enviado sem legenda. Remova o texto ou envie-o em outra mensagem.|WhatsApp audio is sent without a caption. Remove the text or send it separately.
O arquivo não foi preparado. Escolha novamente.|The file was not prepared. Select it again.
Envio aceito pelo {0}. Acompanhe o status na conversa.|Send accepted by {0}. Track its status in the conversation.
Resposta salva somente no sandbox.|Reply saved in the sandbox only.
Contexto da conversa atualizado.|Conversation context updated.
Salve as alterações antes de testar a rota.|Save changes before testing the route.
A conversa mudou, mas a atualização falhou. Atualize antes de tentar novamente.|The conversation changed but the update failed. Refresh before trying again.
O atendimento mudou. Abra a ação novamente.|The conversation changed. Open the action again.
Confira os IDs, os tipos dos passos e as conexões.|Check IDs, step types and connections.
Somente o responsável ou a gestão pode aplicar um fluxo.|Only the assigned operator or management can apply a flow.
Resultado da rota|Routing result
{0} · versão publicada {1}|{0} · published version {1}
Aplicar atualiza apenas o contexto desta conversa. Nenhuma mensagem será enviada.|Applying updates only this conversation's context. No message will be sent.
Aplicar resultado|Apply result
Conversa aberta. Escreva sua mensagem para enviar no WhatsApp.|Conversation opened. Write your message to send on WhatsApp.
Estrutura carregada. Salve o rascunho para validar.|Structure loaded. Save the draft to validate.
Configuração salva.|Configuration saved.
Confira o servidor local e atualize esta página.|Check the local server and refresh this page.
Conectar número de teste|Connect test number
No WhatsApp do número cadastrado: Configurações → Aparelhos conectados → Conectar aparelho.|On the registered number's WhatsApp: Settings → Linked devices → Link a device.
Preparando o pareamento…|Preparing pairing…
QR real de pareamento do WhatsApp|Real WhatsApp pairing QR
Escaneie com o WhatsApp do número de teste. O QR se renova automaticamente.|Scan using the test number's WhatsApp. The QR refreshes automatically.
Número conectado e conferido.|Number connected and verified.
Envie uma mensagem de teste para este número a partir de outro WhatsApp e abra Atendimento.|Send a test message to this number from another WhatsApp and open Inbox.
Abrir atendimento|Open inbox
Aguardando o WhatsApp preparar a conexão…|Waiting for WhatsApp to prepare the connection…
Telegram conectado|Telegram connected
Abra o bot no Telegram e envie /start para iniciar o atendimento. Para grupos, adicione este bot ao grupo.|Open the bot in Telegram and send /start to begin. For groups, add this bot to the group.
O bot está configurado para receber todas as mensagens de grupos.|The bot is configured to receive all group messages.
Privacidade ativa: recebe mensagens dirigidas ao bot. Para atendimento completo do grupo, ajuste /setprivacy no BotFather e readicione o bot.|Privacy enabled: receives messages directed to the bot. For full group support, adjust /setprivacy in BotFather and add the bot again.
Conectar Telegram|Connect Telegram
Crie um bot exclusivo para esta empresa e cadastre a chave aqui.|Create a dedicated bot for this company and enter its key here.
Abrir BotFather {0}|Open BotFather {0}
Envie /newbot no BotFather.|Send /newbot to BotFather.
Escolha o nome e um username terminado em bot.|Choose a name and a username ending in bot.
Copie o token e cole no campo abaixo.|Copy the token and paste it in the field below.
Depois de conectar, envie /start ao bot ou adicione-o a um grupo.|After connecting, send /start to the bot or add it to a group.
Token do BotFather|BotFather token
Cole o token aqui|Paste the token here
Guardado cifrado. Deixe vazio somente para retomar um bot já cadastrado.|Stored encrypted. Leave blank only to reconnect a registered bot.
Grupos do WhatsApp|WhatsApp groups
Selecione os grupos que entram no atendimento. Novas mensagens aparecerão na inbox com seus autores.|Select groups to include in support. New messages appear in the inbox with their authors.
O servidor não confirmou os grupos deste canal.|The server did not confirm this channel's groups.
Atualizar grupos|Refresh groups
Grupo não confirmado nesta revisão. Desmarque para salvar.|Group unconfirmed in this revision. Deselect to save.
Somente administradores podem publicar.|Only administrators can post.
Este número ainda não participa de grupos. Adicione-o ao grupo de teste pelo WhatsApp e volte aqui.|This number is not in any groups yet. Add it to the test group in WhatsApp and return here.
Revisão {2}|Revision {2}
Desmarcar interrompe novas entradas e respostas pelo painel. O histórico já recebido permanece. Até 100 grupos por seleção.|Deselecting stops new messages and replies through the panel. Received history remains. Up to 100 groups per selection.
Salvar grupos|Save groups
Revisão {0}|Revision {0}
Revisão atual consultada. Seu rascunho foi mantido; confira os grupos antes de salvar.|Current revision retrieved. Your draft was kept; check groups before saving.
Abra os grupos pelo administrador desta empresa e por um WhatsApp conectado.|Open groups as this company's administrator with a connected WhatsApp.
Aguarde a operação atual antes de abrir os grupos.|Wait for the current operation before opening groups.
Consultando grupos deste número…|Retrieving this number's groups…
Aguarde a confirmação da seleção atual.|Wait for confirmation of the current selection.
Aguarde a operação atual antes de salvar os grupos.|Wait for the current operation before saving groups.
Atualize os grupos e confira o rascunho antes de salvar novamente.|Refresh groups and check your draft before saving again.
Confira o canal, a revisão e até 100 grupos conhecidos desta seleção.|Check the channel, revision and up to 100 known groups in this selection.
O servidor não confirmou esta seleção. Atualize os grupos antes de tentar novamente.|The server did not confirm this selection. Refresh groups before trying again.
Grupos de atendimento atualizados.|Support groups updated.
A seleção mudou no servidor. Seu rascunho foi mantido; atualize os grupos e confira antes de salvar.|The selection changed on the server. Your draft was kept; refresh groups and check before saving.
Remova o anexo atual antes de adicionar outro.|Remove the current attachment before adding another.
Escolha um arquivo por envio.|Choose one file per send.
Cole um arquivo por envio.|Paste one file per send.
{1} Grupos ({2})|{1} Groups ({2})
{1} Personalizar bot|{1} Customize bot
{3} Grupos|{3} Groups
&nbsp;ativos|&nbsp;active
{2} canais em {3}|{2} channels in {3}
{6} Escolher imagem|{6} Choose image
PNG, JPEG ou WebP · imagem preparada neste dispositivo.|PNG, JPEG or WebP · image prepared on this device.
{14} Salvar identidade|{14} Save identity
te ajudar hoje?|help you today?
{11} Salvar perfil|{11} Save profile
e|and
. O login usa Google Identity Services.|. Sign-in uses Google Identity Services.
QR · Telegram · grupos|QR · Telegram · groups
{1} Remover passo|{1} Remove step
{8} Testar a rota|{8} Test route
{9} Simular rascunho salvo|{9} Simulate saved draft
{11} contexto do atendimento|{11} conversation context
{18} Copiloto|{18} Copilot
{14} Copiloto|{14} Copilot
{19} Preparar rascunho|{19} Prepare draft
{22} Fluxo da conversa|{22} Conversation flow
Finalize ou feche o formulário aberto antes de trocar o idioma.|Finish or close the open form before changing language.
Finalize a gravação ou o envio antes de trocar o idioma.|Finish recording or sending before changing language.
Não foi possível salvar o idioma. Sua preferência anterior foi mantida.|Unable to save the language. Your previous preference was kept.
 · plataforma| · platform
E-mail confirmado|Email verified
ferramenta concedida|tool granted
ferramentas concedidas|tools granted
 (opcional)| (optional)
outro atendente|another operator
 · salvo no sandbox| · saved in sandbox
 conectado| connected
 · configurar| · configure
lida|read
Idioma|Language
Ver guia e APIs {0}|View guide and APIs {0}
Agentes conectados {0}|Connected agents {0}
Ver todas as {0} etiquetas do atendimento|View all {0} conversation tags
{0} Memória do agente|{0} Agent memory
{0}Nota interna · {1}|{0}Internal note · {1}
{3} · só equipe|{3} · team only
Encaminhar|Forward
chat.suaempresa.com.br|chat.yourcompany.com
. Registre o motivo da intervenção.|. Record the reason for intervening.
Salve ou limpe os campos privados antes de trocar o idioma.|Save or clear private fields before changing language.
Português (Brasil)|Português (Brasil)
English|English
Idioma do painel|Dashboard language
Idioma salvo.|Language saved.
Seu idioma acompanha a sua conta. Mensagens e dados dos clientes mantêm o conteúdo original.|Your language follows your account. Customer messages and data keep their original content.
Preparando seu workspace…|Preparing your workspace…
Nome do copiloto|Copilot name
Descrição curta|Short description
Instruções de operação|Operating instructions
Opcional. Ex.: apresente-se como equipe de suporte, confirme o número do pedido antes de responder e nunca prometa prazos.|Optional. E.g.: introduce yourself as the support team, confirm the order number before replying and never promise deadlines.
Até 4.000 caracteres. Entram no início de cada preparação; não ampliam permissões nem dispensam a revisão humana.|Up to 4,000 characters. They are added at the start of every preparation; they do not expand permissions or replace human review.
Remover {label}|Remove {label}
Carregando…|Loading…
Dispensar aviso|Dismiss notice
Dispensar notificação|Dismiss notification
Trecho de código|Code snippet
Copiar|Copy
Copiado.|Copied.
Não foi possível copiar. Selecione o texto e copie manualmente.|Could not copy. Select the text and copy it manually.
Texto branco sobre sua cor: {ratio}:1 ✓|White text on your color: {ratio}:1 ✓
Texto branco sobre sua cor: {ratio}:1, abaixo do mínimo de leitura|White text on your color: {ratio}:1, below the minimum for reading
Usaremos texto escuro nos botões|We will use dark text on buttons
Ajustamos o tom do botão para manter a leitura|We adjusted the button shade to keep it readable
Os botões ganham um contorno para continuar visíveis no fundo claro|Buttons get an outline to stay visible on light backgrounds
Os agentes usam verde-azulado para não se confundir com a sua cor|Agents use teal so they are not confused with your color
Automação|Automation
Clientes|Clients
Plataforma|Platform
Configurações|Settings
Agentes e automação|Agents and automation
Revenda|Reseller
Marca e domínio|Brand and domain
Contas|Accounts
Usuários|Users
Cobrança|Billing
Saúde e versão|Health and version
Regras e SLA|Rules and SLA
Você não tem acesso a esta conversa.|You do not have access to this conversation.
Abrir link de outro workspace|Open a link from another workspace
Este link é do workspace {0}. Trocar de workspace?|This link belongs to the {0} workspace. Switch workspace?
Ficar aqui|Stay here
Trocar|Switch
Este link é de um workspace que não está disponível para você.|This link belongs to a workspace that is not available to you.
Central de atendimento|Customer service hub
Menu lateral|Sidebar
Menu da conta|Account menu
Você está aqui|You are here
Navegação rápida|Quick navigation
Pendências|Pending
Mais|More
Mais opções|More options
Trocar workspace ou empresa|Switch workspace or company
Trocar workspace ou empresa (atual: {company})|Switch workspace or company (current: {company})
Buscar workspace ou empresa|Search workspace or company
Workspaces|Workspaces
Empresas|Companies
Nada encontrado.|Nothing found.
plataforma|platform
suporte até {time}|support until {time}
suporte temporário|temporary support
Todas as empresas autorizadas|All authorized companies
Suporte temporário|Temporary support
até {time}|until {time}
Disponível|Available
Ocupado|Busy
Ausente|Absent
Fora de atendimento|Not in service
Animações|Animations
Sistema|System
Reduzidas|Reduced
Modo privacidade|Privacy mode
Desligado|Off
Ligado|On
Esconde nomes, telefones, fotos e prévias de clientes para apresentar ou compartilhar a tela.|Hides customer names, phones, photos and previews to present or share the screen.
Versão {version}|Version {version}
Ajuda e APIs|Help and APIs
Atalhos do teclado|Keyboard shortcuts
Atalhos disponíveis nesta versão.|Shortcuts available in this version.
Sair|Sign out
Buscar no painel|Find a page
Buscar uma área do painel|Find an area of the panel
Enviar a resposta ou salvar a nota interna|Send the reply or save the internal note
Enviar no chat da equipe (Shift + Enter quebra a linha)|Send in the team chat (Shift + Enter adds a line break)
Fechar a janela, o menu aberto ou o chat expandido|Close the dialog, the open menu or the expanded chat
Ajustar a largura da lista ou do contexto no divisor de painéis|Resize the list or the context at the panel divider
Expandir menu lateral|Expand sidebar
O menu ficou mais curto.|The menu got shorter.
Conhecimento e Agentes conectados agora ficam em Agentes, Fluxos em Automação e as telas da conta em Configurações. O chat da equipe abre pelo botão Equipe; Minha conta e Ajuda ficam no menu do seu avatar.|Knowledge and Connected agents now live in Agents, Flows in Automation and the account screens in Settings. The team chat opens from the Team button; My account and Help are in your avatar menu.
Grupos agora fica dentro de Atendimento e o chat da equipe abre pelo botão Equipe. Minha conta e Ajuda ficam no menu do seu avatar.|Groups now lives inside Inbox and the team chat opens from the Team button. My account and Help are in your avatar menu.
PENDÊNCIAS|PENDING
O que espera por você ou pela equipe nas empresas autorizadas.|What is waiting for you or your team in the authorized companies.
A lista de pendências ainda não está disponível nesta versão.|The pending list is not available in this version yet.
Por enquanto, as conversas na fila e as não lidas ficam na prioridade de atendimento da Visão geral.|For now, queued and unread conversations are in the conversation priority of the Overview.
Abrir a prioridade de atendimento|Open the conversation priority
PRIMEIRO USO|FIRST STEPS
Primeiro uso|First steps
Empresa, canal, equipe, agente e um atendimento de teste, na ordem que a sua conta pede.|Company, channel, team, agent and a test conversation, in the order your account needs.
O guia de primeiro uso ainda não está disponível nesta versão.|The first-steps guide is not available in this version yet.
Os passos para preparar a operação ficam na Visão geral.|The steps to set up your operation are in the Overview.
Abrir a Visão geral|Open the Overview
Ferramentas|Tools
FERRAMENTAS DOS AGENTES|AGENT TOOLS
Ferramentas para os copilotos desta empresa.|Tools for this company's copilots.
Servidores MCP, catálogo e concessões valem só para esta empresa. Só a administração do workspace altera esta configuração.|MCP servers, catalog and grants apply only to this company. Only the workspace administration changes this setup.
Servidores MCP e ferramentas dos copilotos|MCP servers and copilot tools
A configuração de ferramentas pertence ao administrador do workspace.|Tool configuration is managed by workspace administrators.
Ative um servidor e descubra suas ferramentas em Agentes › Ferramentas.|Enable a server and discover its tools in Agents › Tools.
Criar e revisar os textos prontos da equipe|Create and review the team's ready-made texts
Limite de números de WhatsApp do plano atingido. Para conectar outro número, o proprietário pode mudar de plano ou adicionar um número extra em Configurações › Financeiro.|Your plan's WhatsApp number limit has been reached. To connect another number, the owner can change plans or add an extra number in Settings › Billing.
Limite de usuários do plano atingido. Para convidar mais pessoas, o proprietário pode mudar de plano em Configurações › Financeiro. Os usuários atuais continuam com acesso.|Your plan's user limit has been reached. To invite more people, the owner can change plans in Settings › Billing. Current users keep their access.
`;
export const shellTranslations = Object.fromEntries(copy.trim().split('\n').map(line => { const split = line.indexOf('|'); return [line.slice(0, split), line.slice(split + 1)]; }));
registerTranslations(shellTranslations);
