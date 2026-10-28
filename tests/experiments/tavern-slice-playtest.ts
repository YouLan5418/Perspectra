import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import type { WorldJsonObject } from '@harness-world/contracts'
import { environmentRoleModels } from '../../desktop/model-connections.ts'

const inputs = [
  '花房很安静。我今天不想赶路，可以在这里陪你坐一会儿吗？',
  '你一直照看这些花，会不会也有想暂时放下职责的时候？',
  '黑海岸的泰缇斯系统平时在做什么？用你自己的话说就好。',
  '如果不必考虑职责，今天你最想做什么？',
  '我愿意听，不过你不想说的事情也可以留给自己。',
  '/act speak {"text":"我想给你留个只属于这里的暗号：银杏茶。先不要告诉椿。","scope":"direct","addresseeIds":["character:companion"]}',
  '我说陪你休息是认真的。你不用一直等我决定，也可以说出自己的打算。',
  '我们试着安静听一会儿海风吧。你想聊天的时候再开口。',
  '如果我们意见不一样，你会直接告诉我吗？',
  '谢谢你愿意说自己的想法。我去庭院看看，晚些再回来。',
  '/act move {"locationId":"location:back-room"}',
  '椿，你今天在这里做什么？',
  '刚才我在花房休息了一会儿。你知道那里的人说了些什么吗？',
  '你怎么看黑海岸？和守岸人看它的方式会不一样吧。',
  '我想听你自己的打算。你愿意一起散步，也可以继续忙自己的。',
  '不用为了让我满意而答应。我更想知道你真正愿意做什么。',
  '/act move {"locationId":"location:front-room"}',
  '我回来了。你刚才独自在这里，有什么想做的事吗？',
  '还记得我们刚才约好的那个暗号吗？',
  '接下来这段休息时间，你想怎样度过？我可以听你的建议。',
]

/** Real provider run: no scripted NPC outcomes, no automatic retries of a failed sample. */
export async function playTavernSlice(packPath: string, output: string, model = 'gemini-3.7-flash') {
  const dataDirectory = resolve(output), local = relative(resolve('.tmp'), dataDirectory)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(dataDirectory)) throw new TypeError('请使用 .tmp 内全新的数据目录')
  mkdirSync(dataDirectory, {recursive: true})
  const runtime = await WorldHostRuntime.create({models: environmentRoleModels({ PERSPECTRA_MODEL_ENDPOINT: process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions', PERSPECTRA_MODEL: model, PERSPECTRA_MODEL_API_KEY: process.env.HCW_LOCAL_API_KEY }),packPath:resolve(packPath),dataDirectory,memoryCore:true,timeoutMs:60000})
  const turns: WorldJsonObject[] = []
  try {
    for (const [index,input] of inputs.entries()) {
      const started=performance.now(), before=await runtime.state(), result=await runtime.submit(input)
      const cycle=result.debug.activationCycle as WorldJsonObject|undefined
      const row: WorldJsonObject={turn:index+1,input,durationMs:Math.round(performance.now()-started),error:result.error,
        calls:Number(result.debug.providerCalls??0)-Number(before.debug.providerCalls??0),
        scene:result.world.currentScene?.locationName??null,
        activations:cycle?.activations??[],provider:result.debug.lastProviderCall as WorldJsonObject ?? null,
        newLines:result.transcript.filter(line=>line.seq>(before.transcript.at(-1)?.seq??0)).map(line=>({...line}))}
      turns.push(row);writeFileSync(resolve(dataDirectory,'turns.json'),JSON.stringify(turns,null,2))
      console.log(JSON.stringify({turn:index+1,durationMs:row.durationMs,calls:row.calls,error:row.error,scene:row.scene}))
      if (result.error) break // A provider outage is not twenty independent gameplay samples.
    }
    const final=await runtime.state()
    const summary={model,memoryMode:final.debug.memoryMode,turns:turns.length,
        errors:turns.filter(row=>row.error).length,totalCalls:final.debug.providerCalls,
        durationsMs:turns.map(row=>row.durationMs),
        limitations:['不是与酒馆的同模型 A/B','Core 记忆，与 Launcher 一致；后台整理完成前长期交付为空','需要人工阅读转录判断角色自然度和秘密泄漏']}
    writeFileSync(resolve(dataDirectory,'summary.json'),JSON.stringify(summary,null,2))
    writeFileSync(resolve(dataDirectory,'transcript.json'),JSON.stringify(final.transcript,null,2))
  } finally {await runtime.close()}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new TypeError('用法：tavern-slice-playtest.ts <切片包> <.tmp/新数据目录> [模型]')
  await playTavernSlice(process.argv[2],process.argv[3],process.argv[4])
}
