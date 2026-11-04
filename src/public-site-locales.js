// Exact public route pairs; URL language never negotiates on storage or Accept-Language.
const pairs = Object.freeze([
  ['/', '/en/'], ['/precos', '/en/pricing'], ['/contato', '/en/contact'],
  ['/termos', '/en/terms'], ['/privacidade', '/en/privacy']
]);
export function publicPath(path, locale) {
  const [pathname, fragment] = path.split('#');
  const pair = pairs.find(pair => pair.includes(pathname));
  if (!pair) throw Error(`Unknown public-site path: ${pathname}`);
  return pair[locale === 'en' ? 1 : 0] + (fragment === undefined ? '' : '#' + fragment);
}
export function localeAlternates(path) {
  return [['pt-BR', publicPath(path, 'pt-BR')], ['en', publicPath(path, 'en')], ['x-default', publicPath(path, 'pt-BR')]];
}
export function publicTranslator(locale, dictionary) {
  return (source, values = {}) => {
    const translated = locale === 'en' ? dictionary[source] : source;
    if (typeof translated !== 'string' || !translated) throw Error(`Missing English public-site key: ${JSON.stringify(source)}`);
    const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    if (JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(translated))) throw Error(`Public-site placeholder mismatch: ${source}`);
    return translated.replace(/\{(\w+)\}/g, (_, key) => {
      if (!Object.hasOwn(values, key)) throw Error(`Missing public-site placeholder: ${key}`);
      return String(values[key]);
    });
  };
}
