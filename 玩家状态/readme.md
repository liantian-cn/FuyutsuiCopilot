# 玩家状态

本文说明 Fuyutsui 除技能冷却和普通玩家光环以外，如何读取并传递玩家相关状态。这里的“玩家状态”主要指 `type = "block"` 写入顶部像素条、再被 Python 解码进 `state_dict` 的字段；技能冷却见 `技能冷却/readme.md`，玩家逻辑光环见 `玩家光环/readme.md`。

需要先明确两个结论：

- 当前源码没有读取“移动速度”的数值。它只通过 `IsPlayerMoving()` 输出“是否移动”。
- 当前源码没有把“坐骑状态”作为独立字段传给 Python。坐骑、死亡、聊天框打开、饮水都会影响 `有效性`。

## 总体链路

玩家状态不是 Python 直接调用游戏 API 读取的。完整链路是：

1. 插件端 `Fuyutsui/class/*.lua` 为当前职业/专精声明顶部像素里的状态块。
2. `Fuyutsui/main.lua` 的 `loadPlayerBlocks()` 把 `type = "block"` 整理成 `blocks.state[name] = index`。
3. `main.lua` 的各个 `updatePlayer*` / `updateTarget*` / `updateGroup*` 函数调用 WoW API 读取状态。
4. `Fuyutsui/core/block.lua` 的 `CreatTexture(index, value)` 把状态写到屏幕顶部像素。
5. `Fuyutsui/Fuyutsui/GetPixels.py` 用 `mss` 截取窗口顶部一行，解析像素的 G/B 通道。
6. `Fuyutsui/Fuyutsui/config.yml` 把像素 `step` 映射成中文字段。
7. `logic_gui.py` 每约 0.2 秒调用 `get_info()`，得到 `state_dict`，再交给职业逻辑。

像素编码规则仍是普通顶部状态条规则：

```lua
tex:SetColorTexture(0, index / 255, value, 1)
```

Python 端读取到的是：

- `G` 通道：字段索引，即 `step`。
- `B` 通道：字段值，0-255 的整数。

因此 Lua 里写 `1 / 255`，Python 读到 `1`；Lua 里写 `50 / 255`，Python 读到 `50`。

## 基础状态字段

这些字段在所有职业的 `ClassBlocks` 前 20 个位置中基本一致，也在 `config.yml` 顶层 `state:` 中统一配置。

| 字段 | 来源 | Python 含义 |
|---|---|---|
| `锚点` | 初始化时第 1 个像素为 RGB(0,1,0) | Python 扫描顶部行的起点，不是业务状态 |
| `职业` | `UnitClass("player")` 得到的 `classId` | 职业 ID，1-13 |
| `专精` | `C_SpecializationInfo.GetSpecialization()` | 专精序号，通常 1-4，不是 65/250 这类 specID |
| `有效性` | `not isDead and not mounted and not isChatOpen and not drinkStatus` | Python 主循环只有它为真才执行战斗逻辑 |
| `战斗` | `UnitAffectingCombat("player")` | 0/1 |
| `移动` | `IsPlayerMoving()` 事件结果 | 0/1，不是移动速度 |
| `施法` | `UnitCastingDuration("player")` | 施法已用时间，按 0-2.55 秒映射到 0-255 |
| `引导` | `UnitChannelDuration("player")` | 引导剩余时间，按 0-2.55 秒映射到 0-255 |
| `蓄力` | `UnitEmpoweredChannelDuration("player")` | 蓄力剩余时间，按 0-2.55 秒映射到 0-255 |
| `蓄力层数` | `UnitEmpoweredStageDurations("player")` | 当前蓄力阶段，写入 `k - 1` |
| `生命值` | `UnitHealthPercent("player", false, curve100)` | 血量百分比，通常 0-100 |
| `能量值` | `UnitPowerType` + `UnitPowerPercent` / `UnitPower` | 当前主资源，可能是百分比或小资源点数 |
| `一键辅助` | `C_AssistedCombat.GetNextCastSpell()` | 暴雪一键辅助推荐法术在 `spellsList` 中的索引 |
| `法术失败` | `UNIT_SPELLCAST_FAILED` + `spellsList[spellID].failed` | 最近失败法术索引，1.5 秒后清空 |
| `目标类型` | 目标敌友、距离、死亡、可驱散类型 | 0、1-3、11-15 |
| `队伍类型` | `UnitInRaid("player")` / `UnitInParty("player")` | 单人 0；小队 46；团队为玩家 raid index |
| `队伍人数` | `GetNumGroupMembers()` | 当前队伍/团队人数 |
| `首领战` | `ENCOUNTER_START/END` + `bossID` 映射 | 当前首领内部编号，非 encounterID 原值 |
| `难度` | encounter 事件的 `difficultyID` | 游戏难度 ID |
| `英雄天赋` | 遍历 `Fuyutsui.heroTalents` 的已知法术 | 英雄天赋内部编号 |

## 有效性如何计算

`有效性` 是 Python 主循环的闸门。`logic_gui.py` 中：

```python
if not sd or not sd.get("有效性"):
    _current_step = "等待游戏状态"
    continue
```

Lua 端计算方式是：

```lua
local valid = not state.isDead and not state.mounted and not state.isChatOpen and not state.drinkStatus
state.valid = valid and 1 / 255 or 0
```

影响 `有效性` 的内部状态如下：

| 内部状态 | 更新来源 | 说明 |
|---|---|---|
| `isDead` | `PLAYER_DEAD`、`PLAYER_ALIVE`、`PLAYER_UNGHOST`，以及初始化时 `UnitIsDeadOrGhost("player")` | 死亡或灵魂状态时无效 |
| `mounted` | `PLAYER_MOUNT_DISPLAY_CHANGED`、`UPDATE_SHAPESHIFT_FORM(S)`，以及初始化 | 使用 `IsMounted()`，并尝试把部分变形形态视为坐骑 |
| `isChatOpen` | hook 默认聊天框 `EditBox` 焦点 | 打开聊天输入时无效，避免误发按键 |
| `drinkStatus` | `UNIT_SPELLCAST_SUCCEEDED` 检查法术名“饮水”或“进食饮水” | 饮水后置 true，20 秒后清空；移动也会清空 |

注意当前源码里有一个细节：`updateShapeshiftForm()` 把 `state.shapeshiftFormID` 存成 `shapeshiftFormID / 255`，但 `updatePlayerMounted()` 又拿它和原始 ID `27`、`3`、`29` 比较。这意味着“通过变形形态判断坐骑”的分支很可能不起作用；普通坐骑仍由 `IsMounted()` 判断。

## 生命值

玩家血量由：

```lua
local healthPercent = UnitHealthPercent("player", false, curve100)
local _, _, b = healthPercent:GetRGB()
self:CreatTexture(blocks.state["生命值"], b)
```

`curve100` 把百分比映射到 B 通道，Python 读到的值通常就是 0-100 的整数百分比。`UNIT_HEALTH`、`UNIT_MAXHEALTH`、`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`、`UNIT_HEAL_PREDICTION` 都会触发玩家血量刷新。

这里读的是百分比，不是当前血量数值，也不是最大血量数值。Python 职业逻辑通常直接比较：

```python
if 生命值 < 30:
    ...
```

## 能量值和职业资源

通用 `能量值` 的刷新入口是：

```lua
local powerType = UnitPowerType("player")
self:CreatPowerCurve(powerType)
self:updatePlayerPower(powerType)
```

`CreatPowerCurve(powerType)` 会先读 `UnitPowerMax("player", EnumPowerType[powerType])`：

- 最大值大于等于 250：按 0-100 输出百分比，适合法力这类大资源。
- 最大值小于 250：按 0-`powerMax` 输出实际点数，适合能量、怒气等较小资源。

`updatePlayerPower(powerType)` 还有一个特殊资源分支：

```lua
local specialPowerMap = {
    ["COMBO_POINTS"] = "连击点",
    ["HOLY_POWER"] = "神圣能量",
    ["ESSENCE"] = "精华能量",
    ["SOUL_SHARDS"] = "灵魂碎片",
    ["CHI"] = "真气",
}
```

如果当前资源类型在这个表里，并且当前专精有对应 block，Lua 会把 `UnitPower()` 的原始点数写进这些字段。也就是说，Python 里可能同时看到：

- `能量值`：主资源的百分比或点数。
- `神圣能量` / `连击点` / `灵魂碎片` / `真气` / `精华能量`：特定职业资源点数。

这里还有一个分支细节：当前代码结构是 `if isSec(power) then ... elseif specialPower then ...`。也就是说，当 `UnitPower()` 返回受保护值时，会优先走 `UnitPowerPercent()` 的通用 `能量值` 分支；只有 `UnitPower()` 不是受保护值，并且资源类型在 `specialPowerMap` 中时，才会写入 `神圣能量`、`连击点` 等专用字段。

死亡骑士 `符文` 不走 `UnitPower`，而是每 0.2 秒汇总 6 个符文槽：

```lua
for i = 1, 6 do
    total = total + (GetRuneCount(i) or 0)
end
```

武僧酒仙的 `酒池` 也不是能量资源，而是：

```lua
local damage = UnitStagger("player")
local maxHealth = UnitHealthMax("player")
local staggerPercent = damage / maxHealth * 100
```

## 移动和移动速度

Fuyutsui 只注册了：

- `PLAYER_STARTED_MOVING`
- `PLAYER_STOPPED_MOVING`

对应写入：

```lua
state.moving = boolean and 1 / 255 or 0
self:CreatTexture(blocks.state["移动"], state.moving)
```

仓库中没有看到 `GetUnitSpeed("player")` 或等价速度读取。第三方逻辑如果需要区分走路、跑步、坐骑速度、减速效果，目前不能直接从现有 `state_dict` 得到，只能读到 `移动` 这个布尔值。

## 坐骑状态

坐骑状态只存在 Lua 内部：

```lua
state.mounted = IsMounted() or ...
self:updatePlayerValid()
```

当前 `config.yml` 没有 `坐骑` 字段，职业 `ClassBlocks` 也没有单独的 `坐骑` block。Python 只能间接通过 `有效性 == False` 推断“可能死亡、坐骑、聊天或饮水之一发生了”，不能区分是哪一种。

如果第三方 mod 需要 Python 直接知道坐骑状态，应新增一个 `type = "block", name = "坐骑"`，再在 `config.yml` 中加对应 `step`，否则不要把 `有效性` 当作坐骑字段使用。

## 施法、引导和蓄力

`施法`、`引导`、`蓄力` 都不是简单布尔值，而是时间值。它们使用同一个 `castCurve`：

```lua
local castCurve = Fuyutsui:creatColorCurve(2.55, 255)
```

这表示约 2.55 秒会映射到 raw_B 255，因此 Python 端的数值大致是“秒 * 100”，超过 2.55 秒会被钳制。常见用法是判断 `> 0`：

```python
if 引导 > 0:
    current_step = "在引导,不执行任何操作"
```

`施法技能` 和 `施法目标` 是部分治疗或读条职业额外声明的字段：

- `施法技能`：`UNIT_SPELLCAST_START` / `CHANNEL_START` / `EMPOWER_START` 时，把 `spellID` 映射到 `spellsList[spellID].index`。
- `施法目标`：`UNIT_SPELLCAST_SENT` 根据 `targetName` 在队伍表里找到目标，写入队伍序号。

注意当前 `UNIT_SPELLCAST_EMPOWER_STOP` 处理函数的条件疑似写反：它在 `unitTarget ~= "player"` 时清理玩家蓄力状态，而不是 `unitTarget == "player"`。如果游戏内蓄力状态出现残留，应优先检查这里。

## 目标相关状态

虽然本文主题是玩家状态，但 Fuyutsui 把目标状态也放进同一个 `state_dict`，因为职业逻辑需要它们做施法判断。

### 目标类型

`目标类型` 的含义写在 `main.lua` 注释中：

| 值 | 含义 |
|---|---|
| `0` | 没有目标、目标死亡、目标不在范围，或不可判定 |
| `1` | 敌方目标 |
| `2` | 敌方目标且有可进攻驱散的魔法增益 |
| `3` | 敌方目标且有可进攻驱散的激怒增益 |
| `11` | 友方目标 |
| `12` | 友方目标且有可驱散魔法减益 |
| `13` | 友方目标且有可驱散疾病减益 |
| `14` | 友方目标且有可驱散诅咒减益 |
| `15` | 友方目标且有可驱散中毒减益 |

敌方是否在范围内用 `self.state.specRange` 判断；友方目标按 40 码判断。`specRange` 来自 `Fuyutsui.rangeSpecID`，不是 Python 配置。

### 目标生命值和距离

`目标生命值` 使用 `UnitHealthPercent("target", false, curve100)`，和玩家血量一样是 0-100 的百分比。

`目标距离` 使用 `LibRangeCheck-3.0`：

```lua
local minRange, maxRange = rc:GetRange("target")
self:CreatTexture(blocks.state["目标距离"], maxRange / 255)
```

Python 读到的是 `maxRange` 的整数近似值，不是精确坐标距离。

### 敌人人数

`敌人人数` 来自姓名板列表。流程是：

1. `NAME_PLATE_UNIT_ADDED` 时记录 `nameplate[unit]`。
2. 每 0.2 秒遍历当前姓名板。
3. 对每个单位重新读取距离和战斗状态。
4. 只有 `canAttack`、`maxRange <= specRange`，并且目标在战斗中时才计数。

有两个例外：`testMap` 和 `testEncounter` 中的地图/战斗会放宽“必须在战斗中”的条件，当前源码里包括银月城和茂林古树。

## 队伍状态

`队伍类型` 和 `队伍人数` 是顶层字段。治疗逻辑还会读取 `state_dict["group"]` 子字典。

Lua 端 `updateGroup()` 会遍历队伍成员，记录：

- `index`
- `name`
- `GUID`
- `role`
- `isDead`
- `inRange`
- `canAttack`
- `canAssist`
- `inSight`
- 血量曲线相关字段
- 队伍光环表

写入像素时，每个队友占一段连续 block。Python 端按 `config.yml` 的 `group.start` 和 `group.num` 解析成：

```python
state_dict["group"]["1"]["生命值"]
state_dict["group"]["1"]["职责"]
state_dict["group"]["1"]["驱散"]
```

`职责` 的值来自 `roleMap`：

| 值 | 职责 |
|---|---|
| `0` | NONE |
| `1` | TANK |
| `2` | HEALER |
| `3` | DAMAGER |

队伍成员血量使用 `UnitHealthPercent(unit, false, obj.curve)`，并叠加 `inComingHeals` 和 `healAbsorb` 影响曲线。也就是说治疗逻辑读到的队友血量不是简单生命百分比，而是已经考虑了部分预估治疗和吸收修正后的显示值。

## 职业专精额外 block 字段

下面是当前 `Fuyutsui/class/*.lua` 中出现的所有 `type = "block"` 字段。这里不列 `type = "spell"` 的技能冷却，也不列 `type = "aura"` 的普通逻辑光环。

| 类别 | 字段 |
|---|---|
| 元信息 | `锚点`、`职业`、`专精` |
| 通用玩家状态 | `有效性`、`战斗`、`移动`、`施法`、`引导`、`蓄力`、`蓄力层数`、`生命值`、`能量值`、`一键辅助`、`法术失败` |
| 目标和环境 | `目标类型`、`目标生命值`、`目标距离`、`目标施法`、`目标引导`、`敌人人数`、`首领战`、`难度` |
| 队伍 | `队伍类型`、`队伍人数` |
| 职业资源 | `神圣能量`、`连击点`、`灵魂碎片`、`真气`、`精华能量`、`符文`、`酒池` |
| 形态和特殊判断 | `姿态`、`疾病判断`、`防御光环` |
| 用户开关 | `爆发开关`、`AOE开关`、`输出模式`、`爆发药水开关`、`延迟` |
| 物品状态 | `大红冷却`、`治疗石冷却`、`鲁莽药水冷却` |
| 英雄天赋 | `英雄天赋` |

源码的 `updateItemCoolDown()` 还支持 `大蓝冷却` 和 `圣光潜力冷却`，但当前职业 `ClassBlocks` 和 `config.yml` 中没有看到它们作为实际输出字段。

## 形态、姿态和坐骑的关系

`姿态` 来自：

```lua
local shapeshiftFormID = GetShapeshiftFormID() or 0
state.shapeshiftFormID = shapeshiftFormID / 255
self:CreatTexture(blocks.state["姿态"], state.shapeshiftFormID)
```

Python 读到的是原始 `shapeshiftFormID` 的整数值。当前主要由德鲁伊等有形态需求的专精配置。

`姿态` 和 `mounted` 是两件事：

- `姿态` 是可选输出字段，Python 可以直接读。
- `mounted` 是 Lua 内部有效性条件，Python 当前不能直接读。

## 配置开关状态

这些字段不是游戏 API，而是 Fuyutsui 自己的 `db.char` 配置：

| 字段 | 来源 | 常见用途 |
|---|---|---|
| `爆发开关` | `/fu cd` 或快速按钮切换 `c.cooldowns` | 是否自动使用爆发技能 |
| `AOE开关` | `/fu aoemode` 切换 `c.aoeMode` | 自动/单体或 AOE 策略 |
| `输出模式` | `/fu dpsmode` 切换 `c.dpsMode` | 一键辅助或手写逻辑 |
| `爆发药水开关` | `/fu potion` 切换 `c.potion` | 是否自动使用爆发药水 |
| `延迟` | `/fu delay [秒]` 临时置 `c.delay = 1` | 手动插入技能后短暂停止自动逻辑 |

`updatePlayerConfig()` 在初始化或专精切换后延迟 1 秒写这些值。单独切换某个选项时，对应的 `Switch*` 函数也会立即同步顶部像素。

## 物品状态为什么也算 block

`大红冷却`、`治疗石冷却`、`鲁莽药水冷却` 由 `updateItemCoolDown()` 写入 `blocks.state`，所以从 Lua 的分类看它们是普通玩家状态 block，不在 `blocks.spells` 中。

但 Python `config.yml` 里有些专精把物品冷却放在 `spells:` 子字典内，有些放在专精顶层。写逻辑时必须以当前 `config.yml` 为准：

- 在 `spells:` 里：用 `spells.get("大红冷却")`。
- 在专精顶层：用 `state_dict.get("大红冷却")`。

这类字段的详细冷却语义已经在 `技能冷却/readme.md` 中展开。

## 防御光环是特殊例外

`防御光环` 在恶魔猎手复仇专精里是 `type = "block"`，但它的数据来源是 WoW 的真实 Aura API：

```lua
C_UnitAuras.GetBuffDataByIndex(unit, i, "HELPFUL|BIG_DEFENSIVE")
C_UnitAuras.GetAuraDuration("player", state.DefensiveAuraInstanceID)
```

因此它不属于 `core/auras.lua` 的玩家逻辑光环系统，但本质上仍是一个真实光环剩余时间。本文把它列在 block 字段里，是因为它通过 `blocks.state["防御光环"]` 写入，而不是通过 `blocks.auras` 写入。

## Python 端的结构

`GetPixels.py` 生成的 `state_dict` 大致是：

```python
{
    "职业": 2,
    "专精": 1,
    "有效性": True,
    "生命值": 87,
    "能量值": 100,
    "目标类型": 12,
    "神圣能量": 3,
    "spells": {...},
    "group": {
        "1": {"生命值": 80, "职责": 1, "驱散": 0},
        "2": {"生命值": 95, "职责": 3, "驱散": 0},
    }
}
```

转换规则很简单：

- `type: "bool"`：`bool(int(raw))`
- `type: "int"`：`int(raw)`
- `spells:`：放到 `state_dict["spells"]`
- `group:`：按队伍 block 段落展开到 `state_dict["group"]`
- `step: bar`：从第二行 `countBars` 读取，不从顶部普通像素读取

所以新增第三方字段时要同时对齐三处：

1. Lua 职业文件里的 `ClassBlocks`。
2. Lua 更新函数是否真的写了 `blocks.state["字段名"]`。
3. Python `config.yml` 里的字段名和 `step`。

字段名只是手写接口，不会自动根据中文名字推导数据来源。

## 刷新频率

不同状态的刷新频率不同：

| 状态类型 | 刷新方式 |
|---|---|
| 施法、引导、蓄力、队伍血量、光环计算 | `OnUpdate()` 每帧 |
| 一键辅助、符文、目标距离、敌人人数、物品冷却、防御光环、技能冷却 | `OnUpdate()` 每 0.2 秒 |
| 血量、能量、移动、死亡、坐骑、队伍变化、目标变化、首领战 | 对应 WoW 事件触发 |
| Python `get_info()` | `logic_gui.py` 约每 0.2 秒 |

因此 Python 端看到的玩家状态通常会有 0-0.4 秒量级延迟。它不保存历史状态，也不做预测，每轮都是重新截图并重建 `state_dict`。

## 写 mod 时要注意

- 不要把 `有效性 == False` 直接解释成“上坐骑”；它也可能是死亡、聊天输入或饮水。
- 不要写依赖移动速度的逻辑，当前只有 `移动` 布尔值。
- `生命值` 和 `目标生命值` 是百分比，不是具体血量。
- `能量值` 的语义随资源上限变化：大资源更像百分比，小资源更像点数。
- `职业` 是职业 ID，`专精` 是专精序号；真正的 specID 只存在 Lua 内部。
- `目标距离` 是 LibRangeCheck 返回的 `maxRange`，不是坐标距离。
- `施法`、`引导`、`蓄力` 是时间值，通常用 `> 0` 判断状态。
- `施法技能` 依赖 `spellsList` 是否有对应 spellID；没有映射时输出 0。
- 职业 Lua 里有字段不代表 Python 一定能读到；必须同步 `config.yml`。
- Python `config.yml` 里有字段也不代表 Lua 一定会写；必须检查是否存在对应 `blocks.state["字段名"]` 更新路径。
