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
| `移动` | `IsPlayerMoving()` 初始值, 由 PLAYER_STARTED_MOVING/PLAYER_STOPPED_MOVING 事件刷新 | 0/1，不是移动速度 |
| `施法` | `UnitCastingDuration("player")` | 施法已用时间，按 0-2.55 秒映射到 0-255 |
| `引导` | `UnitChannelDuration("player")` | 引导剩余时间，按 0-2.55 秒映射到 0-255 |
| `蓄力` | `UnitEmpoweredChannelDuration("player")` | 蓄力剩余时间，按 0-2.55 秒映射到 0-255 |
| `蓄力层数` | `UnitEmpoweredStageDurations("player")` | 当前蓄力阶段，写入 `k - 1` |
| `生命值` | `UnitHealthPercent("player", false, curve100)` | 血量百分比，通常 0-100 |
| `能量值` | `UnitPowerType` + `UnitPowerPercent` / `UnitPower` | 当前主资源，可能是百分比或小资源点数 |
| `一键辅助` | `C_AssistedCombat.GetNextCastSpell()` | 暴雪一键辅助推荐法术在 `spellsList` 中的索引 |
| `法术失败` | `UNIT_SPELLCAST_FAILED` + `isUsable` + `spellsList[spellID].failed` | 最近失败法术索引，1.5 秒后清空 |
| `目标类型` | 目标敌友、距离、死亡、可驱散类型 | 0、1-3、11-15 |
| `队伍类型` | `UnitInRaid("player")` / `UnitInParty("player")`（46 为硬编码哨兵值，非 API 返回值） | 单人 0；小队 46；团队为玩家 raid index |
| `队伍人数` | `GetNumGroupMembers()` | 当前队伍/团队人数 |
| `首领战` | `ENCOUNTER_START/END` + `bossID` 映射 | 当前首领内部编号，非 encounterID 原值 |
| `难度` | encounter 事件的 `difficultyID` | 游戏难度 ID |
| `英雄天赋` | 遍历 `Fuyutsui.heroTalents` 的已知法术 | 英雄天赋内部编号 |

> 注意 `updateSpellFailed()` 写入法术失败像素前还需满足 `isUsable = true`（即 `C_Spell.IsSpellUsable()` 返回可用）。当技能处于冷却中（`IsSpellUsable()` 返回 false）时，即使收到 `UNIT_SPELLCAST_FAILED` 事件，法术失败像素也不会写入。

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
| `drinkStatus` | `UNIT_SPELLCAST_SUCCEEDED` 检查法术名”饮水”或”进食饮水” | 饮水后置 true，20 秒后清空；移动也会清空（注意：法术名称为中文客户端本地化值；英文客户端分别为 “Refreshment” 和 “Food and Drink”，此比较在非中文客户端永不为真。） |

注意 `updateDrinkStatus()` 的 else 分支会在法术名不是”饮水”或”进食饮水”时立即将 `drinkStatus` 置 false 并取消已有计时器。由于 `UNIT_SPELLCAST_SUCCEEDED` 对每次玩家成功施法都调用 `updateDrinkStatus(spellID)`，任何非饮水法术（包括战斗中的输出技能）都会立即清空 `drinkStatus`，实际窗口期远短于 20 秒。

由于 `C_Spell.GetSpellName` 返回客户端本地化的法术名称，此 drinkStatus 检测机制仅在 zhCN/zhTW 客户端有效。跨语言 mod 应用 spellID 直接检测或检查客户端区域。

注意当前源码里有一个细节：`updateShapeshiftForm()` 把 `state.shapeshiftFormID` 存成 `shapeshiftFormID / 255`，但 `updatePlayerMounted()` 又拿它和原始 ID `27`、`3`、`29` 比较。这意味着“通过变形形态判断坐骑”的分支很可能不起作用；普通坐骑仍由 `IsMounted()` 判断。

## 生命值

玩家血量由：

```lua
local healthPercent = UnitHealthPercent("player", false, curve100)
local _, _, b = healthPercent:GetRGB()
self:CreatTexture(blocks.state["生命值"], b)
```

`curve100` 把百分比映射到 B 通道，Python 读到的值通常是 1-100 的整数百分比（0% 生命值时 curve100 有两个控制点重叠于 t=0，第二个点的 B=1/255 覆盖了第一个点的 B=0，因此 Python 读到的是 1 而非 0）。`UNIT_HEALTH`、`UNIT_MAXHEALTH`、`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`、`UNIT_HEAL_PREDICTION` 都会触发玩家血量刷新。

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
- EnumPowerType 映射表定义在 Fuyutsui/core/config.lua 第 766-787 行：MANA=0、RAGE=1、FOCUS=2、ENERGY=3、COMBO_POINTS=4、RUNES=5、RUNIC_POWER=6、SOUL_SHARDS=7、LUNAR_POWER=8、HOLY_POWER=9、MAELSTROM=11、CHI=12、INSANITY=13、BURNING_EMBERS=14、DEMONIC_FURY=15、ARCANE_CHARGES=16、FURY=17、PAIN=17（注：PAIN 与 FURY 共享 ID 17）、ESSENCE=19、SHADOW_ORBS=28。
- `CreatPowerCurve(powerType)` 有永久缓存机制：首次为某资源类型创建曲线后缓存于 `powerCurve[powerType]`，后续调用直接返回缓存（main.lua 第 54 行 `if powerCurve[powerType] then return end`）。这意味着曲线在运行期间不会因资源最大值变化（如专精切换、等级提升）而更新。

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

如果当前资源类型在这个表里，并且当前专精有对应 block，Lua 会把 `UnitPower()` 的原始点数写进这些字段。

当前实现有一个容易误解的分支细节：`updatePlayerPower(powerType)` 不是无条件同时写 `能量值` 和职业专用资源，而是：

- 当 `UnitPower()` 返回受保护值时，走 `UnitPowerPercent()`，写通用 `能量值`。
- 当 `UnitPower()` 不是受保护值，并且资源类型在 `specialPowerMap` 中时，写 `神圣能量`、`连击点`、`灵魂碎片`、`真气`、`精华能量` 等专用字段。
- 当 `UnitPower()` 不是受保护值，并且资源类型不在 `specialPowerMap` 中时，当前源码没有在这个函数里写 `能量值`。

因此写 Python 逻辑时不要假设同一轮截图里 `能量值` 和专用资源字段一定同时刷新。某些专精应优先读取自己的专用资源字段；只有需要通用主资源时再读 `能量值`。

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

## 受保护值(isSec)对事件链的影响

`isSec` / `isSecretValue` 是魔兽世界 API，用于判断某值（spellID、targetName、GUID、power 等）是否属于受保护内容。在大秘境、评级 PvP 等受保护场景中，部分 API 返回值会被隐藏，通过 `isSec` 检查可以避免依赖不可靠的数据。

当前源码中 `isSec` 在以下位置影响事件处理：

| 事件 | 函数 | isSec 检查目标 | 行为差异 |
|---|---|---|---|
| `UNIT_SPELLCAST_SUCCEEDED` | `updateDrinkStatus()` | `isSec(spellID)` | 若 spellID 受保护，跳过 `updateDrinkStatus`、`updateFailedSpellBySuccess`、`updateAuraBySuccess`，整个回调直接 return |
| `UNIT_SPELLCAST_FAILED` | `updateSpellFailed()` | `isSec(spellID)` | 若 spellID 受保护，跳过 `updateSpellFailed`，不记录法术失败 |
| `UNIT_SPELLCAST_SENT` | 事件处理器 | `isSec(targetName)` | 若目标名受保护，阻止设置 `state.castTargetIndex`/`castTargetName`/`castTargetUnit` |

在大秘境或评级 PvP 等受保护内容中运行 mod 时，这些拦截的具体影响包括：

- `updateDrinkStatus` 被跳过 -> 饮水状态无法更新（不置 true 也不置 false），`有效性` 的饮水判断可能基于过期数据。
- `updateFailedSpellBySuccess` 被跳过 -> 成功施法无法清除之前的法术失败记录。
- `updateAuraBySuccess` 被跳过 -> 成功施法无法触发光环更新。
- `updateSpellFailed` 被跳过 -> 法术失败像素不会写入，`法术失败` 字段停留在旧值或 0。
- `castTargetIndex`/`castTargetName`/`castTargetUnit` 不被设置 -> 施法目标追踪在大秘境中不可用。

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

## Lua 内部但未直接输出的玩家状态

`Fuyutsui.state` 里还保存了一批玩家状态，但它们不一定会进入 Python 的 `state_dict`。判断一个字段是否能被 Python 读取，必须看它有没有对应 `blocks.state["字段名"]` 写入路径和 `config.yml` 配置。

| 内部字段 | 来源 | 是否直接输出 |
|---|---|---|
| `name`、`GUID`、`classColor`、`db.char.level` | `UnitName`、`UnitGUID`、职业颜色、`UnitLevel` | 不输出；只在 Lua 内部/配置中使用 |
| `specID`、`specName`、`specRole`、`specRange` | `C_SpecializationInfo.GetSpecializationInfo()` 和 `rangeSpecID` | 不输出；Python 只看到 `专精` 序号，不看到真实 specID、角色职责或专精射程 |
| `isDead`、`mounted`、`isChatOpen`、`drinkStatus` | 死亡、坐骑、聊天框、饮水相关事件 | 不单独输出；只合成为 `有效性` |
| `casting`、`channeling`、`empowering` | 施法、引导、蓄力事件 | 部分输出为 `施法`、`引导`、`蓄力`、`蓄力层数`；具体 spellID 只有在专精声明 `施法技能` 时才输出映射索引 |
| `castTargetUnit`、`castTargetName`、`castTargetIndex` | `UNIT_SPELLCAST_SENT` 根据目标名匹配队伍成员 | 只有专精声明 `施法目标` 时输出队伍序号 |
| `mapID`、`mapInfo`、`subzone` | 区域变更和进世界事件 | 不输出；`mapID` 只参与 `敌人人数` 的测试地图例外 |
| `encounterID`、`bossID`、`difficultyID` | `ENCOUNTER_START/END` | 输出的是映射后的 `首领战` 和原始 `难度`，不是完整 encounter 信息 |
| `HealthPotionCount`、`ManaPotionCount`、`HealthstoneCount`、`RecklessnessCount`、`LightsPotentialCount` | `C_Item.GetItemCount()` | 不直接输出数量；只影响对应物品冷却字段是否写 255 |
| `DefensiveAuraInstanceID` | `UNIT_AURA` 中的 `HELPFUL|BIG_DEFENSIVE` 光环 | 不输出 auraInstanceID；只在有 `防御光环` block 时输出剩余时间 |

另外注意物品计数刷新存在两个问题：一是 `ITEM_COUNT_CHANGED` 在 `core.lua` 的 `OnEnable` 中未注册（尽管 `main.lua` 第 1568 行已定义处理函数），物品数量变更无法通过事件触发更新。二是 `updateItemCoolDown()` 中每个物品仅当对应计数为 nil 时才调用 `GetItemCount()`（如 `if not self.state.HealthPotionCount then self:GetItemCount() end`），一旦计数设为 0 就永久跳过刷新。两者叠加导致物品数量从 1 变为 0 后状态永久停滞。

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

注意施法目标的像素写入不是发生在 `UNIT_SPELLCAST_SENT` 中。该事件仅设置 `state.castTargetIndex`（main.lua 第 1416 行），实际的 `CreatTexture` 写入发生在后续的 `UNIT_SPELLCAST_START` / `CHANNEL_START` / `EMPOWER_START` 事件调用的 `updatePlayerCasting(spellID)` 中（main.lua 第 669-677 行）。因此如果只有 `UNIT_SPELLCAST_SENT` 触发而没有后续施法/引导/蓄力开始事件，施法目标字段的像素不会更新。

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
| `13` | 友方目标且有可驱散诅咒减益 |
| `14` | 友方目标且有可驱散疾病减益 |
| `15` | 友方目标且有可驱散中毒减益 |

> 注意：源代码（main.lua 第 921-922 行）的注释将 13 与 14 的标签写反（13=疾病、14=诅咒）。文档值经 `friendCurve` 映射确认是正确的（`dispelAbilities[2]`=诅咒驱散对应 13=诅咒减益，`dispelAbilities[3]`=疾病驱散对应 14=疾病减益），读者在对照源码时需注意此注释错误。同时 `dispelCapabilities` 表（main.lua 第 166-167 行）也存在同类注释错位（2=疾病驱散、3=诅咒驱散）。

敌方是否在范围内用 `self.state.specRange` 判断；友方目标按 40 码判断。`specRange` 来自 `Fuyutsui.rangeSpecID`，不是 Python 配置。

### 目标生命值和距离

`目标生命值` 使用 `UnitHealthPercent("target", false, curve100)`，和玩家血量一样是 0-100 的百分比。

`目标距离` 使用 `LibRangeCheck-3.0`：

```lua
local minRange, maxRange = rc:GetRange("target")
self:CreatTexture(blocks.state["目标距离"], maxRange / 255)
```

Python 读到的是 `maxRange` 的整数近似值，不是精确坐标距离。

### 目标施法和目标引导

`目标施法` 和 `目标引导` 只在部分职业/专精声明了对应 block 时输出。它们读取 `UnitCastingDuration("target")` / `UnitChannelDuration("target")`，使用和玩家施法相同的 `castCurve` 输出剩余时间，常规情况下也是约等于“秒 * 100”。

这里有一个特殊编码：源码会读取 `UnitCastingInfo("target")` / `UnitChannelInfo("target")` 的 `notInterruptible`，如果目标读条不可打断，就用 `falseValueWhite = CreateColor(0, 0, 1, 1)` 覆盖原本的时间值。Python 读到的就是 255。也就是说，`目标施法 == 255` 或 `目标引导 == 255` 不一定代表剩余时间超过 2.55 秒，也可能代表不可打断（注意：falseValueWhite 的变量名虽包含 'White'，但实际颜色是纯蓝 B=1，见 main.lua 第 21-22 行的定义 CreateColor(0, 0, 1, 1)。）

### 敌人人数

`敌人人数` 来自姓名板列表。流程是：

1. `NAME_PLATE_UNIT_ADDED` 时记录 `nameplate[unit]`。
2. 每 0.2 秒遍历当前姓名板。
3. 对每个单位重新读取距离和战斗状态。
4. 只有 `canAttack`、`maxRange <= specRange`，并且目标在战斗中时才计数。

有两个例外：`testMap` 和 `testEncounter` 中的地图/战斗会放宽”必须在战斗中”的条件，当前源码里包括银月城和茂林古树。

注意 `testMap` 和 `testEncounter` 是硬编码在 `main.lua` 第 1037-1042 行的 local 变量（非全局可配置表），第三方 mod 无法通过配置新增豁免条目。变量名以 `test` 为前缀暗示其调试/测试用途，不构成通用扩展机制。

## 队伍状态

`队伍类型` 和 `队伍人数` 是顶层字段。治疗逻辑还会读取 `state_dict["group"]` 子字典。

注意 `GROUP_ROSTER_UPDATE` 事件处理函数内置了 `C_Timer.NewTimer(1, function()...)` 实现的 1 秒防抖延迟：每次触发会取消前一个计时器再重新创建。队伍变更后至少需 1 秒才能反映到 `state_dict` 中。

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

注意 Python 端 `build_state_dict` 固定创建 30 个队伍成员槽位（`NUM_GROUPS = 30`），无论实际队伍/团队人数。超出实际人数的条目各字段为 0。遍历 `group` 时应根据`队伍人数`字段判断有效成员数。

`职责` 的值来自 `roleMap`：

| 值 | 职责 |
|---|---|
| `0` | NONE |
| `1` | TANK |
| `2` | HEALER |
| `3` | DAMAGER |
| `5` | 未识别（roleMap 中无对应项时的回退值） |

字段名叫 `职责`，但实际输出还包含有效性和距离判断：队友死亡、不可协助、不在视野、或 `UnitInRange()` 为假时会写 0；只有有效且在范围内时才写 `roleMap` 的职责值。因此 Python 里 `职责 == 0` 不一定表示真实职责是 NONE，也可能表示这个单位当前不可用。

注意代码中存在回退机制：当 `UnitGroupRolesAssigned()` 返回的职责字符串不在 `roleMap` 中时，写入 5/255。因此 Python 端可能读到 `职责 == 5`，表示该成员的职责字符串未能被识别。

注意：当前源码还有一个独立的 `updateUnitInSight` 机制。当 `UI_ERROR_MESSAGE` 返回消息"目标不在视野中"时（main.lua 第 1672 行），会将该成员的 `inSight` 立即置为 false，并在 1.5 秒后自动恢复为 true（main.lua 第 1157-1172 行）。`inSight` 作为 `valid` 的条件之一（第 1109 行和 1123 行），影响 `职责` 字段——当 `inSight` 为 false 时，该成员的 `valid` 为 false，`职责` 被写为 0。另外注意"目标不在视野中"是中文本地化字符串，英文客户端使用不同文本（如 "Target out of line of sight"），此机制在非中文客户端上永不会触发。

`updateGroupInRangeAndHealth()` 每次调用只更新一个团队成员（main.lua 第 1116-1137 行），通过 `updateIndex` 轮转，而非全量刷新。因此 Python 端看到的 `group` 字典不是同一快照时刻的数据——不同成员的 `生命值`、`职责` 可能来自不同帧。此外，玩家自身在 `inRange` 判定中通过 `UnitIsUnit(unit, "player")` 直接返回 true（第 1125 行），不经过 `UnitInRange()` 检查，因此玩家自身始终被视为「在范围内」。

队伍成员血量使用 `UnitHealthPercent(unit, false, obj.curve)`，并叠加 `inComingHeals` 和 `healAbsorb` 影响曲线。也就是说治疗逻辑读到的队友血量不是简单生命百分比，而是已经考虑了部分预估治疗和吸收修正后的显示值。

`inComingHeals` 的完整生命周期如下：

- **数据来源**：`helpfulSpells` 表（main.lua 第 65-73 行）硬编码了特定法术 ID 到治疗量的映射，例如快速治疗=15、圣光术=40 等。
- **设置时机**：施法开始时，`UNIT_SPELLCAST_START` 事件调用 `updateUnitIncomingHealsCurve(spellID)`，按 spellID 查表后设置目标成员的 `inComingHeals`。
- **清除时机**：施法结束时，`UNIT_SPELLCAST_STOP` 事件调用 `updateUnitIncomingHealsCurve2()`，将所有成员的 `inComingHeals` 置 0。

因此 `inComingHeals` 仅在该特定法术的施法窗口内有效，施法结束后立即归零。`helpfulSpells` 只覆盖表中硬编码的治疗法术，自定义或非标准治疗法术不会产生 `inComingHeals` 影响。

当前源码还有一个配置细节：`loadPlayerBlocks()` 只读取 group 配置里的 `auras` 字段，但 `class/Evoker.lua` 的增辉队伍配置写成了 `aura = { ... }` 单数。按当前代码，这个 `先知先觉` 队伍光环不会被加载到 `blocks.groups.auras`，即使 Python `config.yml` 里有对应 `group` 字段，也会一直读不到有效剩余时间。

除 `aura`/`auras` 字段名不匹配外，`Evoker.lua` 中 group 的 `num = 5` 与 `config.yml` 中 `num: 4` 也不一致。这意味着即使修正字段名，Lua 每名队员占据 5 个像素步长、Python 按 4 个步长解析，从第 2 个队员开始所有字段（`生命值`、`职责`、`驱散`、`先知先觉`）的像素偏移都会错位 1 个位置，队伍数据完全错乱。详见 `队友状态/readme.md`。

另一个配置问题是 `config.yml` 中战士武器专精（专精 1）的 `顺劈斩高亮` 和 `致死高亮` 都配置为 `step: 25`（对应同一像素位置）。Python `build_state_dict` 按字段名分别读入状态字典，但两个字段读取相同的像素值，且 Lua 端只能往一个 step 写一个值，导致其中一个字段始终读到错误值。第三方作者应避免为不同字段配置相同 step。

## 职业专精额外 block 字段

下面是当前 `Fuyutsui/class/*.lua` 中出现的所有 `type = "block"` 字段。这里不列 `type = "spell"` 的技能冷却，也不列 `type = "aura"` 的普通逻辑光环。

| 类别 | 字段 |
|---|---|
| 元信息 | `锚点`、`职业`、`专精` |
| 通用玩家状态 | `有效性`、`战斗`、`移动`、`施法`、`引导`、`蓄力`、`蓄力层数`、`生命值`、`能量值`、`一键辅助`、`法术失败`、`施法技能`、`施法目标` |
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

## 疾病判断

`疾病判断` 是死亡骑士部分逻辑使用的临时 block，不是直接扫描目标身上的疾病光环。它由 `UI_ERROR_MESSAGE` 触发：

```lua
elseif message == "射程范围内无有效目标。" then
    self:updateDiseaseJudge()
end
```

`updateDiseaseJudge()` 在存在 `blocks.state[“疾病判断”]` 时写 1，1 秒后自动清 0。也就是说它表达的是”刚刚出现过这类 UI 错误提示”，不是稳定的目标疾病状态，也不是可驱散类型。

注意 `UI_ERROR_MESSAGE` 的 message 文本是客户端本地化的。中文字符串”射程范围内无有效目标。”仅在 zhCN/zhTW 客户端有效；英文等其他语言客户端使用不同的错误文本（如英文的 “Out of range.”），此处的字符串比较不会匹配，`updateDiseaseJudge()` 永远不会触发。如果 mod 需要跨语言兼容，应考虑使用 `UNIT_SPELLCAST_FAILED` 事件或光环扫描替代此机制。

## 配置开关状态

这些字段不是游戏 API，而是 Fuyutsui 自己的 `db.char` 配置：

| 字段 | 来源 | 常见用途 |
|---|---|---|
| `爆发开关` | `/fu cd` 或快速按钮切换 `c.cooldowns` | 是否自动使用爆发技能 |
| `AOE开关` | `/fu aoemode` 切换 `c.aoeMode` | 自动/单体或 AOE 策略 |
| `输出模式` | `/fu dpsmode` 切换 `c.dpsMode` | 一键辅助或手写逻辑 |
| `爆发药水开关` | `/fu potion` 切换 `c.potion` | 是否自动使用爆发药水 |
| `延迟` | `/fu delay [秒]` 临时置 `c.delay = 1` | 手动插入技能后短暂停止自动逻辑 |

`updatePlayerConfig()` 在初始化或专精切换后延迟 1 秒写 `爆发开关`、`AOE开关`、`输出模式`、`爆发药水开关`。`延迟` 不在 `updatePlayerConfig()` 里初始化写入，只由 `/fu delay [秒]` 触发 `SwitchDelay()` 写入，计时结束后再写回 0。单独切换某个选项时，对应的 `Switch*` 函数也会立即同步顶部像素。

## 物品状态为什么也算 block

`大红冷却`、`治疗石冷却`、`鲁莽药水冷却` 由 `updateItemCoolDown()` 写入 `blocks.state`，所以从 Lua 的分类看它们是普通玩家状态 block，不在 `blocks.spells` 中。

但 Python `config.yml` 里有些专精把物品冷却放在 `spells:` 子字典内，有些放在专精顶层。写逻辑时必须以当前 `config.yml` 为准：

- 在 `spells:` 里：用 `spells.get("大红冷却")`。
- 在专精顶层：用 `state_dict.get("大红冷却")`。

这类字段的详细冷却语义已经在 `技能冷却/readme.md` 中展开。

另外注意 `updateItemCoolDown()` 中使用 `math.min(1, remainingTime / 255)` 写入冷却值，当冷却剩余时间超过 255 秒时 value 被钳制为 1，与 else 分支「物品不可用」时写入的值相同。Python 端读到 value=1 无法区分「刚进入冷却」和「还剩数百秒冷却」。mod 作者不应依赖 value=1 来唯一判断冷却状态。

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
- `step: bar`：从第二行 `countBars` 读取，不从顶部普通像素读取。countBars 是独立于顶部普通像素的渲染行（block.lua 第58-156行）：通过 `CreateAutoLayoutBar()` 创建 StatusBar 帧，支持 `castCount`（施法次数）和 `charge`（充能层数）两种 valueType；背景色块用 G 通道编码索引，末尾有灰色终点标记。多个职业配置（DeathKnight、DemonHunter、Priest、Monk、Shaman、Warlock 的 ClassBlocks）使用 `countBars` 键定义条计数器。countBars 的 StatusBar 在 block.lua 第 78 行注册了三个事件（`SPELL_UPDATE_USES`、`PLAYER_ENTERING_WORLD`、`SPELL_UPDATE_CHARGES`）驱动刷新，并通过第 86-88 行的 `spellIdToBar[spellId]` 缓存实现重复性检查（同一法术 ID 只创建一个 StatusBar）。Python 端（GetPixels.py 第140-236行）通过扫描第一列红色标记定位 countBars 行，按红色分段、白色分隔、灰色终止的规则解析各条段的值。

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
| 血量、能量、移动、死亡、坐骑、队伍变化、目标变化、首领战、法术失败 | 对应 WoW 事件触发 |
| Python `get_info()` | `logic_gui.py` 约每 0.2 秒 |

> 备注：`法术失败` 由 `UNIT_SPELLCAST_FAILED` 事件驱动刷新。`英雄天赋` 在 `updatePlayerBlocks` 中经 `C_Timer.After(1)` 延迟初始化一次，不属于定期刷新机制。

因此 Python 端看到的玩家状态通常会有 0-0.4 秒量级延迟。它不保存历史状态，也不做预测，每轮都是重新截图并重建 `state_dict`。

## 写 mod 时要注意

- 不要把 `有效性 == False` 直接解释成“上坐骑”；它也可能是死亡、聊天输入或饮水。
- 不要写依赖移动速度的逻辑，当前只有 `移动` 布尔值。
- `生命值` 和 `目标生命值` 是百分比，不是具体血量。
- `能量值` 的语义随资源上限变化：大资源更像百分比，小资源更像点数。
- `能量值` 和 `神圣能量`、`连击点`、`灵魂碎片`、`真气`、`精华能量` 不是同一轮必定同步刷新的字段；按专精选用最明确的资源字段。
- `职业` 是职业 ID，`专精` 是专精序号；真正的 specID 只存在 Lua 内部。
- `目标距离` 是 LibRangeCheck 返回的 `maxRange`，不是坐标距离。
- `目标施法` / `目标引导` 的 255 可能表示不可打断，不要只按“剩余 2.55 秒以上”解释。
- `施法`、`引导`、`蓄力` 是时间值，通常用 `> 0` 判断状态。
- `施法技能` 依赖 `spellsList` 是否有对应 spellID；没有映射时输出 0。
- `疾病判断` 是 1 秒临时错误提示标记，不是真正的疾病光环扫描结果。
- `职责 == 0` 可能表示队友死亡、不可协助、不在视野或不在范围，不一定表示真实职责是 NONE。
- `延迟` 只由 `/fu delay` 写入，不是 `updatePlayerConfig()` 的初始化输出项。
- 职业 Lua 里有字段不代表 Python 一定能读到；必须同步 `config.yml`。
- Python `config.yml` 里有字段也不代表 Lua 一定会写；必须检查是否存在对应 `blocks.state["字段名"]` 更新路径。
- 在大秘境和评级 PvP 等受保护场景中，`isSec` 会拦截多项事件处理，导致饮水状态、法术失败记录、施法目标追踪等功能不可用或基于过期数据运行。依赖这些功能的 mod 需注意受保护内容中的行为差异。
- `inComingHeals` 只覆盖 `helpfulSpells` 表中硬编码的治疗法术，自定义或非标准治疗法术不会产生 `inComingHeals` 曲线影响。

## 修订记录

| 日期 | 修订人 | 位置 | 原因 | 概要 |
|---|---|---|---|---|
| 2026-05-30 | Iota | 有效性表格后 | Theta 二审 | 补充 `drinkStatus` 的 else 分支清理行为说明 |
| 2026-05-30 | Iota | Python 端结构 | Theta 二审 | 扩展 `step: bar` 说明，补充 countBars 流水线细节 |
| 2026-05-30 | Iota | 刷新频率表 | Theta 二审 | 添加"法术失败"至事件驱动行，补充英雄天赋备注 |
| 2026-05-30 | Iota | 队伍状态 | Theta 二审 | 补充 NUM_GROUPS=30 的固定槽位说明 |
| 2026-05-30 | Iota | 目标施法和目标引导 | Theta 终审 | 补充 falseValueWhite 实际颜色为蓝色的注释 |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审 | 补充 EnumPowerType 映射表（config.lua 第 766-787 行） |
| 2026-05-30 | Iota | 有效性如何计算 | Theta 终审 | 补充 drinkStatus 法术名称本地化依赖警告及跨语言说明 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | countBars 职业列表补充萨满 |
| 2026-05-30 | Iota | 疾病判断 | Theta 终审 | 补充 UI_ERROR_MESSAGE 中文字符串语言依赖警告 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | roleMap 补充回退值 5，新增 updateUnitInSight 机制说明 |
| 2026-05-30 | Iota | 能量值和职业资源之后 | Theta 终审 | 新增「受保护值(isSec)对事件链的影响」独立子节，说明 isSec 在 UNIT_SPELLCAST_SUCCEEDED/FAILED/SENT 中的拦截行为及对大秘境场景的影响 |
| 2026-05-30 | Iota | 法术失败 | Theta 终审 | 补充 isUsable 前提条件，说明冷却中技能不写入法术失败像素 |
| 2026-05-30 | Iota | 目标类型 | Theta 终审 | 补充 main.lua 第 921-922 行及第 166-167 行注释错位说明 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 GROUP_ROSTER_UPDATE 1 秒防抖延迟说明 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 展开 inComingHeals 完整生命周期（helpfulSpells 表、施法开始/结束设置清零） |
| 2026-05-30 | Iota | 物品状态为什么也算 block | Theta 终审 | 补充 updateItemCoolDown 中 math.min(1, remainingTime/255) 数值钳制说明 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 补充 countBars 注册事件（SPELL_UPDATE_USES/PLAYER_ENTERING_WORLD/SPELL_UPDATE_CHARGES）及 spellIdToBar 重复性检查机制 |
| 2026-05-30 | Iota | 写 mod 时要注意 | Theta 终审 | 新增 isSec 受保护场景影响提示和 inComingHeals 硬编码法术限制提示 |
