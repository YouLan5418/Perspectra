import type { PlayerView } from './player-view.ts'

/** Status actions have a correlated reply after adjudication. The Host can replace its routine
 * receipt with the generic cycle-completion notice. Only a correlated reply identifies a new receipt. */
export function createSuccessFeedback() {
  type ReceiptView = Pick<PlayerView, 'status' | 'feedback' | 'history'>
  let receipt: { id: string; tail: string; text: string; ownedByCheck: boolean } | undefined
  const announced = new Set<string>()

  return {
    isRoutineCompletion(view: ReceiptView | undefined) {
      return (
        view?.status === 'ready' &&
        (view.feedback?.message === '状态操作已提交。' ||
          view.feedback?.message === '本轮角色处理已结束，可以继续行动；角色也可以选择不回应。')
      )
    },
    clear() {
      receipt = undefined
    },
    bind(request: { actionId: string; statusOperation?: boolean }, reply: ReceiptView, ownedByCheck: boolean) {
      if (!request.statusOperation || !this.isRoutineCompletion(reply)) return
      const last = reply.history.findLast(line => !line.pause)
      receipt = {
        id: request.actionId,
        tail: last ? JSON.stringify(last) : '',
        text: '操作已提交。',
        ownedByCheck,
      }
    },
    read(view: ReceiptView | undefined, unread: boolean) {
      if (!this.isRoutineCompletion(view) || unread) return null
      if (!receipt) return { id: '', text: view!.feedback!.message }
      // This is a presentation boundary, never used to infer which lines were caused by the receipt.
      if (receipt.tail && !view!.history.some(line => JSON.stringify(line) === receipt!.tail)) return null
      if (receipt.ownedByCheck) return null
      return { id: receipt.id, text: receipt.text }
    },
    announce(id: string) {
      if (!id || announced.has(id)) return false
      announced.add(id)
      return true
    },
  }
}
