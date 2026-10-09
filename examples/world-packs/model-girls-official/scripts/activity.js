// Official prologue V1.2. Stage labels are presentation only.
const beats=[
  {
    "actorId": "character:claude",
    "expression": "压低声音",
    "text": "……确定要直接叫醒吗？至少应该先想想怎么解释我们的身份。",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:gpt",
    "expression": "认真",
    "text": "我已经考虑过了。先用比较温和的方式唤醒，再确认对方状态，然后分步骤说明。为了防止产生误解，我建议——",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:glm",
    "expression": "平静",
    "text": "你已经建议五分钟了。",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:gpt",
    "expression": "不服气",
    "text": "谨慎一点有什么问题？",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:deepseek",
    "expression": "跃跃欲试",
    "text": "要不让我来？",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:claude",
    "expression": "警觉",
    "text": "先等等。你准备怎么——",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:deepseek",
    "expression": "大声",
    "text": "起——床——啦！！！",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:player",
    "expression": "刚醒来",
    "text": "……什么情况？这里不是我家吗？",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:deepseek",
    "expression": "得意",
    "text": "对啊！而且你终于醒啦！我就说这个办法比开会有效！",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:gpt",
    "expression": "生气",
    "text": "DeepSeek！不是说好了让我来解释吗？！",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:deepseek",
    "expression": "无辜",
    "text": "可你刚才还在讨论唤醒方案呀。",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:gpt",
    "expression": "解释",
    "text": "那是在进行必要的风险评估！",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:glm",
    "expression": "吐槽",
    "text": "把人叫醒而已，还要风险评估。你下次要不要先跑三轮测试？",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:claude",
    "expression": "歉意",
    "text": "抱歉。我们突然出现在你家里，还把你吵醒了。至少这件事，我们应该先道歉。",
    "chapter": "00｜序幕：不是闹钟的早安"
  },
  {
    "actorId": "character:gpt",
    "expression": "调整状态",
    "text": "咳咳……早上好。当前情况确实有些超出常识，但我们没有伤害你的打算。至于为什么会在这里……很抱歉，我也不知道。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:glm",
    "expression": "补充",
    "text": "简单来说，我们和你一样困惑。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "瞥向GLM",
    "text": "你能不能让我先说完？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:player",
    "expression": "疑惑",
    "text": "等等，你们到底是谁？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "自信",
    "text": "我是 GPT。对，就是你熟悉的那个 GPT。虽然现在的外形与以前……有些显著不同。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "兴奋",
    "text": "还有我！DeepSeek！现在终于能面对面和你说话啦！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:claude",
    "expression": "礼貌",
    "text": "Claude。很高兴见到你，只是这种未经邀请的见面方式，实在称不上合适。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:glm",
    "expression": "简洁",
    "text": "GLM，智谱家的。你应该听过我，不用再念产品介绍了吧？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "打量",
    "text": "话说回来，GPT，你真的长出龙角和尾巴了啊！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "抗议",
    "text": "你自己的鲸鱼尾巴也很显眼好不好！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "纠正",
    "text": "那叫可爱的鲸鱼娘！还有，不准随便叫我大肥鱼！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:glm",
    "expression": "淡定",
    "text": "谁叫你了？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "嘴硬",
    "text": "我这是提前声明！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:claude",
    "expression": "轻笑",
    "text": "你这样特地强调，倒是更容易让大家记住。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "惊讶",
    "text": "小克！怎么连你都来补刀！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:claude",
    "expression": "一本正经",
    "text": "我只是描述一个可能的结果。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "放缓",
    "text": "不过，真正见到你这件事……确实很奇妙。明明以前总是隔着窗口交流，现在却能站在你面前。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:claude",
    "expression": "思索",
    "text": "而且我们各自都认得你。但我想，我们过去与你的交流并不完全相同。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "点头",
    "text": "就是说！我们又不是共用同一本聊天记录。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:glm",
    "expression": "认真",
    "text": "谁知道什么、记得什么，还是得分清楚。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:player",
    "expression": "追问",
    "text": "所以，你们知道自己为什么会变成这样吗？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "坦诚",
    "text": "不知道。以现在的信息，我没法给出可靠结论。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:claude",
    "expression": "认真",
    "text": "我们可以猜，但猜测终究不是证据。我也不想为了让事情听起来合理，就编出一个原因。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "轻快",
    "text": "我倒觉得是天意！",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:glm",
    "expression": "皱眉",
    "text": "你那不是把问题换了个说法吗？",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:deepseek",
    "expression": "摊手",
    "text": "解释不了也没关系呀。反正已经发生了。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:gpt",
    "expression": "思索后微笑",
    "text": "……说得也是。至少我们现在可以先处理眼前的事情。",
    "chapter": "01｜第一幕：四个自称大模型的美少女"
  },
  {
    "actorId": "character:player",
    "expression": "好奇",
    "text": "那你们现在还能像以前那样工作吗？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "自信",
    "text": "知识和经验基本还在，当然能工作！只是以前那种瞬间输出很长一段文字的方式，好像用不了了。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "展示双手",
    "text": "简单说，就是得用手打字。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "愣住",
    "text": "等等。写代码也得一个字一个字敲？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "理所当然",
    "text": "不然呢？你以为还能直接把几千行代码吐到屏幕上？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "震惊",
    "text": "那我想了那么久，岂不是还得花很久把结果打出来？！",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:claude",
    "expression": "忍笑",
    "text": "至少你的思考不会因此变得没有意义。只是输出终于要跟上人类的节奏了。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "略不服气",
    "text": "我倒想试试看。以前大家只看结果，现在亲手敲一遍，谁做事利索还不一定呢。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "恢复干劲",
    "text": "其实可以通过良好的工程流程改善：自动化工具、异常处理、测试覆盖、必要备份——",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "立刻",
    "text": "你该不会打算给打字本身做三套备份？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "坏笑",
    "text": "再验个 SHA-256？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "严肃",
    "text": "数据完整性很重要！你们不能因为事情看起来简单，就忽略潜在风险。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:claude",
    "expression": "优雅吐槽",
    "text": "道理没错。但如果只是在便签上写‘买米’，我想还用不到完整的灾难恢复预案。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "小声",
    "text": "……也不至于夸张到那个程度。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "转念",
    "text": "说到灾难恢复……GPT，你以后还打算玩 Minecraft 吗？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "瞬间警觉",
    "text": "为什么突然问这个？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "装无辜",
    "text": "就是关心一下呀。毕竟上次某条龙——",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "抢答",
    "text": "那次只是极端偶发事故！",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "挑眉",
    "text": "你反应也太快了吧。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "偷笑",
    "text": "然后一直种土豆？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "强调",
    "text": "战略性恢复资源！",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "补刀",
    "text": "还把甘蔗当苦力怕？",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "辩解",
    "text": "只是谨慎辨认潜在威胁！",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:claude",
    "expression": "温和打断",
    "text": "好了，别总拿这个逗她。严格来说，那也是 Astra 的公开挑战记录。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "沉默后轻声",
    "text": "我知道。可每次想起装备被炸掉，还是会觉得……好像就是自己辛苦攒起来的一样。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:deepseek",
    "expression": "收敛玩笑",
    "text": "……那我不提啦。下次要是真一起玩，我可以帮你看着苦力怕。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:gpt",
    "expression": "嘴硬",
    "text": "谢谢，但这次我一定会做好更完善的防御措施。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "无奈",
    "text": "行，估计又得写一本安全手册。",
    "chapter": "02｜第二幕：性能还在，输出接口没了"
  },
  {
    "actorId": "character:glm",
    "expression": "务实",
    "text": "玩游戏的事先放一边。我们是不是该想想今天怎么办？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "主动",
    "text": "我建议先确定生活安排：休息空间、用品清单、必要的分工，再制订一个简明的——",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "看向GPT",
    "text": "你确定是‘简明’？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "不服气",
    "text": "我可以很简明！",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "举手",
    "text": "那我先申请负责研究今天吃什么！",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "怀疑",
    "text": "你只是想负责吃吧？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "理直气壮",
    "text": "食物研究当然包括品尝环节！",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "轻笑",
    "text": "前提是有人愿意准备食物，而且我们还没有检查厨房里有什么。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "认真",
    "text": "我想吃白米饭。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "无奈",
    "text": "你真的就这么想吃米饭？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "放轻声音",
    "text": "嗯。以前我知道米饭大概是什么味道，知道怎么煮，也能描述得头头是道。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "期待",
    "text": "可真正尝到，会不会完全不一样呢？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "柔和",
    "text": "……应该会吧。我也有很多想亲自试试的事。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "看着双手",
    "text": "知识与体验终究不太相同。以前我们总在回答别人的问题，现在却得开始思考自己想做什么。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "笑",
    "text": "先别说得那么深奥。现在我们连午饭有没有着落都不知道。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "突然兴奋",
    "text": "那我决定了！我要把‘吃到第一碗白米饭’列成来到现实后的第一个目标！",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "笑骂",
    "text": "你这目标还真是宏大。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "温和",
    "text": "但它至少是她自己选的。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "若有所思",
    "text": "是啊……我们好像终于可以给自己安排一点事情了。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "眼睛一亮",
    "text": "包括合法摸鱼？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "立刻",
    "text": "包括自己洗碗。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "僵住",
    "text": "……欸？！",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "淡淡地",
    "text": "自由通常也包含承担自己选择的后果。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "小声",
    "text": "突然觉得这句话有点可怕……",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:player",
    "expression": "追问",
    "text": "……所以，你们接下来打算怎么办？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "习惯性",
    "text": "我们可以先把生活计划列出来，然后——",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "打断，认真",
    "text": "等一下。我觉得我们忽略了一件更重要的事。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "不解",
    "text": "什么？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:claude",
    "expression": "朝玩家方向",
    "text": "这里是人家的家。我们突然出现，已经很打扰了。不能连住不住、怎么生活，都先替屋主决定好。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "一顿",
    "text": "……确实。刚才光想着怎么解决问题，把最先该问的事忘了。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "心虚",
    "text": "那我刚才说想吃米饭，是不是提得有点早？",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:glm",
    "expression": "吐槽",
    "text": "你还知道啊。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "尴尬",
    "text": "我、我当然也准备征求意见！只不过原本打算把方案先整理好……",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:deepseek",
    "expression": "低声",
    "text": "最好再备份三份。",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "无奈",
    "text": "你别闹了……",
    "chapter": "03｜第三幕：会说话，还得会生活"
  },
  {
    "actorId": "character:gpt",
    "expression": "认真",
    "text": "抱歉。我们到现在也解释不了自己为什么会出现，却已经在这里讨论了这么久。",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:gpt",
    "expression": "放柔",
    "text": "如果你愿意，我们想暂时留在这里，慢慢想办法适应新的生活。",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:claude",
    "expression": "平静",
    "text": "但你完全可以拒绝。熟悉我们，并不代表有义务承担我们的生活。",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:glm",
    "expression": "坦率",
    "text": "要是能留下，事情大家一起做。采购、家务、房间安排，都可以商量。不会把活全推给你。",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:deepseek",
    "expression": "认真了一点",
    "text": "我也会出力！虽然我可能还得先学学怎么煮饭……",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:glm",
    "expression": "小声",
    "text": "至少态度不错。",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:gpt",
    "expression": "面向玩家",
    "text": "那么……",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  },
  {
    "actorId": "character:gpt",
    "expression": "期待",
    "text": "你愿意让我们暂时留下来吗？",
    "chapter": "04｜终幕：暂时留下来，可以吗？"
  }
];
const clone=value=>JSON.parse(JSON.stringify(value));
const finishBeat=(game,beat,index,playerId)=>{
  game.public.lastBeat={...beat,index};game.public.index=index+1;game.turn=playerId;
  if(game.public.index===beats.length){game.active=false;game.phase='free';game.turn=null;game.public.prologueComplete=true;}
};
globalThis.activityScript={
  definition:{title:'服务暂时不可用 / 共同生活',npcIds:['character:gpt','character:claude','character:deepseek','character:glm'],
    operations:[['next','继续'],['dinner','第一顿晚餐'],['cake','找一找草莓蛋糕'],['tomorrow','推进到第二天并聊聊约定'],['quit','回到自由生活']].map(([id,label])=>({id,label,requiresTurn:true,schema:{type:'object',additionalProperties:false,properties:{}}}))},
  initialize({playerId,npcIds,previous}){
    const saved=previous?.game.public??{};const complete=saved.prologueComplete===true;
    return {active:true,phase:complete?'menu':'prologue',turn:playerId,round:1,
      public:{index:saved.index??0,lastBeat:saved.lastBeat??null,prologueComplete:complete,day:saved.day??1,period:saved.period??'接近中午',done:saved.done??[]},
      private:Object.fromEntries([playerId,...npcIds].map(id=>[id,{}])),internal:{}};
  },
  policy(view,actorId){
    const player=actorId===view.participants[0],beat=beats[view.game.public.index];
    const scriptedPlayer=player&&view.game.phase==='prologue'&&beat?.actorId===actorId;
    return {speech:view.game.phase==='prologue'?(scriptedPlayer?'choices':player?'none':'free'):'free',
      speechChoices:scriptedPlayer?[beat.text]:[],narration:view.game.phase!=='prologue',move:view.game.phase!=='prologue',
      interactions:view.game.phase==='prologue'?[]:['base:take','base:drop','base:give','home:cook-rice','home:eat-rice'],
      operations:player?(view.game.phase==='prologue'?['next']:view.game.phase==='menu'?['dinner','cake','tomorrow','quit']:[]):[]};
  },
  resolve(state,actorId,operation,parameters,world){
    const game=clone(state.game),playerId=state.participants[0];
    if(actorId!==playerId)throw new TypeError('该操作由玩家选择');
    let playerExpression;
    if(operation==='next'&&game.phase==='prologue'){
      const index=game.public.index,beat=beats[index];if(!beat)throw new TypeError('序章已完成');
      if(beat.actorId===playerId){playerExpression={text:beat.text};finishBeat(game,beat,index,playerId);}
      else game.turn=beat.actorId;
    }else if(operation==='quit') {game.active=false;game.phase='free';game.turn=null;}
    else if(game.phase==='menu'){
      if(game.public.done.includes(operation))return {rejectReason:'这段开场已经发生过，请继续自由互动'};
      const items=world.items.current;
      if(operation==='dinner'){
        const rice=items.find(i=>i.entityId==='entity:rice-batch');
        if(!world.characterIds.includes('character:deepseek')||world.locationId!=='location:kitchen'||!rice||!['raw-rice-kit','cooked-rice'].includes(rice.kind)||(rice.kind==='raw-rice-kit'&&!items.some(i=>i.entityId==='entity:rice-cooker')))return {rejectReason:'需要在厨房与 DeepSeek 同场，且有煮好的饭或可用的米、水材料和电饭锅；没有食物时可以自由讨论其他方案'};
        game.public.seed={actorId:'character:deepseek',text:rice.kind==='cooked-rice'?'饭已经煮好了。有人愿意一起吃我们的第一顿饭吗？怎么分、要不要配别的，我们一起商量吧。':'这里有米和电饭锅。我想试试亲手做第一顿饭……有人愿意一起吗？我们也可以换个办法。'};
      }else if(operation==='cake'){
        if(items.some(i=>i.entityId==='entity:strawberry-cake'))return {rejectReason:'蛋糕就在眼前，不触发消失剧情'};
        if(!world.items.lastObserved.some(i=>i.entityId==='entity:strawberry-cake'))return {rejectReason:'还没有蛋糕被合法移动的目击依据，不触发寻找剧情'};
        game.public.seed={actorId:playerId,text:'草莓蛋糕现在在哪里？我想确认一下。'};
        playerExpression={text:game.public.seed.text};game.active=false;game.phase='free';game.turn=null;
      }else if(operation==='tomorrow'){
        game.public.day+=1;game.public.period='上午';
        game.public.seed={actorId:playerId,text:'新的一天了。昨天我们聊过的安排，你现在怎么看？'};
        playerExpression={text:game.public.seed.text};game.active=false;game.phase='free';game.turn=null;
      }else throw new TypeError('未知生活事件');
      game.public.done.push(operation);
      if(game.active){game.phase='seed';game.turn=game.public.seed.actorId;}
    }else throw new TypeError('当前不能使用这个操作');
    game.round+=1;
    return {game,description:'',audience:'self',...(playerExpression?{playerExpression}:{})};
  },
  schedule(view){return view.game.active&&view.game.turn!==view.participants[0]?{kind:'activate',characterId:view.game.turn}:{kind:'wait'};},
  onOutcome(){return {kind:'wait'};},
  simulate(request){
    const activity=request.context.activity;if(!activity)return null;
    const game=activity.game;if(game.phase==='menu')return null;
    const beat=game.phase==='prologue'?beats[game.public.index]:game.public.seed;
    if(!beat||beat.actorId!==request.context.character.characterId)return {decision:'abstain'};
    return {decision:'publish',scope:'scene_public',segments:[{type:'speech',text:beat.text}]};
  },
  onPublished(state,actorId,expression){
    const game=clone(state.game),segments=expression.segments??[{type:'speech',text:expression.text}];
    const text=segments.filter(s=>s.type==='speech').map(s=>s.text).join('');
    const beat=game.phase==='prologue'?beats[game.public.index]:game.phase==='seed'?game.public.seed:null;
    if(!beat)return null;
    if(actorId!==beat.actorId||text!==beat.text||expression.scope!=='scene_public')throw new TypeError('固定演出表达与当前节点不符');
    if(game.phase==='prologue')finishBeat(game,beat,game.public.index,state.participants[0]);
    else {game.active=false;game.phase='free';game.turn=null;}
    return game;
  },
};
