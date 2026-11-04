import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

const flowNodeTypes = new Set(['start', 'condition', 'tag', 'department', 'handoff', 'end']);

export function validateFlowEditorGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || graph.departmentReferenceFormat !== 'id-v1') {
    throw new Error(i18nText('Use departmentReferenceFormat: "id-v1" e os IDs dos departamentos antes de aplicar o grafo no editor.'));
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length
    || graph.nodes.some(node => !node || typeof node.id !== 'string' || !node.id || !flowNodeTypes.has(node.type))) {
    throw new Error(i18nText('Confira os IDs, os tipos dos passos e as conexões.'));
  }
  const ids = new Set(graph.nodes.map(node => node.id));
  if (graph.edges.some(edge => !edge || !ids.has(edge.from) || !ids.has(edge.to))) throw new Error(i18nText('Confira os IDs, os tipos dos passos e as conexões.'));
  return structuredClone(graph);
}

export function flowEditorGraph(flow) {
  const graph = structuredClone(flow.editorGraph || flow.graph);
  if (flow.editorReferenceIssue === true) {
    graph.departmentReferenceFormat = 'id-v1';
    for (const node of graph.nodes) if (['department', 'handoff'].includes(node.type) && node.config?.department) node.config.department = '@revisar:' + node.id;
  }
  return graph;
}

export function flowDepartment(value, departments = [], format) {
  const entries = departments.filter(item => item && typeof item === 'object' && typeof item.id === 'string');
  const ids = entries.filter(item => item.id === value);
  if (format === 'id-v1') return ids.length === 1 ? ids[0] : null;
  const matches = entries.filter(item => item.id === value || item.name === value);
  return matches.length === 1 ? matches[0] : null;
}

export function flowDepartmentOptions(value, departments = [], { format, optional = false, escape } = {}) {
  const current = flowDepartment(value, departments, format);
  const placeholder = optional ? i18nText('Sem alterar o departamento') : i18nText('Escolha um departamento');
  const unavailable = value && !current ? i18nHtml`<option value="${escape(value)}" selected>Destino indisponível — revise o departamento</option>` : '';
  return `<option value="" ${!value ? 'selected' : ''}>${placeholder}</option>${unavailable}${departments.filter(item => item && typeof item === 'object' && typeof item.id === 'string').map(item => `<option value="${escape(item.id)}" ${current?.id === item.id ? 'selected' : ''}>${escape(item.name)}${item.active === false ? i18nText(' (inativo)') : ''}</option>`).join('')}`;
}
