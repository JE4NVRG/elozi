import { fail } from './store.js';
import { allowedFields } from './access.js';

const palettes = ['panel','header','field','border','text','muted','primary','primaryText','accent'];
const words = (value, limit, field) => {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail(400, `Campo inválido: ${field}.`);
  return value.trim();
};
export function visitorEmail(value = '') {
  const email = words(value, 254, 'email').toLowerCase();
  if (email && (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) || email.startsWith('.') || email.split('@')[0].endsWith('.') || email.includes('..'))) fail(400, 'Informe um e-mail válido.');
  return email;
}
export const visitorLocale = value => value === 'en' || value?.startsWith?.('en-') ? 'en' : 'pt-BR';
const localized = (value, key) => {
  allowedFields(value, ['pt-BR','en']);
  return Object.fromEntries(Object.entries(value).map(([locale, copy]) => [locale, words(copy, 600, key)]));
};
const palette = value => {
  allowedFields(value, palettes);
  return Object.fromEntries(Object.entries(value).map(([key,color]) => {
    if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail(400, `Cor inválida: ${key}.`);
    return [key,color];
  }));
};
const image = value => {
  if (value === '') return '';
  let url; try { url = new URL(value); } catch { fail(400, 'Use uma imagem HTTPS pública.'); }
  if (typeof value !== 'string' || value.length > 1000 || url.protocol !== 'https:' || url.username || url.password || url.hash) fail(400, 'Use uma imagem HTTPS pública.');
  return url.href;
};
export function normalizeWidgetConfiguration(value) {
  allowedFields(value, ['displayName','theme','colors','lightColors','radius','avatarUrl','logoUrl','openButtonLabel','credit','greeting','verifiedGreeting','handoffMessage','awaitingMessage','emailPrompt','attachmentsEnabled','voiceEnabled','feedbackEnabled','handoffNotificationEmail','assistantInstructions']);
  const result = {};
  for (const [key,input] of Object.entries(value)) {
    if (['displayName','openButtonLabel'].includes(key)) result[key] = words(input,80,key);
    else if (['colors','lightColors'].includes(key)) result[key] = palette(input);
    else if (key === 'theme') { if (!['light','dark'].includes(input)) fail(400,'Tema inválido.'); result[key] = input; }
    else if (key === 'radius') { if (!Number.isInteger(input) || input < 0 || input > 24) fail(400,'Raio inválido.'); result[key] = input; }
    else if (['avatarUrl','logoUrl'].includes(key)) result[key] = image(input);
    else if (['greeting','verifiedGreeting','handoffMessage','awaitingMessage'].includes(key)) result[key] = localized(input,key);
    else if (key === 'credit') { allowedFields(input,['visible','text']); if (typeof input.visible !== 'boolean') fail(400,'Crédito inválido.'); result[key] = {visible:input.visible,text:words(input.text ?? '',120,key)}; }
    else if (key === 'handoffNotificationEmail') result[key] = visitorEmail(input);
    else if (key === 'assistantInstructions') { if (typeof input !== 'string' || input.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input)) fail(400,'Instruções inválidas.'); result[key] = input.trim(); }
    else { if (typeof input !== 'boolean') fail(400, `Campo inválido: ${key}.`); result[key] = input; }
  }
  return result;
}
export function publicWidgetConfiguration(channel) {
  if (!channel?.webchat?.widget) return undefined;
  const { handoffNotificationEmail, assistantInstructions, ...widget } = normalizeWidgetConfiguration(channel.webchat.widget);
  return widget;
}
