import { Script, createContext } from 'node:vm'
import type { WorldJsonValue } from '@harness-world/contracts'
import type { StatusModuleSource } from '@harness-world/plugin-sdk'

/** Adapter for the existing synchronous packPlugin hooks. No native capability is visible in this VM. */
export function callModule(source: string, method: string, args: readonly WorldJsonValue[]): unknown {
  const context = createContext(
    { __method: method, __args: JSON.stringify(args) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' },
  )
  const output: unknown = new Script(
    source +
      '\nJSON.stringify(__method === "definition" ? packPlugin.definition : packPlugin[__method](...JSON.parse(__args)))',
  ).runInContext(context, { timeout: 100 })
  if (typeof output !== 'string' || output.length > 65536) throw new TypeError('Pack module must return bounded JSON')
  return JSON.parse(output)
}

/** Retain the existing source composition and hook semantics, including only the base onRoundEnd. */
export function composeStatusSource(
  base: string | undefined,
  modules: readonly StatusModuleSource[],
  missing: readonly string[],
): string {
  return `const base = (() => { ${base ?? 'globalThis.statusScript = null;'}; return globalThis.statusScript; })();
const modules = [${modules.map(module => `(() => { ${module.source}; return {id:${JSON.stringify(module.id)}, characters:${JSON.stringify(module.characters)}, plugin:globalThis.packPlugin}; })()`).join(',')}];
const unavailable = ${JSON.stringify(missing)};
globalThis.statusScript = {
 definition: { statuses: [...(base?.definition.statuses ?? []), ...modules.flatMap(m=>m.plugin.definition.statuses)],
   operations: [...(base?.definition.operations ?? []), ...modules.flatMap(m=>m.plugin.definition.actions.map(a=>{
     const {capability,method,...op}=a; return {...op,id:m.id+'-'+a.id}; }))] },
 initialize(ids) {
   const out={public:{},characters:Object.fromEntries(ids.map(id=>[id,{}])),reveals:[]};
   for(const script of [base,...modules.map(m=>m.plugin)].filter(Boolean)) {
     const initial=script.initialize(ids);
     for(const [key,value] of Object.entries(initial.public)) {if(key in out.public) throw new Error('Duplicate status');out.public[key]=value;}
     for(const id of ids) for(const [key,value] of Object.entries(initial.characters[id])) {if(key in out.characters[id]) throw new Error('Duplicate status');out.characters[id][key]=value;}
     out.reveals.push(...(initial.reveals??[]));
   } return out;
 },
 policy(view,actor,world) {
   const original=base?.policy?.(view,actor,world);
   const operations=[...(original?.operations??base?.definition.operations.map(o=>o.id)??[])];
   for(const m of modules) if(m.characters.includes(actor)) {
     const offered=m.plugin.policy(view,actor,world).operations;
     for(const id of offered) if(!m.plugin.definition.actions.some(a=>a.id===id)) throw new Error('Undeclared module action');
     operations.push(...offered.map(id=>m.id+'-'+id).filter(id=>!unavailable.includes(id)));
   } return {...(original??{}),operations};
 },
 resolve(truth,actor,operation,args,world,target,result) {
   for(const m of modules) for(const a of m.plugin.definition.actions) if(operation===m.id+'-'+a.id)
     return m.plugin.resolve(truth,actor,a.id,args,world,target,result);
   return base.resolve(truth,actor,operation,args,world,target);
 },
 onRoundEnd(...args) {return base?.onRoundEnd?.(...args)??null;}
};`
}
