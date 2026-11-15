import { parse } from 'acorn'
import { Script, createContext, type Context } from 'node:vm'
import type { ContentGameplay } from '@harness-world/plugin-sdk'

const LIMIT = 1024 * 1024
// Values crossing the VM boundary are tagged JSON. Functions never leave their executor.
type Wire =
  | { t: 'value'; v: unknown }
  | { t: 'undefined' }
  | { t: 'function'; id: number }
  | { t: 'callback'; id: number }
  | { t: 'ref'; id: number }
  | { t: 'array'; v: Wire[]; id?: number }
  | { t: 'object'; v: Record<string, Wire>; id?: number }

function requireSynchronousScript(source: string): void {
  const pending: unknown[] = [parse(source, { ecmaVersion: 2022, sourceType: 'script' })]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const node = value as Record<string, unknown>
    if (node.async === true || node.type === 'AwaitExpression' || node.type === 'ImportExpression')
      throw new TypeError('Gameplay scripts must be synchronous; async/await/import() are not supported')
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child)
      else if (child && typeof child === 'object') pending.push(child)
    }
  }
}

const BOOTSTRAP = String.raw`
const module = { exports: {} };
const __functions = [], __objects = [];
function __encode(value, references = false, seen = new Set()) {
  if (value === undefined) return { t: 'undefined' };
  if (typeof value === 'function') {
    if (references) throw new TypeError('Functions are not results');
    const id = __functions.push(value) - 1;
    return { t: 'function', id };
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return { t: 'value', v: value };
  if (value && typeof value.then === 'function') {
    throw new TypeError('Expected synchronous JSON');
  }
  if (!value || typeof value !== 'object') throw new TypeError('Expected synchronous JSON');
  if (references && __objects.includes(value)) return { t: 'ref', id: __objects.indexOf(value) };
  if (seen.has(value)) throw new TypeError('Cyclic result');
  seen.add(value);
  const id = references ? undefined : __objects.push(value) - 1;
  let result;
  if (Array.isArray(value)) result = { t: 'array', id, v: Array.from(value, entry => __encode(entry, references, seen)) };
  else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected plain object');
    result = { t: 'object', id, v: Object.fromEntries(Object.keys(value).map(key => [key, __encode(value[key], references, seen)])) };
  }
  seen.delete(value);
  return result;
}
function __decode(value, bridge) {
  if (value.t === 'undefined') return undefined;
  if (value.t === 'value') return value.v;
  if (value.t === 'ref') return __objects[value.id];
  if (value.t === 'callback') return (...args) => {
    const response = JSON.parse(bridge(value.id, JSON.stringify(__encode(args, true))));
    if (response.error) throw new Error('Controlled capability failed');
    return __decode(response.value, bridge);
  };
  if (value.t === 'array') return value.v.map(entry => __decode(entry, bridge));
  return Object.fromEntries(Object.entries(value.v).map(([key, entry]) => [key, __decode(entry, bridge)]));
}
function __invoke(id, input, bridge) {
  const result = __functions[id](...__decode(JSON.parse(input), bridge));
  return JSON.stringify(__encode(result, true));
}
Math.random = () => { throw new Error('Use the supplied recorded random capability'); };
// Keep only synchronous data/algorithm primitives. New VM globals do not gain authority implicitly.
const __allowedGlobals = new Set([
  'Object','Function','Array','Number','parseFloat','parseInt','Infinity','NaN','undefined',
  'Boolean','String','Symbol','RegExp','Error','AggregateError','EvalError','RangeError',
  'ReferenceError','SyntaxError','TypeError','URIError','globalThis','JSON','Math',
  'Map','Set','WeakMap','WeakSet','BigInt','Proxy','Reflect','decodeURI','decodeURIComponent',
  'encodeURI','encodeURIComponent','isFinite','isNaN'
]);
for (const name of Object.getOwnPropertyNames(globalThis))
  if (!__allowedGlobals.has(name)) delete globalThis[name];
delete Array.fromAsync;
`

/** A self-contained CommonJS author module, with the same SDK definition as a native plugin. */
export class GameplayScript {
  readonly definition: ContentGameplay
  readonly #context: Context
  readonly #objects = new Map<number, unknown>()
  #closed = false
  readonly #call = new Script('__invoke(__id, __input, __bridge)')

  constructor(source: string, filename = 'scripts/gameplay.js') {
    if (Buffer.byteLength(source) > LIMIT) throw new TypeError('Gameplay script exceeds 1 MiB')
    requireSynchronousScript(source)
    this.#context = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    })
    new Script(BOOTSTRAP, { filename: 'gameplay-loader' }).runInContext(this.#context, { timeout: 100 })
    new Script(source, { filename }).runInContext(this.#context, { timeout: 100 })
    const metadata: unknown = new Script('JSON.stringify(__encode(module.exports))').runInContext(this.#context, {
      timeout: 100,
    })
    this.definition = this.#decode(this.#parse(metadata)) as ContentGameplay
  }
  close(): void {
    this.#closed = true
    this.#objects.clear()
  }

  #parse(text: unknown): Wire {
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT)
      throw new TypeError('Gameplay result exceeds JSON limit')
    return JSON.parse(text) as Wire
  }
  #decode(value: Wire): unknown {
    if (value.t === 'undefined') return undefined
    if (value.t === 'value') return value.v
    if (value.t === 'ref') {
      if (!this.#objects.has(value.id)) throw new TypeError('Unknown gameplay reference')
      return this.#objects.get(value.id)
    }
    if (value.t === 'function') return (...args: unknown[]) => this.#invoke(value.id, args)
    if (value.t === 'callback') throw new TypeError('Unexpected callback')
    const result: unknown =
      value.t === 'array'
        ? value.v.map(entry => this.#decode(entry))
        : Object.fromEntries(Object.entries(value.v).map(([key, entry]) => [key, this.#decode(entry)]))
    if (value.id !== undefined) this.#objects.set(value.id, result)
    return result
  }
  #encode(value: unknown, callbacks: ((...args: unknown[]) => unknown)[]): Wire {
    if (value === undefined) return { t: 'undefined' }
    if (typeof value === 'function') {
      const id = callbacks.push(value as (...args: unknown[]) => unknown) - 1
      return { t: 'callback', id }
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return { t: 'value', v: value }
    if (Array.isArray(value)) return { t: 'array', v: value.map(entry => this.#encode(entry, callbacks)) }
    if (!value || typeof value !== 'object') throw new TypeError('Expected JSON input')
    return {
      t: 'object',
      v: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.#encode(entry, callbacks)])),
    }
  }
  #invoke(id: number, args: unknown[]): unknown {
    if (this.#closed) throw new Error('Gameplay script is closed')
    const callbacks: ((...args: unknown[]) => unknown)[] = []
    const input = JSON.stringify(this.#encode(args, callbacks))
    if (Buffer.byteLength(input) > LIMIT) throw new TypeError('Gameplay input exceeds JSON limit')
    let active = true
    let callbackError: unknown
    const bridge = (callbackId: number, text: string): string => {
      if (!active) return JSON.stringify({ error: true })
      try {
        const values = this.#decode(this.#parse(text)) as unknown[]
        const result = callbacks[callbackId]!(...values)
        return JSON.stringify({ value: this.#encode(result, []) })
      } catch (error) {
        callbackError ??= error
        return JSON.stringify({ error: true })
      }
    }
    Object.setPrototypeOf(bridge, null)
    const previous = { id: this.#context.__id, input: this.#context.__input, bridge: this.#context.__bridge }
    Object.assign(this.#context, { __id: id, __input: input, __bridge: bridge })
    try {
      const result = this.#decode(this.#parse(this.#call.runInContext(this.#context, { timeout: 100 })))
      if (callbackError) throw callbackError
      return result
    } catch (error) {
      throw callbackError ?? error
    } finally {
      active = false
      Object.assign(this.#context, { __id: previous.id, __input: previous.input, __bridge: previous.bridge })
    }
  }
}
