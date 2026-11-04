// 增加世界规则的示例：一个上锁的房间，玩家和角色都进不去。
// 规则是同步的，同样的输入要给出同样的答案。结果仍由宿主提交，不直接写入世界。
export const hostApi = '2.0'

export default function lockedRoom(ctx, config) {
  const movesThere = action => action.actionType === 'move' && action.parameters?.locationId === config.locationId
  ctx.effect(() =>
    ctx.rules.register({
      id: 'locked-room',
      version: '0.1.0',
      open: async () => ({
        resolve: (context, next) =>
          movesThere(context.action)
            ? { status: 'rejected', events: [], reason: 'plugin:' + config.reason }
            : next(context),
        affordances: (context, next) =>
          next(context).map(affordance =>
            affordance.destinations
              ? {
                  ...affordance,
                  destinations: affordance.destinations.filter(place => place.locationId !== config.locationId),
                }
              : affordance,
          ),
      }),
    }),
  )
}
