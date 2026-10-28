/** Bounded, invalidation-aware memoization for provider catalog observations. */

/**
 * Cache complete provider catalogs and share work already running for one key.
 * Values remain borrowed and readonly; producers own their lifecycle cancellation.
 * @template T
 */
export class CatalogCache {
  #maxEntries
  #generation = 0
  /** @type {Map<string, T>} */
  #cache = new Map()
  /** @type {Map<string, Promise<T>>} */
  #inFlight = new Map()

  /**
   * @param {number} maxEntries Maximum completed catalogs retained in LRU order.
   */
  constructor(maxEntries) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer')
    }
    this.#maxEntries = maxEntries
  }

  /**
   * Read a complete cached observation or share the current producer for its key.
   * Incomplete observations and failures are returned without entering the cache.
   * @param {string} key Provider-owned identity for equivalent catalog lookups.
   * @param {() => T | PromiseLike<T>} producer Work using provider lifecycle cancellation.
   * @returns {Promise<T>} The borrowed observation or its producer failure.
   */
  read(key, producer) {
    const value = this.#cache.get(key)
    if (value !== undefined) {
      this.#cache.delete(key)
      this.#cache.set(key, value)
      return Promise.resolve(value)
    }
    const running = this.#inFlight.get(key)
    if (running !== undefined) return running

    const generation = this.#generation
    const pending = Promise.resolve().then(producer).then((value) => {
      if (generation === this.#generation && isCompleteCatalog(value)) {
        this.#cache.set(key, value)
        while (this.#cache.size > this.#maxEntries) {
          const oldest = this.#cache.keys().next()
          if (oldest.done) break
          this.#cache.delete(oldest.value)
        }
      }
      return value
    }).finally(() => {
      if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key)
    })
    this.#inFlight.set(key, pending)
    return pending
  }

  /** Invalidate retained observations without cancelling borrowed producer work. */
  clear() {
    this.#generation += 1
    this.#cache.clear()
    this.#inFlight.clear()
  }
}

/**
 * Whether a provider observation is eligible for reuse after completion.
 * @param {unknown} value Observation returned by the owned producer.
 */
function isCompleteCatalog(value) {
  return Array.isArray(value)
    || value !== null && typeof value === 'object'
      && 'candidates' in value && Array.isArray(value.candidates)
      && (!('complete' in value) || value.complete !== false)
}
