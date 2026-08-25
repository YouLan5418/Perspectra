import { canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import { failWorldPackContract } from './diagnostics.ts'

class StrictWorldJsonReader {
  #offset = 0

  constructor(private readonly source: string) {}

  read(): WorldJsonValue {
    const value = this.#value()
    this.#whitespace()
    if (this.#offset !== this.source.length) throw new SyntaxError('contains trailing content')
    return value
  }

  #value(): WorldJsonValue {
    this.#whitespace()
    const token = this.source[this.#offset]
    if (token === '"') return this.#string()
    if (token === '{') return this.#object()
    if (token === '[') return this.#array()
    if (token === 't') return this.#literal('true', true)
    if (token === 'f') return this.#literal('false', false)
    if (token === 'n') return this.#literal('null', null)
    return this.#integer()
  }

  #object(): WorldJsonValue {
    this.#offset += 1
    const result: Record<string, WorldJsonValue> = {}
    const keys = new Set<string>()
    this.#whitespace()
    if (this.#take('}')) return result
    while (true) {
      this.#whitespace()
      if (this.source[this.#offset] !== '"') throw new SyntaxError('object keys must be strings')
      const key = this.#string()
      if (keys.has(key)) throw new SyntaxError(`contains duplicate object key ${JSON.stringify(key)}`)
      keys.add(key)
      this.#whitespace()
      this.#expect(':')
      result[key] = this.#value()
      this.#whitespace()
      if (this.#take('}')) return result
      this.#expect(',')
    }
  }

  #array(): WorldJsonValue {
    this.#offset += 1
    const result: WorldJsonValue[] = []
    this.#whitespace()
    if (this.#take(']')) return result
    while (true) {
      result.push(this.#value())
      this.#whitespace()
      if (this.#take(']')) return result
      this.#expect(',')
    }
  }

  #string(): string {
    const start = this.#offset
    this.#offset += 1
    let escaped = false
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset]!
      this.#offset += 1
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        return JSON.parse(this.source.slice(start, this.#offset)) as string
      } else if (character.charCodeAt(0) <= 0x1f) {
        throw new SyntaxError('strings cannot contain unescaped control characters')
      }
    }
    throw new SyntaxError('contains an unterminated string')
  }

  #integer(): number {
    const remaining = this.source.slice(this.#offset)
    const match = /^-?(?:0|[1-9]\d*)/u.exec(remaining)
    if (match === null) throw new SyntaxError('contains an unexpected token')
    this.#offset += match[0].length
    const value = Number(match[0])
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new SyntaxError('numbers must be safe integers and cannot be negative zero')
    return value
  }

  #literal(source: string, value: WorldJsonValue): WorldJsonValue {
    if (!this.source.startsWith(source, this.#offset)) throw new SyntaxError('contains an invalid literal')
    this.#offset += source.length
    return value
  }

  #whitespace(): void {
    while (this.#offset < this.source.length) {
      const code = this.source.charCodeAt(this.#offset)
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return
      this.#offset += 1
    }
  }

  #take(character: string): boolean {
    if (this.source[this.#offset] !== character) return false
    this.#offset += 1
    return true
  }

  #expect(character: string): void {
    if (!this.#take(character)) throw new SyntaxError(`expected ${character}`)
  }
}

/** Parse the strict integer-only World JSON source grammar and reject duplicate object keys. */
export function parseStrictWorldJson(source: string, file: string): WorldJsonValue {
  try {
    const value = new StrictWorldJsonReader(source).read()
    canonicalizeWorldJson(value)
    return value
  } catch (error) {
    failWorldPackContract('PACK_SOURCE_INVALID', file, '', `must be strict World JSON: ${String(error)}`)
  }
}
