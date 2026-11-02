import type { Server } from 'node:net'

type Listen = (this: Server, ...args: unknown[]) => Server

/**
 * Make `listen(0)` retry on a port the predicate refuses, invisibly to the caller: its listeners and callback
 * only ever see the final port. Tests start many servers, and on a machine with a low dynamic port range a
 * few land on ports fetch refuses, which looks like a random test failing.
 */
export function avoidBlockedPorts(proto: Server, isBlocked: (port: number) => boolean): void {
  const listen = proto.listen as unknown as Listen
  proto.listen = function (this: Server, ...args: unknown[]) {
    const first = args[0] as number | { port?: number } | undefined
    if (first !== 0 && (typeof first !== 'object' || first?.port !== 0)) return listen.apply(this, args)
    const retryArgs = args.filter(arg => typeof arg !== 'function')
    const emit = this.emit
    let retrying = false
    this.emit = function (this: Server, name: string | symbol, ...rest: unknown[]) {
      if (name === 'close' && retrying) {
        retrying = false
        listen.apply(this, retryArgs)
        return true
      }
      if (name === 'listening') {
        const { port } = this.address() as { port: number }
        if (isBlocked(port)) {
          retrying = true
          this.close()
          return true
        }
        this.emit = emit
      }
      return (emit as (this: Server, name: string | symbol, ...args: unknown[]) => boolean).call(this, name, ...rest)
    } as typeof this.emit
    return listen.apply(this, args)
  } as typeof proto.listen
}
