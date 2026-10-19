import type { WorldJsonObject } from '@harness-world/contracts'
/** Fixed-cardinality application metrics. They report runtime outcomes but never affect authority. */
export class ApplicationRuntimeMetrics {
  #sessionDeliveryFailures = 0

  recordSessionDeliveryFailure(): void {
    this.#sessionDeliveryFailures += 1
  }

  snapshot(): WorldJsonObject {
    return {
      sessionDeliveryFailures: this.#sessionDeliveryFailures,
    }
  }
}
