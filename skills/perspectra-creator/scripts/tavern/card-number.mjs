const parsedNumbers = new WeakSet()

export class JsonNumber {
  constructor(raw) {
    this.raw = raw
    this.integer = !/[.eE]/u.test(raw)
    this.value = this.integer ? BigInt(raw) : Number(raw)
    if (!this.integer && !Number.isFinite(this.value)) throw new TypeError(`Non-finite JSON number: ${raw}`)
    parsedNumbers.add(this)
    Object.freeze(this)
  }
}

export function isJsonNumber(value) {
  return value !== null && typeof value === 'object' && parsedNumbers.has(value)
}
