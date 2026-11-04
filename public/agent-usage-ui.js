import { h, t, getLocale } from './i18n.js';
import './locales-shell.js';
import './locales-agents-hub.js';
import { button, badge, progress, emptyState, banner } from './ui.js';

// AI usage of the agents (FRONTEND-V2 §5.3.1 "Hoje", §5.3.2 Uso, §8.6). Owned by P5; P8 reuses it
// read-only in Indicadores › Agentes. The data is GET /api/tenants/:id/agents/usage?days=30
// (src/agent-runtime.js usage(): {from, to, days, timeZone, limit, limitVersion, today, daily[],
// agents[], totals}), loaded and cached per company by mcp-ui.js (the same request app.js already
// triggers on the agents page), so this module only shapes and draws it:
// - daily input/output bars with the numbers behind them in a table;
// - totals, the daily quota with a progress bar and the administrator's "Ajustar cota";
// - runs by outcome and p50/p95 latency are not measured by the server yet: they say so ("em
//   breve"), never a fake zero.
// Raw tokens are for administrators only (the route itself is admin-only); without data the panels
// show the honest loading, error or "Medição disponível em breve" state.

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

export const formatNumber = value => new Intl.NumberFormat(getLocale()).format(count(value));
export const formatCompact = value => new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(count(value));
const formatDay = day => {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Intl.DateTimeFormat(getLocale(), { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, date));
};

/**
 * The usage report as plain numbers. Unknown or malformed reports → null (the caller shows "em
 * breve" or the error), never zeros invented here. Tokens: input = prompt, output = completion.
 */
export function usageModel(data) {
  if (!data || typeof data !== 'object' || !data.today || typeof data.today !== 'object' || !Array.isArray(data.daily)) return null;
  const rows = data.daily.filter(row => row && DAY_PATTERN.test(row.day)).map(row => {
    const input = count(row.promptTokens), output = count(row.completionTokens);
    return { day: row.day, agentId: String(row.agentId ?? ''), agentName: typeof row.agentName === 'string' ? row.agentName : null, runs: count(row.runs), input, output, total: count(row.totalTokens) || input + output };
  });
  const limit = Number.isSafeInteger(data.limit) && data.limit >= 0 ? data.limit : null;
  const todayInput = count(data.today.promptTokens), todayOutput = count(data.today.completionTokens);
  const today = { runs: count(data.today.runs), input: todayInput, output: todayOutput, total: count(data.today.totalTokens) || todayInput + todayOutput, blocked: data.today.blocked === true };
  const pct = limit === null ? null : limit === 0 ? 100 : Math.min(100, Math.round(today.total / limit * 100));
  const agents = (Array.isArray(data.agents) ? data.agents : []).filter(Boolean).map(agent => {
    const input = count(agent.promptTokens), output = count(agent.completionTokens);
    return { agentId: String(agent.agentId ?? ''), agentName: typeof agent.agentName === 'string' ? agent.agentName : null, runs: count(agent.runs), input, output, total: count(agent.totalTokens) || input + output };
  });
  const totalsInput = count(data.totals?.promptTokens), totalsOutput = count(data.totals?.completionTokens);
  const totals = { runs: count(data.totals?.runs), input: totalsInput, output: totalsOutput, total: count(data.totals?.totalTokens) || totalsInput + totalsOutput };
  const days = Number.isSafeInteger(data.days) && data.days > 0 && data.days <= 90 ? data.days : 30;
  const to = DAY_PATTERN.test(data.to) ? data.to : rows.reduce((last, row) => row.day > last ? row.day : last, '') || null;
  return { days, to, from: DAY_PATTERN.test(data.from) ? data.from : null, timeZone: typeof data.timeZone === 'string' ? data.timeZone : null, limit, limitVersion: Number.isSafeInteger(data.limitVersion) ? data.limitVersion : null, today, pct, rows, agents, totals };
}

/** One entry per day of the period (oldest first), for the company or one agent; days without rows are zero. */
export function dailySeries(model, { agentId = null, days = model?.days || 30 } = {}) {
  if (!model?.to) return [];
  const length = Math.max(1, Math.min(Number(days) || 30, 90));
  const [year, month, date] = model.to.split('-').map(Number), end = Date.UTC(year, month - 1, date), byDay = new Map();
  for (const row of model.rows) {
    if (agentId !== null && row.agentId !== agentId) continue;
    const entry = byDay.get(row.day) || { runs: 0, input: 0, output: 0, total: 0 };
    entry.runs += row.runs; entry.input += row.input; entry.output += row.output; entry.total += row.total;
    byDay.set(row.day, entry);
  }
  return Array.from({ length }, (_, index) => {
    const day = new Date(end - (length - 1 - index) * 86400000).toISOString().slice(0, 10);
    return { day, ...(byDay.get(day) || { runs: 0, input: 0, output: 0, total: 0 }) };
  });
}

/** Sum of a series ({runs, input, output, total}). */
export const seriesTotals = series => series.reduce((sum, entry) => ({ runs: sum.runs + entry.runs, input: sum.input + entry.input, output: sum.output + entry.output, total: sum.total + entry.total }), { runs: 0, input: 0, output: 0, total: 0 });

/**
 * Daily bars: input (soft) under output (accent) per day. The SVG carries a summary; the numbers of
 * every day are in the table of the "Ver números por dia" disclosure.
 */
export function usageBars(series, { label } = {}) {
  const totals = seriesTotals(series), max = Math.max(0, ...series.map(entry => entry.total));
  if (!series.length || max === 0) return h`<p class="pg-agents__muted">${t('Nenhum consumo registrado no período.')}</p>`;
  const width = 12, gap = 4, height = 120, view = series.length * (width + gap) - gap;
  const bars = series.map((entry, index) => {
    const x = index * (width + gap), inputHeight = entry.input / max * height, outputHeight = entry.output / max * height;
    const title = t('{day}: {total} tokens (entrada {input}, saída {output})', { day: formatDay(entry.day), total: formatNumber(entry.total), input: formatNumber(entry.input), output: formatNumber(entry.output) });
    return h`<g><title>${title}</title>${entry.input ? h`<rect class="pg-agents__bar pg-agents__bar--input" x="${x}" y="${(height - inputHeight).toFixed(2)}" width="${width}" height="${inputHeight.toFixed(2)}" rx="2"></rect>` : ''}${entry.output ? h`<rect class="pg-agents__bar pg-agents__bar--output" x="${x}" y="${(height - inputHeight - outputHeight).toFixed(2)}" width="${width}" height="${outputHeight.toFixed(2)}" rx="2"></rect>` : ''}</g>`;
  });
  const summary = label || t('Tokens por dia nos últimos {days} dias: {total} no total', { days: series.length, total: formatNumber(totals.total) });
  const rows = [...series].reverse().map(entry => h`<tr><td>${formatDay(entry.day)}</td><td class="pg-agents__num">${formatNumber(entry.runs)}</td><td class="pg-agents__num">${formatNumber(entry.input)}</td><td class="pg-agents__num">${formatNumber(entry.output)}</td><td class="pg-agents__num">${formatNumber(entry.total)}</td></tr>`);
  return h`<figure class="pg-agents__chart"><svg class="pg-agents__chart-svg" viewBox="0 0 ${view} ${height}" preserveAspectRatio="none" role="img" aria-label="${summary}">${bars}</svg><figcaption class="pg-agents__chart-axis"><span class="pg-agents__num">${formatDay(series[0].day)}</span><span class="pg-agents__legend"><span class="pg-agents__key pg-agents__key--input" aria-hidden="true"></span>${t('Entrada')} <span class="pg-agents__key pg-agents__key--output" aria-hidden="true"></span>${t('Saída')}</span><span class="pg-agents__num">${t('Hoje')} · ${formatCompact(series.at(-1).total)}</span></figcaption><details class="pg-agents__chart-data"><summary>${t('Ver números por dia')}</summary><div class="pg-agents__table-wrap"><table class="pg-agents__table pg-agents__table--compact"><thead><tr><th scope="col">${t('Dia')}</th><th scope="col">${t('Execuções')}</th><th scope="col">${t('Entrada')}</th><th scope="col">${t('Saída')}</th><th scope="col">${t('Total')}</th></tr></thead><tbody>${rows}</tbody></table></div></details></figure>`;
}

/** "182 mil de 500 mil tokens (36%)" or "182 mil tokens hoje · sem limite diário". */
export function quotaText(model) {
  if (model.limit === null) return t('{used} tokens hoje · sem limite diário', { used: formatCompact(model.today.total) });
  return t('{used} de {limit} tokens ({pct}%)', { used: formatCompact(model.today.total), limit: formatCompact(model.limit), pct: model.pct });
}

/**
 * Usage of the agents of the open company. source: {snapshot() → {data, error, loading} | null,
 * load({force}) → Promise, canEdit() → boolean}; the hub builds it over mcp-ui.js (the cached report).
 */
export function createAgentUsage({ source = null } = {}) {
  const snapshot = () => (typeof source?.snapshot === 'function' ? source.snapshot() : null) || null;
  const model = () => usageModel(snapshot()?.data);
  const canEdit = () => typeof source?.canEdit === 'function' && source.canEdit() === true;

  /**
   * No report to draw: loading (a snapshot without data), the error, or "em breve" when there is no
   * source (endpoint missing or not allowed) or the report has an unknown shape.
   */
  function pending(compact = false) {
    const current = snapshot();
    if (current?.error) return banner({ tone: 'warning', title: t('Não foi possível carregar o consumo de IA.'), body: current.error });
    if (current && !current.data) return h`<p class="pg-agents__muted" role="status">${t('Carregando o consumo de IA…')}</p>`;
    return compact ? h`<p class="pg-agents__muted">${t('Medição disponível em breve.')}</p>` : emptyState({ icon: 'chart', title: t('Medição disponível em breve'), body: t('O consumo por dia aparece aqui assim que o servidor o informar.'), level: 3 });
  }

  /** Quota of the day: progress, text, warning at 80%, blocked banner and the administrator's "Ajustar cota". */
  function quota(data = model(), { strip = false } = {}) {
    if (!data) return pending(true);
    const edit = canEdit() && data.limitVersion !== null ? button({ label: t('Ajustar cota'), action: 'agents:usage-limit', size: 'sm', variant: 'secondary' }) : '';
    const meter = data.limit === null ? '' : progress({ value: Math.min(data.today.total, Math.max(data.limit, 1)), max: Math.max(data.limit, 1), label: t('Cota diária de IA'), valueText: quotaText(data) });
    const runs = t('{runs} execuções hoje', { runs: formatNumber(data.today.runs) });
    const near = data.pct !== null && data.pct >= 80 && !data.today.blocked ? badge(t('Cota de IA perto do limite'), 'warning') : '';
    const level = data.today.blocked ? 'blocked' : data.pct !== null && data.pct >= 80 ? 'near' : 'ok';
    return h`<div class="pg-agents__quota${strip ? ' pg-agents__quota--strip' : ''}" data-state="${level}"><span class="pg-agents__quota-label">${t('Hoje')}</span><div class="pg-agents__quota-body">${meter}<p class="pg-agents__quota-text"><span class="pg-agents__num">${quotaText(data)}</span> · <span class="pg-agents__num">${runs}</span> · <span title="${t('Medição de adoção em breve')}">${t('rascunhos usados: —')}</span> ${near}</p></div>${edit}</div>${data.today.blocked ? banner({ tone: 'danger', title: t('Limite diário atingido.'), body: t('Novos rascunhos ficam bloqueados até o próximo dia.') }) : ''}`;
  }

  /** Runs by outcome and latency: not measured by the server yet (§7.4 agent-runs). */
  function outcomes() {
    return h`<section class="pg-agents__card" data-state="soon"><h3 class="pg-agents__h3">${t('Desfechos e latência')}</h3><p class="pg-agents__muted">${t('Execuções por desfecho (usado, editado, descartado) e latência p50/p95: medição em breve.')}</p></section>`;
  }

  /** Hub tab Uso (#agents/usage): quota, daily bars and the agents of the company. */
  function view() {
    const data = model();
    const head = h`<div class="pg-agents__section-head"><div><h2 class="pg-agents__h2">${t('Uso de IA')}</h2><p class="pg-agents__muted">${t('Tokens de entrada e saída dos copilotos desta empresa. A cota vale para todos os copilotos.')}</p></div></div>`;
    if (!data) return h`<div class="pg-agents__stack" data-agents-slot="usage"><section class="pg-agents__card">${head}${pending()}</section></div>`;
    const series = dailySeries(data), totals = seriesTotals(series);
    const agents = data.agents.length ? h`<div class="pg-agents__table-wrap"><table class="pg-agents__table"><thead><tr><th scope="col">${t('Agente')}</th><th scope="col">${t('Execuções')}</th><th scope="col">${t('Entrada')}</th><th scope="col">${t('Saída')}</th><th scope="col">${t('Total')}</th></tr></thead><tbody>${data.agents.map(agent => h`<tr><th scope="row">${agent.agentName || t('Agente removido')}</th><td class="pg-agents__num">${formatNumber(agent.runs)}</td><td class="pg-agents__num">${formatNumber(agent.input)}</td><td class="pg-agents__num">${formatNumber(agent.output)}</td><td class="pg-agents__num">${formatNumber(agent.total)}</td></tr>`)}</tbody></table></div>` : h`<p class="pg-agents__muted">${t('Nenhum agente consumiu tokens no período.')}</p>`;
    return h`<div class="pg-agents__stack" data-agents-slot="usage"><section class="pg-agents__card">${head}${quota(data)}</section><section class="pg-agents__card"><div class="pg-agents__section-head"><h3 class="pg-agents__h3">${t('Tokens por dia')}</h3><span class="pg-agents__muted pg-agents__num">${t('{days} dias · {total} tokens · {runs} execuções', { days: series.length, total: formatCompact(totals.total), runs: formatNumber(totals.runs) })}</span></div>${usageBars(series)}</section><section class="pg-agents__card"><h3 class="pg-agents__h3">${t('Por agente')}</h3>${agents}</section>${outcomes()}</div>`;
  }

  /** Detail tab Uso (#agents/<id>/usage) of one agent. */
  function agentPanel(agentId) {
    const data = model();
    if (!data) return h`<div class="pg-agents__stack" data-agents-slot="agent-usage"><section class="pg-agents__card">${pending()}</section></div>`;
    const series = dailySeries(data, { agentId }), totals = seriesTotals(series);
    return h`<div class="pg-agents__stack" data-agents-slot="agent-usage"><section class="pg-agents__card"><div class="pg-agents__section-head"><h2 class="pg-agents__h2">${t('Tokens por dia')}</h2><span class="pg-agents__muted pg-agents__num">${t('{days} dias · {total} tokens · {runs} execuções', { days: series.length, total: formatCompact(totals.total), runs: formatNumber(totals.runs) })}</span></div>${usageBars(series)}</section><section class="pg-agents__card"><h3 class="pg-agents__h3">${t('Cota da empresa')}</h3>${quota(data)}</section>${outcomes()}</div>`;
  }

  /** {runs, input, output, total} of today for one agent, or null without a report. */
  function agentToday(agentId) {
    const data = model();
    return data?.to ? seriesTotals(data.rows.filter(row => row.agentId === agentId && row.day === data.to)) : null;
  }

  /** Totals of the last `days` days for one agent, or null without a report. */
  function agentRecent(agentId, days = 7) {
    const data = model();
    return data ? seriesTotals(dailySeries(data, { agentId, days })) : null;
  }

  return { view, quota, agentPanel, agentToday, agentRecent, model, pendingNote: () => pending(true), load: options => source?.load?.(options) };
}
