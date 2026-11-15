import { expect, it } from 'vitest'
import { GameplayScript } from './gameplay-script.ts'

it('keeps functions in the VM, copies inputs, and forwards only call-scoped computations', () => {
  const script = new GameplayScript(`
    const method = { id: 'test:method', resolve: ({parameters}) => ({status:'accepted', outcome:parameters, effects:[]}) };
    module.exports = { id:'test:script', methods:[method], operations:[{
      id:'test:run', resolve(input) {
        input.state.items.push('private-copy');
        const computed = input.compute(method, { n: input.rollDice('d6').total });
        return computed;
      }
    }] };
  `)
  const state = { items: ['original'] }
  const op = script.definition.operations[0]!
  expect(
    op.resolve({
      state,
      actorId: 'character:a' as never,
      parameters: {},
      rollDice: () => ({ total: 4 }) as never,
      compute: (method, parameters) => {
        expect(method).toBe(script.definition.methods![0])
        return { status: 'accepted', outcome: parameters, effects: [] } as never
      },
    }),
  ).toEqual({ status: 'accepted', outcome: { n: 4 }, effects: [] })
  expect(state.items).toEqual(['original'])
  script.close()
  expect(() => op.resolve({} as never)).toThrow('closed')
})

it('bounds synchronous hooks and refuses async or non-JSON results', () => {
  for (const body of ['while(true) {}', 'return Promise.resolve({})', 'return {n:NaN}', 'return new Map()']) {
    const script = new GameplayScript('module.exports = { operations: [{ resolve() { ' + body + ' } }] }')
    expect(() => script.definition.operations[0]!.resolve({} as never)).toThrow()
    script.close()
  }
})

it('does not expose require, process, clocks or unrecorded randomness', () => {
  const script = new GameplayScript(
    'module.exports = { operations: [{ resolve() { return { require:typeof require, process:typeof process, date:typeof Date }; } }] }',
  )
  expect(script.definition.operations[0]!.resolve({} as never)).toEqual({
    require: 'undefined',
    process: 'undefined',
    date: 'undefined',
  })
  script.close()
})

it('rejects hidden async work before it can create an unhandled rejection', async () => {
  for (const source of [
    'module.exports={operations:[{async resolve(){throw new Error("async")}}]}',
    'module.exports={operations:[{resolve(){(async()=>{throw new Error("async")})()}}]}',
    'module.exports={operations:[{resolve(){import("missing-module")}}]}',
  ])
    expect(() => new GameplayScript(source)).toThrow('synchronous')
  const script = new GameplayScript(
    'module.exports={operations:[{resolve(){Promise.reject(new Error("unhandled")); return {status:"accepted",outcome:null,effects:[]}}}]}',
  )
  expect(() => script.definition.operations[0]!.resolve({} as never)).toThrow()
  await new Promise(resolve => setImmediate(resolve))
  script.close()
})

it('expires retained capabilities and preserves core callback fault identity', () => {
  const script = new GameplayScript(
    'let saved; module.exports={operations:[{resolve(input){ if(input.random) {saved=input.random;return null} try {return saved()} catch {return null} } }]}',
  )
  let count = 0
  script.definition.operations[0]!.resolve({ random: () => ++count } as never)
  script.definition.operations[0]!.resolve({} as never)
  expect(count).toBe(0)
  script.close()
})

it.each([
  'WebAssembly.compile(new Uint8Array())',
  'Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0).value',
  'Array.fromAsync([1])',
  'new AsyncDisposableStack().disposeAsync()',
])('does not expose an asynchronous builtin: %s', async expression => {
  const script = new GameplayScript('module.exports={operations:[{resolve(){' + expression + '; return null}}]}')
  expect(() => script.definition.operations[0]!.resolve({} as never)).toThrow()
  await new Promise(resolve => setImmediate(resolve))
  script.close()
})
