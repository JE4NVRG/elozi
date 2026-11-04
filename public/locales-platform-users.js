import { registerTranslations } from './i18n.js';

// Product copy only; directory names, usernames and company values are untouched.
export const platformUsersTranslations = {
  'Diretório da plataforma': 'Platform directory',
  'Usuários globais': 'Global users',
  'Consulta administrativa': 'Administrative directory',
  '{count} pessoas encontradas': '{count} people found',
  'Exibindo {start}–{end} de {total}': 'Showing {start}–{end} of {total}',
  'Atualizar': 'Refresh',
  'Limpar filtros': 'Clear filters',
  'Os resultados abaixo são da última consulta concluída.': 'The results below are from the last completed request.',
  'Confirme seu acesso de administrador da plataforma antes de consultar novamente.': 'Confirm your platform administrator access before trying again.',
  'Tentar novamente': 'Try again',
  'Consultando pessoas na plataforma…': 'Loading people in the platform…',
  'Pessoas cadastradas na plataforma': 'People registered in the platform',
  'Diretório de pessoas, revendas, empresas e responsabilidades': 'Directory of people, resellers, companies and responsibilities',
  '+{count} outras empresas': '+{count} other companies',
  'Tente outro nome, usuário ou revenda, ou limpe os filtros.': 'Try another name, username or reseller, or clear the filters.',
  'As pessoas cadastradas na plataforma aparecerão aqui.': 'People registered in the platform will appear here.',
  'Paginação do diretório': 'Directory pagination',
  'Página {page} de {pages}': 'Page {page} of {pages}',
  'Consulte o diretório global': 'Explore the global directory',
  'Busque pessoas e confira a revenda, as empresas e a responsabilidade de cada cadastro.': 'Find people and check the reseller, companies and responsibility for each account.',
  'Carregar diretório': 'Load directory',
  'Não foi possível conferir os dados do diretório.': 'Unable to verify the directory data.',
  'Não foi possível carregar o diretório.': 'Unable to load the directory.'
};

registerTranslations(platformUsersTranslations);
