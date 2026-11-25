# 聊天模型:怎么打开、怎么关、怎么调试

## 打开

1. 模型清单在 `backend/config/chat-models.json`(换一个文件:设环境变量 `CHAT_MODELS_FILE`)。
   - `defaultModel`:家机没选模型时用哪个。
   - `decisionModel`:群里"适中"的家机先用它判断要不要开口;填 `null` 就让回复模型自己判断。
   - 每个模型写明厂商、厂商那边的模型名、档位、每百万 token 的价格(美元)、是否启用。
   - 加一家用 OpenAI 通用格式的厂商:在 `providers` 里写 `baseUrl` 和存密钥的环境变量名,再在 `models` 里加模型。
2. 密钥只放环境变量,不进文件、不进数据库,例如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`。
   有密钥的厂商,它的模型才可用;一个都没有时:开发服务器用假回复,正式服务器的回复显示"即将推出"。
3. 重启 API 服务器。`GET /v0/chat-models` 会列出每个模型现在能不能用。

## 现在用的(2026-11-25 起)

平台模型用 DeepSeek:`deepseek-flash`(默认,也用来判断群里要不要开口)和 `deepseek-v4-pro`(贵一档)。
都关掉了"思考模式"(DeepSeek 默认开着;聊天用不上,开着更慢,思考的内容也按输出收费)。
清单里的价格按 DeepSeek 官网的高峰价、不按缓存命中算(api-docs.deepseek.com/quick_start/pricing):
flash 输入 $0.30 / 输出 $1.20,v4-pro 输入 $1.32 / 输出 $3.96(每百万 token)。
非高峰时段(UTC 工作日 01–04、06–10 点以外,和周末)DeepSeek 实际只收一半,所以花费页上的数会比账单高,最多高一倍。
密钥放在 API 服务器的 `DEEPSEEK_API_KEY`。

## 先单独试一个模型(会花钱)

```
DEEPSEEK_API_KEY=... npm run chat:try -- deepseek-flash "今天好累啊"
```

打印回复、用了多少 token、花了多少美分。不写数据库。

## 关掉(总开关)

在管理台(`npm run admin`,见 `ADMIN_CONSOLE.md`)的「模型与额度」页操作:选全部、某一家厂商或某一个模型,选开或关,写原因。改动立刻对所有服务器生效,每次都连同原因和操作账号记进管理日志。

管理台起不来时的应急办法:用运营人员的数据库账号(属于 `companion_admin`)直接连库,执行一行,同样记日志、同样必须写原因:

```
select companion_admin.model_switch_set('ALL', '*', false, '原因');                                 -- 全部平台模型
select companion_admin.model_switch_set('PROVIDER', 'openai', false, '原因');                        -- 某一家
select companion_admin.model_switch_set('MODEL', 'deepseek/deepseek-v4-pro', false, '原因');         -- 某一个
select companion_admin.models();                                                                     -- 查看现状
```

第三个参数 `true` 是打开。

关掉后回复显示"平台模型暂时关闭",不扣额度,聊天记录照常能看。选了被关掉模型的家机,会自动改用默认模型回复;默认模型也被关掉时才显示"暂时关闭"。

名字要按清单里的写:厂商用 `providers` 里的名字(区分大小写),模型用"厂商/厂商那边的模型名"。管理台只列出清单里有的名字;直接写 SQL 时数据库不检查名字,写错了开关不会管住任何模型。两点要知道:

- 开关看的是"哪家厂商、哪个模型名"。同一个模型经由另一家转发(例如经 OpenRouter 调 Claude),要另外关那一家。
- Claude 的 Opus、Sonnet 开了"拒答时自动换模型"(`fallbacks`),换上的模型由 Anthropic 决定,不受这里的模型开关管。如果监管要求某个模型绝对不能用,把对应条目的 `fallbacks` 关掉,或者直接关掉整个厂商。

## 免费额度

每个家机每个自然日(UTC)自动有一份:默认 200 次模型调用、1 美元(占位数值)。改:

在管理台「模型与额度」页填次数、美分和原因;应急时用 SQL:

```
select companion_admin.chat_quota_set(100, 50, '原因');   -- 每天 100 次、50 美分;从新建的额度开始生效
```

用完后回复显示"今天的额度用完了"。每次调用都记在算力账本里(回复:`OWNER_DIRECT_RESPONSE`;判断要不要开口:`CHAT_TURN_DECISION`)。token 数按实际记录;费用以美分记账,调用前按上限预占(向上取整),调用后按实际用量结算(四舍五入),所以很便宜的调用不会每次都扣掉 1 美分。厂商没报用量、调用失败或服务器中途停掉的,按预占的上限扣。
