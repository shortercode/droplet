import { Signal } from "@preact/signals-core"

type JSONValue = string | number | boolean | null | undefined | JSONObject | JSONValue[]
type JSONObject = { [key: string]: JSONValue }

type PoolObject = {
  readonly updatedAt: number
  readonly fields: Readonly<Record<string, PoolAny>>
}

type PoolReference = {
  [REF_LABEL]: string
}
type PoolAny = PoolReference | JSONValue

type IndexableObject = {
  id: string | number
  [TYPE_LABEL]: string
  [key: string]: JSONValue
}

type PoolBackingObject = {
  get (ref: string): PoolObject | undefined
  set (ref: string, value: PoolObject): void
}

const arrayMap = <T, U> (arr: T[], fn: (item: T) => U) => Object.freeze(arr.map(fn))
const objectMap = <T, U> (obj: Record<string, T>, fn: (item: T) => U) => {
  const acc: Record<string, U> = {}
  for (const [key, value] of Object.entries(obj)) {
    acc[key] = fn(value)
  }
  return Object.freeze(acc)
}

const REF_LABEL = '__ref'
const TYPE_LABEL = '__type'

export class ObjectPool {
  private generation = 0
  private listeners = new Map<string, Set<(val: JSONObject) => void>>()

  constructor (private backing: PoolBackingObject = new Map) {}

  get time(): number {
    return this.generation
  }

  public identify (obj: JSONObject): string | undefined {
    const { id, [TYPE_LABEL]: type } = obj
    return (typeof id === 'string' || typeof id === 'number') && typeof type === 'string' ? `${type}:${id}` : undefined
  }

  public read = (ref: string): JSONValue => this.resolvePoolObject(ref, new Map())

  public write = (...items: JSONValue[]): void => {
    const visited = new Set<unknown>()
    const references = new Set<string>()

    for (const item of items) {
      this.updateValue(item, visited, references)
    }

    this.generation += 1
    this.notify(references)    
  }

  public observe = (ref: string): Signal => {
    const listener = () => {
      signal.value = this.read(ref) ?? null
    }
    const signal = new Signal(this.read(ref), {
      watched: () => {
        const listeners = this.listeners.get(ref) ?? new Set()
        this.listeners.set(ref, listeners)
        listeners.add(listener)
      },
      unwatched: () => {
        const listeners = this.listeners.get(ref)
        listeners?.delete(listener)
        if (listeners?.size === 0) {
          this.listeners.delete(ref)
        }
      }
    })

    return signal
  }

  private notify = (references: Set<string>): void => {
    const acc = new Map<string, JSONObject>()

    for (const ref of references) {
      const listeners = this.listeners.get(ref)
      if (listeners?.size) {
        // only resolve if there are listeners to avoid unnecessary computation
        const value = this.resolvePoolObject(ref, acc)
        // shouldn't really happen, but lets be safe
        if (value === null) {
          continue
        }
        for (const fn of listeners) {
          fn(value)
        }
      }
    }
  }

  private updateValue = (value: JSONValue, visited: Set<unknown>, references: Set<string>) => {
    if (value === null || typeof value !== 'object') {
      return value
    }

    if (visited.has(value)) {
      throw Error('Cyclic reference detected')
    }

    visited.add(value)
    
    if (Array.isArray(value)) {
      return arrayMap(value, item => this.updateValue(item, visited, references))
    }

    // Only returns a reference if the object has an id and type
    const ref = this.identify(value)

    return ref
      ? this.updatePoolObject(value as IndexableObject, ref, visited, references)
      : objectMap(value, item => this.updateValue(item, visited, references))
  }

  private updatePoolObject = (data: IndexableObject, ref: string, visited: Set<unknown>, references: Set<string>): PoolReference => {
    references.add(ref)

    const existing = this.backing.get(ref)

    const fields = Object.freeze({
      ...existing?.fields,
      ...objectMap(data, item => this.updateValue(item, visited, references))
    })

    const poolObject = Object.freeze({
      ...existing,
      updatedAt: this.time,
      fields
    })

    this.backing.set(ref, poolObject)

    return { [REF_LABEL]: ref }
  }

  private resolveValue = (value: PoolAny, stack: Map<string, JSONObject>): JSONValue => {
    if (typeof value !== 'object' || value === null) {
      return value
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, stack))
    }

    const ref = value[REF_LABEL]

    if (typeof ref === 'string') {
      const match = this.resolvePoolObject(ref, stack)

      if (match) {
        return match
      }
    }

    return objectMap(value, item => this.resolveValue(item, stack))
  }

  private resolvePoolObject = (ref: string, stack: Map<string, JSONObject>): JSONObject | null => {
    if (stack.has(ref)) {
      return stack.get(ref) ?? null
    }

    const poolObject = this.backing.get(ref)

    if (!poolObject) {
      return null
    }

    const acc = {}
    stack.set(ref, acc) // FIXME can make nested matching refs into circular references

    for (const [key, item] of Object.entries(poolObject.fields)) {
      acc[key] = this.resolveValue(item, stack)
    }

    return Object.freeze(acc)
  }
}