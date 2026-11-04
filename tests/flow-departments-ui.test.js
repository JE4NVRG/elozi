import test from 'node:test';
import assert from 'node:assert/strict';
import { flowEditorGraph, flowDepartment, flowDepartmentOptions, validateFlowEditorGraph } from '../public/flow-departments-ui.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const departments=[{id:'original',name:'Suporte'},{id:'new',name:'Comercial'}];
test('editor usa destinos resolvidos pelo servidor sem modificar grafo legado ou publicação',()=>{
  const graph={nodes:[{id:'a',type:'department',config:{department:'Suporte'}}],edges:[]};
  const editorGraph={departmentReferenceFormat:'id-v1',nodes:[{id:'a',type:'department',config:{department:'original'}}],edges:[]};
  const flow={graph,editorGraph,editorReferenceIssue:false},draft=flowEditorGraph(flow);
  assert.equal(draft.nodes[0].config.department,'original');draft.nodes[0].config.department='new';assert.equal(editorGraph.nodes[0].config.department,'original');assert.equal(graph.nodes[0].config.department,'Suporte');
});
test('vínculo inválido exige escolhas explícitas e não infere departamento pelo nome reutilizado',()=>{
  const graph={nodes:[{id:'a',type:'department',config:{department:'Suporte'}},{id:'b',type:'handoff',config:{owner:'queue',department:'Suporte'}}],edges:[]};
  const draft=flowEditorGraph({graph,editorGraph:null,editorReferenceIssue:true});assert.equal(draft.departmentReferenceFormat,'id-v1');
  for(const node of draft.nodes){assert.equal(flowDepartment(node.config.department,departments,draft.departmentReferenceFormat),null);assert.match(flowDepartmentOptions(node.config.department,departments,{format:draft.departmentReferenceFormat,escape}),/selected>Destino indisponível/);}
  assert.equal(graph.nodes[0].config.department,'Suporte');assert.equal(graph.nodes[1].config.department,'Suporte');
});
test('editor mantém ID selecionado após rename e exibe o nome atual escapado',()=>{
  const renamed=[{id:'original',name:'Pós-venda <novo>'},{id:'new',name:'Suporte'}];
  const html=flowDepartmentOptions('original',renamed,{format:'id-v1',escape});
  assert.match(html,/value="original" selected>Pós-venda &lt;novo>/);assert.doesNotMatch(html,/value="new" selected/);
  assert.equal(flowDepartment('original',renamed,'id-v1').id,'original');assert.equal(flowDepartment('Suporte',departments).id,'original');
});
test('destino por ID excluído não seleciona novo departamento com nome igual ao ID',()=>{
  const replacement=[{id:'new',name:'original'}];const html=flowDepartmentOptions('original',replacement,{format:'id-v1',escape});
  assert.equal(flowDepartment('original',replacement,'id-v1'),null);assert.match(html,/value="original" selected>Destino indisponível/);assert.doesNotMatch(html,/value="new" selected/);
  assert.equal(flowDepartment('duplicado',[{id:'duplicado',name:'A'},{id:'other',name:'duplicado'}]),null);
});
test('seleção opcional vazia e departamento inativo permanecem explícitos, sem escolher primeira opção',()=>{
  const html=flowDepartmentOptions('',departments,{format:'id-v1',optional:true,escape});assert.match(html,/value="" selected>Sem alterar/);assert.doesNotMatch(html,/value="original" selected/);
  const inactive=flowDepartmentOptions('original',[{id:'original',name:'Suporte',active:false}],{format:'id-v1',escape});assert.match(inactive,/selected>Suporte \(inativo\)/);
});

test('editor avançado recusa grafo sem formato antes de inferir destino por nome reutilizado',()=>{
  const renamed=[{id:'original',name:'Atendimento atual'},{id:'new',name:'Suporte'}];
  const graph={nodes:[{id:'a',type:'department',config:{department:'Suporte'}}],edges:[]};
  const before=structuredClone(graph);
  assert.equal(flowDepartment('Suporte',renamed).id,'new');
  assert.throws(()=>validateFlowEditorGraph(graph),/departmentReferenceFormat.*id-v1.*IDs dos departamentos/);
  assert.deepEqual(graph,before);
  assert.throws(()=>validateFlowEditorGraph({...graph,departmentReferenceFormat:'name-v1'}),/id-v1.*IDs dos departamentos/);
});

test('editor avançado preserva formato, IDs explícitos e grafo completo em cópia independente',()=>{
  const graph={departmentReferenceFormat:'id-v1',nodes:[
    {id:'start',type:'start',config:{}},
    {id:'route',type:'department',config:{department:'original'}},
    {id:'handoff',type:'handoff',config:{owner:'queue',department:'Suporte'}},
    {id:'end',type:'end',config:{}}
  ],edges:[{from:'start',to:'route'},{from:'route',to:'handoff'},{from:'handoff',to:'end'}],layout:{route:{x:10,y:20}}};
  const before=structuredClone(graph),draft=validateFlowEditorGraph(graph);
  assert.deepEqual(draft,before);assert.notEqual(draft,graph);assert.notEqual(draft.nodes,graph.nodes);assert.notEqual(draft.layout,graph.layout);
  const renamed=[{id:'original',name:'Atendimento atual'},{id:'Suporte',name:'Escolha explícita'}];
  assert.equal(flowDepartment(draft.nodes[2].config.department,renamed,draft.departmentReferenceFormat).name,'Escolha explícita');
  draft.nodes[1].config.department='Suporte';draft.layout.route.x=50;draft.edges[0].to='handoff';
  const saved=validateFlowEditorGraph(draft);
  assert.equal(saved.departmentReferenceFormat,'id-v1');assert.equal(saved.nodes[1].config.department,'Suporte');assert.equal(saved.layout.route.x,50);assert.equal(saved.edges[0].to,'handoff');
  assert.deepEqual(graph,before);
});

test('editor avançado rejeita estruturas inválidas com erro claro antes de trocar o rascunho',()=>{
  const valid={departmentReferenceFormat:'id-v1',nodes:[{id:'start',type:'start',config:{}},{id:'end',type:'end',config:{}}],edges:[{from:'start',to:'end'}]};
  for(const graph of [null,[],{...valid,departmentReferenceFormat:undefined}])assert.throws(()=>validateFlowEditorGraph(graph),/id-v1.*IDs dos departamentos/);
  for(const graph of [{...valid,nodes:null},{...valid,edges:null},{...valid,nodes:[]},{...valid,nodes:[null]},{...valid,nodes:[{id:'a',type:'webhook'}]},{...valid,edges:[null]},{...valid,edges:[{from:'start',to:'missing'}]}]) {
    assert.throws(()=>validateFlowEditorGraph(graph),/Confira os IDs, os tipos dos passos e as conexões/);
  }
  assert.deepEqual(validateFlowEditorGraph(valid),valid);
});
