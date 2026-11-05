/** Major.minor. A new service or optional field raises the minor; any change a plugin could trip over
 * raises the major. A plugin exports `hostApi` with the lowest version it needs. */
export const HOST_API_VERSION = '2.9'

/** Same major, and this host's minor at least the one the plugin asks for. */
export function hostApiCompatible(required: unknown, host: string = HOST_API_VERSION): boolean {
  const parse = (value: unknown) => {
    const match = typeof value === 'string' ? /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/u.exec(value) : null
    return match ? [Number(match[1]), Number(match[2])] : undefined
  }
  const wanted = parse(required),
    current = parse(host)
  return !!wanted && !!current && wanted[0] === current[0] && wanted[1]! <= current[1]!
}
