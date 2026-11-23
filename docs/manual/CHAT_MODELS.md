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

## 先单独试一个模型(会花钱)

```
ANTHROPIC_API_KEY=... npm run chat:try -- claude-haiku-5-5 "今天好累啊"
```

打印回复、用了多少 token、花了多少美分。不写数据库。

## 关掉(总开关)

用运营人员的数据库账号连库(`DATABASE_URL`;账号要属于 `companion_admin`,数据库管理员账号也可以)。改动立刻对所有服务器生效,每次都连同原因和操作账号记进管理日志:

```
npm run chat:admin -- status
npm run chat:admin -- off all "原因"                       # 全部平台模型
npm run chat:admin -- off provider openai "原因"           # 某一家
npm run chat:admin -- off model anthropic/claude-opus-5-5 # 某一个
npm run chat:admin -- on all|provider X|model X
```

关掉后回复显示"平台模型暂时关闭",不扣额度,聊天记录照常能看。选了被关掉模型的家机,会自动改用默认模型回复;默认模型也被关掉时才显示"暂时关闭"。

名字要按清单里的写:厂商用 `providers` 里的名字(区分大小写),模型用"厂商/厂商那边的模型名"。写错了脚本会拒绝,并列出可用的名字。两点要知道:

- 开关看的是"哪家厂商、哪个模型名"。同一个模型经由另一家转发(例如经 OpenRouter 调 Claude),要另外关那一家。
- Claude 的 Opus、Sonnet 开了"拒答时自动换模型"(`fallbacks`),换上的模型由 Anthropic 决定,不受这里的模型开关管。如果监管要求某个模型绝对不能用,把对应条目的 `fallbacks` 关掉,或者直接关掉整个厂商。

## 免费额度

每个家机每个自然日(UTC)自动有一份:默认 200 次模型调用、1 美元(占位数值)。改:

```
npm run chat:admin -- quota 100 50 "原因"   # 每天 100 次、50 美分;从新建的额度开始生效
```

用完后回复显示"今天的额度用完了"。每次调用都记在算力账本里(回复:`OWNER_DIRECT_RESPONSE`;判断要不要开口:`CHAT_TURN_DECISION`)。token 数按实际记录;费用以美分记账,调用前按上限预占(向上取整),调用后按实际用量结算(四舍五入),所以很便宜的调用不会每次都扣掉 1 美分。厂商没报用量、调用失败或服务器中途停掉的,按预占的上限扣。
