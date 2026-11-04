import { registerTranslations } from './i18n.js';

export const channelRecoveryTranslations = Object.freeze({
  'Abrir conversas': 'Open conversations',
  'Abrir conversas de {channel} em {company}': 'Open conversations from {channel} in {company}',
  'Retentativa agendada': 'Retry scheduled',
  'Não foi possível atualizar esta conexão; verificando novamente.': 'Could not refresh this connection; checking again.',
  'O código exibido pode estar desatualizado. Aguarde a próxima verificação.': 'The displayed code may be out of date. Wait for the next check.'
});
registerTranslations(channelRecoveryTranslations);