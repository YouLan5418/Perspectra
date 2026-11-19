type RequestOutcome = { kind: 'acknowledged' | 'unknown' | 'expired' | 'rejected'; reason?: string }

/** Uses only a reply tied to the original request. A 400 alone is not evidence of non-execution. */
export function actionReplyOutcome(
  method: string,
  reply?: { status?: string; feedback?: { message?: string } },
  failure?: { retryable?: boolean; message?: string },
): RequestOutcome {
  if (failure) {
    if (failure.retryable !== false) return { kind: 'unknown' }
    const message = failure.message
    if (
      (method === 'perform' && (message === '该操作不在玩家当前可用操作中' || message === '活动入口已失效，请刷新')) ||
      (method === 'regenerate' && message === '只能重新生成当前世界线的末端回合。') ||
      (method === 'selectCandidate' && message === '只能切换当前末端回合或候选。')
    )
      return { kind: 'expired', reason: '原选项已失效，请从当前可用选项重新选择。' }
    if ((method === 'speak' || method === 'perform') && message === '接收对象已不在当前可见场景，请重新选择')
      return { kind: 'rejected', reason: '接收对象已不在当前可见场景。请核对草稿和接收对象。' }
    if (method === 'perform' && message === '请选择当前可用的活动参与者')
      return { kind: 'rejected', reason: '原先选择的参与者已不符合当前条件，请重新选择。' }
    if (
      method === 'perform' &&
      (message === '此操作不接受参与者选择' || message === '此操作不接受参数' || message === '行动参数不在可填写范围内')
    )
      return { kind: 'rejected', reason: '这次填写的内容与当前选项不符，请重新核对。' }
    if (method === 'perform' && message === '请先恢复 NPC，或使用逃生按钮。')
      return { kind: 'rejected', reason: '当前已暂停。恢复后可以重新核对操作。' }
    return { kind: 'unknown' }
  }
  const message = reply?.feedback?.message
  if (
    (method === 'speak' || method === 'perform') &&
    reply?.status === 'paused' &&
    message === 'NPC 已暂停：这次输入没有提交。恢复后再试。'
  )
    return { kind: 'rejected', reason: '当前已暂停。恢复后可核对内容，再手动提交。' }
  if (
    method === 'speak' &&
    reply?.status === 'error' &&
    (message ===
      '模型把你的动作按与原文不符的顺序排列，这次输入没有提交。原文已保留；可以拆成“先表现、再移动”两句重试。' ||
      message === '模型返回的输入解释格式无效，这次输入没有提交。原文已保留；可以重试或拆成两句。' ||
      message === '模型服务暂时无法完成请求，这次输入没有提交。请检查服务可用性后重试；无需改写输入。')
  )
    return { kind: 'rejected', reason: '这次表达未能提交。草稿已保留，请核对后手动发送。' }
  if (
    (method === 'speak' || method === 'perform') &&
    message?.startsWith('玩家动作未成功：') &&
    message.includes('请以转录和当前场景为准。')
  )
    return { kind: 'rejected', reason: '游戏规则未执行这次操作。请核对当前可用选项。' }
  if (reply?.status === 'ready' || reply?.status === 'busy') return { kind: 'acknowledged' }
  return { kind: 'unknown' }
}
