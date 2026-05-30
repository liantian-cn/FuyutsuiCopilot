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
| `移动` | `IsPlayerMoving()` 初始值, 由 PLAYER_STARTED_MOVING/PLAYER_STOPPED_MOVING 事件触发 `updatePlayerMoving()`（Fuyutsui > main.lua > updatePlayerMoving）刷新；该函数在写入移动状态前先无条件置 `state.drinkStatus = false`，影响有效性合成 | 0/1，不是移动速度 |
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
> 
> 法术失败机制还依赖三个模块级局部变量（Fuyutsui > main.lua 模块级，非 self.state 字段）—— failedSpell 记录失败法术在 spellsList 中的索引，failedSpellId 记录原始 spellID 供 updateFailedSpellBySuccess 匹配后清除，failedSpellTimer 为 1.5 秒后自动将法术失败像素清 0 的 C_Timer。这三个变量的存在意味着法术失败状态完全由内存中的变量管理，不依赖 WoW 事件中的持久化数据状态。

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
| `drinkStatus` | `UNIT_SPELLCAST_SUCCEEDED` 检查法术名”饮水”或”进食饮水”；`PLAYER_STARTED_MOVING` / `PLAYER_STOPPED_MOVING` 均触发 `updatePlayerMoving()`（Fuyutsui > main.lua > updatePlayerMoving） | 饮水后置 true，20 秒后清空；移动也会清空（注意：法术名称为中文客户端本地化值；英文客户端分别为 “Refreshment” 和 “Food and Drink”，此比较在非中文客户端永不为真。）移动事件调用的 `updatePlayerMoving()` 先设置 `state.drinkStatus = false`，紧接着调用 `self:updatePlayerValid()` 重新计算完整有效性公式（isDead、mounted、isChatOpen、drinkStatus 的合取）。请注意 PLAYER_STOPPED_MOVING 同样触发 drinkStatus=false，这一联动是设计选择而非逻辑必然，依赖饮水状态的 mod 作者应在 Stop 事件后重新确认 drinkStatus。 |

注意 `updateDrinkStatus()` 的 else 分支会在法术名不是”饮水”或”进食饮水”时立即将 `drinkStatus` 置 false 并取消已有计时器。由于 `UNIT_SPELLCAST_SUCCEEDED` 对每次玩家成功施法都调用 `updateDrinkStatus(spellID)`，任何非饮水法术（包括战斗中的输出技能）都会立即清空 `drinkStatus`，实际窗口期远短于 20 秒。

由于 `C_Spell.GetSpellName` 返回客户端本地化的法术名称，此 drinkStatus 检测机制仅在 zhCN/zhTW 客户端有效。跨语言 mod 应用 spellID 直接检测或检查客户端区域。

注意当前源码里有一个细节：`updateShapeshiftForm()` 把 `state.shapeshiftFormID` 存成 `shapeshiftFormID / 255`，但 `updatePlayerMounted()` 又拿它和原始 ID `27`、`3`、`29` 比较。这意味着“通过变形形态判断坐骑”的分支很可能不起作用；普通坐骑仍由 `IsMounted()` 判断。

此外，在 `updatePlayerBlocks()` 初始化时，`updatePlayerMounted()`（Fuyutsui > main.lua > updatePlayerBlocks 内）在 `updateShapeshiftForm()`（Fuyutsui > main.lua > updatePlayerBlocks 内）之前调用。此时 `state.shapeshiftFormID` 尚为 nil（Fuyutsui > core.lua 初始 state 不含此字段），比较结果为 nil == 27/3/29（均为 false），使得形状变形-坐骑检测路径在初始化时双重失效。

## 生命值

玩家血量由：

```lua
local healthPercent = UnitHealthPercent("player", false, curve100)
local _, _, b = healthPercent:GetRGB()
self:CreatTexture(blocks.state["生命值"], b)
```

`curve100` 把百分比映射到 B 通道，Python 读到的值通常是 1-100 的整数百分比。注意 curve100 在参数 b=100 时 z=0，产生三个控制点 (0,0)、(0,1/255)、(1,100/255)，第二个点覆盖第一个点后等效映射为 B=(1+99*t)/255。50% 血量时 B=50.5/255，Python 读到约 51 而非 50。除 100% 血量外，全范围存在约 +1 的系统偏移。此外 `creatColorCurveScaling` 在 b>100 时还有一个分支（Fuyutsui > main.lua > creatColorCurveScaling），创建仅含两个控制点 (0, (b-100)/255) 和 (1, b/255) 的曲线，产生不同于 b<=100 三控制点曲线的偏移起点。此分支在运行时可通过 updateUnitHealthInfo（Fuyutsui > main.lua > updateUnitHealthInfo 的 100 + inComingHeals - healAbsorb）在 inComingHeals > healAbsorb 时进入，常见于团队治疗场景。`UNIT_HEALTH`、`UNIT_MAXHEALTH`、`UNIT_HEAL_ABSORB_AMOUNT_CHANGED`、`UNIT_HEAL_PREDICTION` 都会触发玩家血量刷新。但 `UNIT_HEAL_PREDICTION` 对队伍成员的行为不对称：当事件 unit 是玩家自身时，调用 `updatePlayerHealth()` 刷新血量像素；当 unit 是队伍成员时（main.lua 中 group[unit] 分支），仅调用 `updateUnitDeathByHealthInfo()` 检测死亡，不调用 `updateUnitHealthInfo()` 刷新血量像素。队伍成员的治疗预估变化不会立即触发血量像素刷新；血量像素更新依赖 OnUpdate 每帧轮转的 `updateGroupInRangeAndHealth` 在下一次轮转至此成员时生效，引入一个取决于队伍大小与轮转位置的延迟——`updateGroupInRangeAndHealth` 每次 OnUpdate 仅更新一名成员（通过 `updateIndex` 轮转），治疗预估变化需等轮转至此成员时才会刷新血量像素。最坏情况下延迟可达 N-1 帧（5 人队伍最多约 4 帧/67ms，30 人团队最多约 29 帧/483ms）。依赖治疗预估事件观察队友血量的 mod 作者需注意此差异。

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
- EnumPowerType 映射表定义在 Fuyutsui > core/config.lua > EnumPowerType：MANA=0、RAGE=1、FOCUS=2、ENERGY=3、COMBO_POINTS=4、RUNES=5、RUNIC_POWER=6、SOUL_SHARDS=7、LUNAR_POWER=8、HOLY_POWER=9、MAELSTROM=11、CHI=12、INSANITY=13、BURNING_EMBERS=14（历史遗留，当前版本已移除）、DEMONIC_FURY=15（历史遗留，当前版本已移除）、ARCANE_CHARGES=16、FURY=17、PAIN=17（注：PAIN 与 FURY 共享 ID 17）、ESSENCE=19、SHADOW_ORBS=28。
- `CreatPowerCurve(powerType)` 有永久缓存机制：首次为某资源类型创建曲线后缓存于 `powerCurve[powerType]`，后续调用直接返回缓存（Fuyutsui > main.lua > CreatPowerCurve > powerCurve 缓存 `if powerCurve[powerType] then return end`）。这意味着曲线在运行期间不会因资源最大值变化（如专精切换、等级提升）而更新。

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

警告：`updatePlayerPower(powerType)` 的三路分支逻辑可能导致多个职业的能量值字段无法通过此函数更新。

- 当 `UnitPower()` 返回受保护值时，走 `UnitPowerPercent()`，写通用 `能量值`。
- 当 `UnitPower()` 不是受保护值，并且资源类型在 `specialPowerMap` 中时，写 `神圣能量`、`连击点`、`灵魂碎片`、`真气`、`精华能量` 等专用字段。
- 当 `UnitPower()` 不是受保护值，并且资源类型不在 `specialPowerMap` 中时，当前源码没有在这个函数里写 `能量值`。

对于 mana/rage/focus/energy/runic_power/lunar_power/insanity/fury/pain/maelstrom 等不在 specialPowerMap（仅含连击点/神圣能量/精华能量/灵魂碎片/真气五种）中的资源类型，且 isSec(power) 为假时，三路分支均不执行更新 `能量值`，能量值（step 12 对应像素）永远不会被此函数更新。受影响的职业包括但不限于：战士（怒气）、法师（法力）、死亡骑士（符文能量）、猎人（集中值）、牧师（法力）、德鲁伊非连击点专精（法力/怒气/能量）、萨满（法力；元素/增强专精为漩涡，法力仅适用于恢复专精）、恶魔猎手（怒意/痛苦）等。这些职业的能量值字段实质上无法通过 `updatePlayerPower` 刷新。

注意：SetTestSecret(1) 强制 secret*RestrictionsForced 系 CVar 为 1 使 isSec() 对确实受保护的值类别（spellID、GUID、名字、光环数据）返回真，但玩家自身 UnitPower("player") 返回的简单整数不属于受保护类别（此结论基于 WoW API 在非受保护环境中 UnitPower 返回常见整数值时的观察，SetTestSecret(1) 后的具体行为边界未经官方确认，属于推测性描述）。因此 isSec(power) 在运行时返回假，specialPowerMap 分支正常执行，通过 CreatTexture(blockIndex, power / 255) 写入 神圣能量/连击点/灵魂碎片/真气/精华能量。对于 Paladin/Druid/Evoker/Warlock/Monk 专精，if not isSec(power) and specialPower 分支是实际运行路径，分支 1（UnitPowerPercent -> 能量值）仅在资源类型不在 specialPowerMap 中时执行。

因此写 Python 逻辑时不要假设同一轮截图里 `能量值` 和专用资源字段一定同时刷新。某些专精应优先读取自己的专用资源字段；只有需要通用主资源时再读 `能量值`。mod 作者在编写战士、法师、死亡骑士、猎人、牧师、德鲁伊（非猫/野德）、萨满等职业逻辑时，不应依赖 `能量值` 字段获取主资源数值，需查找职业专用资源字段（符文、酒池等）或确认能量值有其他更新路径。

但需注意：`UNIT_POWER_UPDATE` 事件触发时依旧无条件调用 `updatePlayerPower(powerType)`，该函数确实被执行（三路分支逐一判断），只是因为当前资源类型不在 `specialPowerMap` 中且 `isSec(power)` 为假，未命中任何写入路径——函数被调用了但不产生像素更新。对调试事件链的 mod 作者而言，"函数被调用但无像素写入"与"函数未被调用"是两种不同的调试路径。

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

当前源码在 Fuyutsui > core.lua 的模块级作用域调用 SetTestSecret(1)，强制设置 secret*RestrictionsForced 系 CVar 为 1（共六个：secretChallengeModeRestrictionsForced、secretCombatRestrictionsForced、secretEncounterRestrictionsForced、secretMapRestrictionsForced、secretPvPMatchRestrictionsForced、secretAuraDataRestrictionsForced），额外还设置了 scriptErrors 和 doNotFlashLowHealthWarning 两个 CVar。mod 作者在切换调试环境时应注意这两个额外副作用。这使 isSec() 对确实受保护的值类别（spellID、GUID、名字、光环数据等）返回真；但简单类型值如 UnitPower("player") 返回的玩家自身资源整数值不属于受保护类别。若手动执行 SetTestSecret(0)，isSec() 将恢复条件性行为——仅在真正受保护内容（大秘境、评级 PvP）中返回真。同时注意：SetTestSecret(1) 在模块加载时执行（早于 OnEnable），与 OnEnable 中的事件注册无直接时序依赖。这意味着下文描述的所有 isSec 拦截行为（包括 UNIT_SPELLCAST_SUCCEEDED/FAILED/SENT 的跳过及 UNIT_DIED 的保护）在非受保护内容中也始终生效。

**注意**：以上关于 isSec(spellID) 对事件参数返回真的描述，基于 SetTestSecret(1) 使 isSec 对 spellID 类受保护值始终返回真的代码行为。但 WoW 事件回调中传递的 spellID 参数（如 UNIT_SPELLCAST_SUCCEEDED/FAILED）是否经过与 API 返回值相同的保护层，未经官方确认，属于推测性描述。若事件参数 spellID 不被 isSec 视为受保护值，则基于此前提的后续推断（包括 ClearAllFuyutsuiBars 死代码结论）将不成立。

需区分两种 spellID 的来源：事件参数 spellID 是 WoW 事件（UNIT_SPELLCAST_SUCCEEDED/FAILED/SENT 等）回调传递的原始整数，来自游戏引擎本身，不经过内容保护 API 混淆层；而通过 UnitCastingInfo()、GetSpellInfo() 等 API 返回的 spellID 可能经过保护层处理。isSec() 对两种来源的 spellID 是否一致返回真，当前源码未提供明确证据。

当前源码中 `isSec` 在以下位置影响事件处理：

| 事件 | 函数 | isSec 检查目标 | 行为差异 |
|---|---|---|---|
| `UNIT_SPELLCAST_SUCCEEDED` | `updateDrinkStatus()` | `isSec(spellID)` | 若 spellID 受保护，跳过 `updateDrinkStatus`、`updateFailedSpellBySuccess`、`updateAuraBySuccess`，整个回调直接 return |
| `UNIT_SPELLCAST_FAILED` | `updateSpellFailed()` | `isSec(spellID)` | 若 spellID 受保护，跳过 `updateSpellFailed`，不记录法术失败 |
| `UNIT_SPELLCAST_SENT` | 事件处理器 | `isSec(targetName)` | 若目标名受保护，阻止设置 `state.castTargetIndex`/`castTargetName`/`castTargetUnit` |
| `UNIT_DIED` | 事件处理器 | `isSec(unitGUID)` | 若 unitGUID 受保护，跳过 `updateUnitDeath`，不检测该单位死亡 |
| `SPELL_UPDATE_COOLDOWN` | `updateAuraBySpellCooldown()` 所在的事件处理器 | `isSec(spellID)` | 若 spellID 受保护，跳过 `updateAuraBySpellCooldown`，不通过冷却事件同步光环结束时间与层数 |


> 注意：`Fuyutsui/core/config.lua` 中定义了 `Fuyutsui.noSecretAuras` 表，包含唤魔师、德鲁伊、牧师、武僧、萨满、圣骑士等治疗/辅助专精的 30 余个光环法术 ID，语义上标记这些光环不应受 isSec 保护层影响。但全代码库搜索确认没有任何运行时代码（`main.lua`、`auras.lua`、`core.lua`、`class/*.lua`）读取或引用该表。这是一个已定义但完全不被消费的死代码结构。浏览 `config.lua` 的 mod 作者可能误认为存在针对这些光环的 isSec 豁免机制，但实际上该表无任何运行时效果。上表中描述的所有豁免行为均基于 WoW 内置的 `issecretvalue()` 全局函数，与此表无关。

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

另外注意物品计数刷新存在两个问题：一是 `ITEM_COUNT_CHANGED` 在 Fuyutsui > core.lua > OnEnable 中未注册（尽管 Fuyutsui > main.lua 已定义处理函数），`BAG_UPDATE` 同样未在 OnEnable 中注册，结合两者缺失，确认物品数量变更完全无法通过任何事件驱动刷新。二是 `updateItemCoolDown()` 中 `GetItemCount()` 一次性设置全部 5 个计数（HealthPotionCount/ManaPotionCount/HealthstoneCount/RecklessnessCount/LightsPotentialCount），任一计数为 nil 时触发，此后所有计数仅初始化一次。每个物品仅当对应计数为 nil 时才调用 `GetItemCount()`（如 `if not self.state.HealthPotionCount then self:GetItemCount() end`），一旦计数设为非 nil 就永久跳过刷新。两者叠加导致所有 5 个计数在初始化后全部冻结，影响范围远大于文档之前仅聚焦的 HealthPotionCount。

此外 `SPELL_UPDATE_USES` 和 `SPELL_UPDATE_CHARGES` 均已在 core.lua 注册，但它们的 addon 级处理函数是空的（仅占位），实际功能由 Fuyutsui > core/block.lua 中 countBars 框架帧独立处理。此注册是冗余的。`ENCOUNTER_TIMELINE_EVENT_ADDED`、`ENCOUNTER_TIMELINE_EVENT_REMOVED` 和 `ENCOUNTER_TIMELINE_EVENT_STATE_CHANGED` 同样在 core.lua 的 OnEnable 中注册，但在 main.lua 中仅有空函数体（无实际操作），属于同一冗余注册模式。`SPELL_RANGE_CHECK_UPDATE` 和 `ACTION_RANGE_CHECK_UPDATE` 也属于同一模式——在 core.lua 的 OnEnable 中注册，main.lua 中处理函数仅包含注释掉的 `updateNameplateCount()` 调用，从未执行实际功能。

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

注意施法目标的像素写入不是发生在 `UNIT_SPELLCAST_SENT` 中。该事件仅设置 `state.castTargetIndex`（Fuyutsui > main.lua > UNIT_SPELLCAST_SENT 事件处理器），实际的 `CreatTexture` 写入发生在后续的 `UNIT_SPELLCAST_START` / `CHANNEL_START` / `EMPOWER_START` 事件调用的 `updatePlayerCasting(spellID)` 中（Fuyutsui > main.lua > updatePlayerCasting）。因此如果只有 `UNIT_SPELLCAST_SENT` 触发而没有后续施法/引导/蓄力开始事件，施法目标字段的像素不会更新。

注意当前 `UNIT_SPELLCAST_EMPOWER_STOP` 处理函数的条件疑似写反：它使用 `unitTarget ~= "player"` 而非 `== "player"`。完整控制流分析如下：
（1）unitTarget="player"：第一分支 `~="player"` 为假，第二分支 `=="target"` 也为假 → state.empowering 和 target.empowering 均泄漏；
（2）unitTarget="target"：第一分支为真，错误地清除 state.empowering，target.empowering 泄漏；
（3）对比 CHANNEL_STOP（Fuyutsui > main.lua > CHANNEL_STOP 事件处理器）的正确模式 `if unitTarget == "player" ... elseif unitTarget == "target"` 可清楚看出设计缺陷。
如果游戏内蓄力状态出现残留，应优先检查这里。

此外，`state.casting`/`channeling`/`empowering` 三个状态纯由 WoW 事件驱动（START 置 true、STOP 置 false），`OnUpdate` 中对应的 `updatePlayerCastingInfo`/`channelingInfo`/`empowerInfo`（Fuyutsui > main.lua > OnUpdate）在 `Duration` 对象为 nil 时只写 0 到纹理，不会自行清除对应状态标记。若 STOP 事件因断线、UI 重载、事件抑制等丢失，状态标记将永久滞留为 true，导致每帧访问失效的 `Duration` 对象（Fuyutsui > main.lua > Duration 对象访问）。各 STOP 事件处理函数（UNIT_SPELLCAST_STOP、CHANNEL_STOP、EMPOWER_STOP）还同时清除 state.castTargetUnit（nil）、state.castTargetName（nil）和 state.castTargetIndex（0）。若对应 STOP 事件丢失，这些字段同样会携带过期值，mod 作者在容错分析时需一并考虑。该风险涉及系统可靠性，mod 作者在做容错分析时应注意这一点。同时 `EMPOWER_STOP` 处理函数（Fuyutsui > main.lua > EMPOWER_STOP 事件处理器）使用 `unitTarget ~= 'player'` 而非 `== 'player'` 的条件来清除玩家蓄力状态，属于明显的条件反转，使玩家自身蓄力清除路径更加脆弱。

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

> 注意：源代码（Fuyutsui > main.lua > 目标类型注释处）的注释将 13 与 14 的标签写反（13=疾病、14=诅咒）。文档值经 `friendCurve` 映射确认是正确的（`dispelAbilities[2]`=诅咒驱散对应 13=诅咒减益，`dispelAbilities[3]`=疾病驱散对应 14=疾病减益），读者在对照源码时需注意此注释错误。同时 `dispelCapabilities` 表（Fuyutsui > main.lua > dispelCapabilities 注释处）也存在同类注释错位（2=疾病驱散、3=诅咒驱散）。

注意目标类型值 1-3（敌方）和 11-15（友方）中可驱散类型的判定取决于 `updateSpellKnown()`（Fuyutsui > main.lua > updateSpellKnown）中通过 `hasLearnedAnySpell()` 调用 `IsSpellKnown()` 动态检测玩家是否学习了对应驱散法术。`dispelAbilities` 表（Fuyutsui > main.lua > dispelAbilities）定义防御驱散法术 ID 组（如 527、4987、88423 等防御魔法驱散），`offensiveDispelAbilities`（Fuyutsui > main.lua > offensiveDispelAbilities）定义进攻驱散法术 ID 组（如 2908 激怒驱散）。不同角色因职业/专精/是否学习驱散法术而产生不同的目标类型取值范围，这是理解目标类型值在不同角色间差异的关键前提。

此外，源码 `dispelAbilities[11]` 表中存在流血驱散条目（空 `{}`），`hasLearnedAnySpell({})` 始终返回 false，因此不会产生含驱散标记的友方目标类型变体。此条目不影响功能，但属于表中遗漏的边缘情况。

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

这里有一个特殊编码：源码会读取 `UnitCastingInfo("target")` / `UnitChannelInfo("target")` 的 `notInterruptible`，如果目标读条不可打断，就用 `falseValueWhite = CreateColor(0, 0, 1, 1)` 覆盖原本的时间值。Python 读到的就是 255。也就是说，`目标施法 == 255` 或 `目标引导 == 255` 不一定代表剩余时间超过 2.55 秒，也可能代表不可打断（注意：falseValueWhite 的变量名虽包含 'White'，但实际颜色是纯蓝 B=1，见 Fuyutsui > main.lua > falseValueWhite 定义 CreateColor(0, 0, 1, 1)。）

### 敌人人数

`敌人人数` 来自姓名板列表。流程是：

1. `NAME_PLATE_UNIT_ADDED` 时记录 `nameplate[unit]`。
2. 每 0.2 秒遍历当前姓名板。
3. 对每个单位重新读取距离和战斗状态。
4. 只有 `canAttack`、`maxRange <= specRange`，并且目标在战斗中时才计数。

有两个例外：`testMap` 和 `testEncounter` 中的地图/战斗会放宽”必须在战斗中”的条件，当前源码里包括银月城和茂林古树。需要注意的是，`testEncounter` 中的 encounterID 是 WoW 事件（ENCOUNTER_START）传递的原始参数，与 config.lua 中 bossID 映射表的 encounterID 列虽然数值相同但属于不同概念——一个是事件参数，一个是映射表输入键。`茂林古树` 同时出现在两个位置（config.lua 的 bossID 映射表 encounterID 2563 → bossID 70，以及 testEncounter 的豁免列表 encounterID 2563），mod 作者不应混淆两者的用途。

注意 `testMap` 和 `testEncounter` 是硬编码在 Fuyutsui > main.lua > testMap/testEncounter 的 local 变量（非全局可配置表），第三方 mod 无法通过配置新增豁免条目。变量名以 `test` 为前缀暗示其调试/测试用途，不构成通用扩展机制。

另外初始 `state` 对象（Fuyutsui > core.lua 初始 state）中无 `mapID` 和 `encounterID` 字段。`state.mapID` 在首次 `ZONE_CHANGED`/`ZONE_CHANGED_INDOORS`/`PLAYER_ENTERING_WORLD` 前为 nil（Fuyutsui > main.lua > ZONE_CHANGED/ZONE_CHANGED_INDOORS/PLAYER_ENTERING_WORLD 事件处理器），`state.encounterID` 在首次 `ENCOUNTER_START` 前为 nil。Fuyutsui > main.lua > testMap 的 nil 安全短络检查（`state.mapID and testMap[state.mapID]`）在 nil 时短路返回假，因此从游戏启动到首次进入有效区域/首领战之前，`testMap`/`testEncounter` 的放宽战斗条件豁免不生效。

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

注意玩家自身在 `updateGroup()` 中的角色不经过 `UnitGroupRolesAssigned('player')`，而是被 `self.state.specRole` 覆盖（Fuyutsui > main.lua > updateGroup specRole 覆盖）。`specRole` 来自 `C_SpecializationInfo.GetSpecializationInfo()`（Fuyutsui > main.lua > GetCharacterSpecInfo；updatePlayerSpecInfo），反映专精固有职责（DAMAGER/HEALER/TANK）而非队伍分配职责（LFD/LFR 指派）。其他队伍成员仍使用 `UnitGroupRolesAssigned()` 的返回值。

字段名叫 `职责`，但实际输出还包含有效性和距离判断：队友死亡、不可协助、不在视野、或 `UnitInRange()` 为假时会写 0；只有有效且在范围内时才写 `roleMap` 的职责值。因此 Python 里 `职责 == 0` 不一定表示真实职责是 NONE，也可能表示这个单位当前不可用。在像素层面，当 `inRange` 为假时，`updateGroupInRangeAndHealth` 使用 `falseValueBlack`（`CreateColor(0,0,0,1)`）写入职责像素，强制 B=0，这是职责=0出现条件的底层编程级证据。

注意代码中存在回退机制：当 `UnitGroupRolesAssigned()` 返回的职责字符串不在 `roleMap` 中时，写入 5/255。因此 Python 端可能读到 `职责 == 5`，表示该成员的职责字符串未能被识别。

注意：当前源码还有一个独立的 `updateUnitInSight` 机制。当 `UI_ERROR_MESSAGE` 返回消息"目标不在视野中"时（Fuyutsui > main.lua > UI_ERROR_MESSAGE 事件处理器），会将该成员的 `inSight` 立即置为 false，并在 1.5 秒后自动恢复为 true（Fuyutsui > main.lua > updateUnitInSight 恢复计时器）。`inSight` 作为 `valid` 的条件之一（Fuyutsui > main.lua > updateGroupInRangeAndHealth valid 条件），影响 `职责` 字段——当 `inSight` 为 false 时，该成员的 `valid` 为 false，`职责` 被写为 0。另外注意"目标不在视野中"是中文本地化字符串，英文客户端使用不同文本（如 "Target out of line of sight"），此机制在非中文客户端上永不会触发。

注意队伍成员死亡检测存在两条路径。第一条是 `UNIT_HEALTH`/`UNIT_MAXHEALTH` 驱动的 `updateUnitDeathByHealthInfo`（Fuyutsui > main.lua > updateUnitDeathByHealthInfo），通过血量判断死亡。第二条是 `UNIT_DIED` 事件处理函数（Fuyutsui > main.lua > UNIT_DIED 事件处理器）通过 `unitGUID` 直接定位死亡队伍成员（Fuyutsui > main.lua > updateUnitDeath）并设置 `isDead = true`，含 `isSec` 保护，是更可靠的直接死亡检测路径。两条路径并存：`UNIT_DIED` 提供精准事件推送，`UNIT_HEALTH` 提供兜底轮询补充。

`updateGroupInRangeAndHealth()` 每次调用只更新一个团队成员（Fuyutsui > main.lua > updateGroupInRangeAndHealth），通过 `updateIndex` 轮转，而非全量刷新。因此 Python 端看到的 `group` 字典不是同一快照时刻的数据——不同成员的 `生命值`、`职责` 可能来自不同帧。此外，玩家自身在 `inRange` 判定中通过 `UnitIsUnit(unit, "player")` 直接返回 true（Fuyutsui > main.lua > updateGroupInRangeAndHealth UnitIsUnit 检查），不经过 `UnitInRange()` 检查，因此玩家自身始终被视为「在范围内」。

注意 `updateIndex` 轮转存在一个在正常游戏流程中可触发的停滞风险：当队伍/团队人数减少时（如队员退队/下线），`updateGroup()` 重建 `groupList` 但不重置 `updateIndex`。若 `updateIndex` 超出新的 `numUnits` 范围，`groupList[updateIndex]` 为 nil 触发 Fuyutsui > main.lua > updateGroupInRangeAndHealth 的早期 return（跳过 updateIndex 自增），导致该索引永久停滞，后续成员无法更新。需要留意的是，`updateGroupInRangeAndHealth` 属于 OnUpdate 高频逻辑段（每帧执行，约 60 次/秒），索引一旦停滞意味着每秒约 60 次早期 return 的无意义调用，而非读者从 0.2 秒 timer 段自然推想的约 5 次/秒。

注意 `IterateGroupMembers`（Fuyutsui > core.lua > IterateGroupMembers）在队伍与团队模式下对玩家自身的包含规则不同：队伍模式下迭代器以 i=0 开始并返回 'player'；团队模式下 i=1 开始，不返回 'player'。因此玩家自身的 group 条目（含 specRole 覆盖的职责，Fuyutsui > main.lua > updateGroup specRole 覆盖）仅在队伍模式下写入。mod 作者从 `state_dict["group"]` 读取玩家自身数据时应注意此模式差异。

队伍成员血量使用 `UnitHealthPercent(unit, false, obj.curve)`，并叠加 `inComingHeals` 和 `healAbsorb` 影响曲线。也就是说治疗逻辑读到的队友血量不是简单生命百分比，而是已经考虑了部分预估治疗和吸收修正后的显示值。

`healAbsorb` 的完整生命周期如下：

- **数据来源**：`UNIT_HEAL_ABSORB_AMOUNT_CHANGED` 事件触发 `updateUnitHealAbsorbCurve()`（Fuyutsui > main.lua > updateUnitHealAbsorbCurve）。
- **设置值**：事件触发时固定设置 `healAbsorb = 15`（对应 B 通道约 5.9% 偏移）。
- **清除时机**：1 秒计时器到期后清零。
- **参与公式**：曲线偏移公式 `creatColorCurveScaling(100 + inComingHeals - healAbsorb)`（Fuyutsui > main.lua > updateUnitHealthInfo 曲线偏移公式），即 `healAbsorb` 从显示血量中减去吸收值。

因此 `healAbsorb` 仅在吸收事件后 1 秒内有效，过期后自动归零。

`inComingHeals` 的完整生命周期如下：

- **数据来源**：`helpfulSpells` 表（Fuyutsui > main.lua > helpfulSpells）硬编码了特定法术 ID 到治疗量的映射，例如快速治疗=15、圣光术=40 等。
- **设置时机**：施法开始时，`UNIT_SPELLCAST_START` 事件调用 `updateUnitIncomingHealsCurve(spellID)`，按 spellID 查表后设置目标成员的 `inComingHeals`。
- **清除时机**：施法结束时，`UNIT_SPELLCAST_STOP` 事件调用 `updateUnitIncomingHealsCurve2()`，将所有成员的 `inComingHeals` 置 0。

因此 `inComingHeals` 仅在该特定法术的施法窗口内有效，施法结束后立即归零。`helpfulSpells` 只覆盖表中硬编码的治疗法术，自定义或非标准治疗法术不会产生 `inComingHeals` 影响。

当前源码还有一个配置细节：`loadPlayerBlocks()` 只读取 group 配置里的 `auras` 字段，但 `class/Evoker.lua` 的增辉队伍配置写成了 `aura = { ... }` 单数。按当前代码，这个 `先知先觉` 队伍光环不会被加载到 `blocks.groups.auras`，即使 Python `config.yml` 里有对应 `group` 字段，也会一直读不到有效剩余时间。

除 `aura`/`auras` 字段名不匹配外，`Evoker.lua` 中 group 的 `num = 5` 与 `config.yml` 中 `num: 4` 也不一致。这意味着即使修正字段名，Lua 每名队员占据 5 个像素步长、Python 按 4 个步长解析，从第 2 个队员开始所有字段（`生命值`、`职责`、`驱散`、`先知先觉`）的像素偏移都会错位 1 个位置，队伍数据完全错乱。详见 `队友状态/readme.md`。

除 `auras` 外，`rejuv` 是 `loadPlayerBlocks()` 中与 `auras` 并列的 group 可选配置维度（Fuyutsui > main.lua > loadPlayerBlocks rejuv 配置），用于 Druid 专精回春术计数。当 `config.yml` 中 group 子字典包含 `rejuv` 字段时，`OnUpdateUnitAura`（Fuyutsui > main.lua > OnUpdateUnitAura rejuv 计数）将回春术（spellId 774/155777）的计数写入 `blocks.groups.rejuv` 对应的像素步长，与 `auras` 光环系统独立运作。

另一个配置问题是 `config.yml` 中战士武器专精（专精 1）的 `顺劈斩高亮` 和 `致死高亮` 都配置为 `step: 25`（对应同一像素位置）。Python `build_state_dict` 按字段名分别读入状态字典，但两个字段读取相同的像素值，且 Lua 端只能往一个 step 写一个值，导致其中一个字段始终读到错误值。第三方作者应避免为不同字段配置相同 step。

类似的冲突也出现在死亡骑士鲜血专精（专精 3）中：`脓疮毒镰2` 和 `枯萎凋零` 均配置为 `step: 48`，Python 的 `build_state_dict` 对两者均从同一像素位置 `row_data[48]` 读取值，该位置对应 Lua index 48（`脓疮毒镰2` 的光环剩余时间）。因此 `枯萎凋零` 字段在 `state_dict` 中实际包含的是 `脓疮毒镰2` 的数值，而非 `枯萎凋零` 自身的剩余时间。配置缺少 step 49 映射意味着 Lua 对 index 49 写入的 `枯萎凋零` 真实值不会被任何 Python 字段读取。此问题不限于战士，在死亡骑士等其他职业配置中同样存在。

## 职业专精额外 block 字段

下面是当前 `Fuyutsui/class/*.lua` 中出现的所有 `type = "block"` 字段。这里不列 `type = "spell"` 的技能冷却，也不列 `type = "aura"` 的普通逻辑光环。

> 注意：部分职业（如 Fuyutsui > class/Warrior.lua）的"高亮"字段（斩杀高亮、英勇打击高亮、顺劈斩高亮、致死高亮）虽为 `type='aura'`，但通过 `config.yml` 的 `step` 映射出现在 Python `state_dict` 中。mod 作者若以本表作为 `state_dict` 字段索引，应同时参考对应 `class/*.lua` 中的 `type='aura'` 声明及 `config.yml` 的 `step` 配置以避免遗漏。

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

注意 ClassBlocks 中的 `powerType` 字段（如 Paladin.lua 专精3 声明的 `powerType = "MANA"`）是死配置——`loadPlayerBlocks()`（Fuyutsui > main.lua > loadPlayerBlocks 非条目字段跳过）使用 `if type(v) ~= 'table' or not v.type then` 明确跳过非条目字段，`updatePlayerPowerType()`（Fuyutsui > main.lua > updatePlayerPowerType）总是使用 `UnitPowerType("player")` 运行时 API 而非 ClassBlocks 的 powerType。mod 作者不应依赖 ClassBlocks powerType 来预期能量类型变更。

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
| `输出模式` | `/fu dpsmode` 切换 `c.dpsMode` | 一键辅助或手写逻辑。注意此字段与第 13 步的「一键辅助」字段是两个彼此独立的机制：一键辅助字段来源于暴雪官方 Assisted Combat API（`C_AssistedCombat.GetNextCastSpell`），输出模式是 Fuyutsui 自身配置开关（`/fu dpsmode` 切换 `c.dpsMode`），两者可独立配置，不存在联动关系。 |
| `爆发药水开关` | `/fu potion` 切换 `c.potion` | 是否自动使用爆发药水 |
| `延迟` | `/fu delay [秒]` 临时置 `c.delay = 1` | 手动插入技能后短暂停止自动逻辑 |

`updatePlayerConfig()` 在初始化或专精切换后延迟 1 秒写 `爆发开关`、`AOE开关`、`输出模式`、`爆发药水开关`。`延迟` 不在 `updatePlayerConfig()` 里初始化写入，只由 `/fu delay [秒]` 触发 `SwitchDelay()` 写入，计时结束后再写回 0。单独切换某个选项时，对应的 `Switch*` 函数也会立即同步顶部像素。

## 物品状态为什么也算 block

`大红冷却`、`治疗石冷却`、`鲁莽药水冷却` 由 `updateItemCoolDown()` 写入 `blocks.state`，所以从 Lua 的分类看它们是普通玩家状态 block，不在 `blocks.spells` 中。

但 Python `config.yml` 里有些专精把物品冷却放在 `spells:` 子字典内，有些放在专精顶层。写逻辑时必须以当前 `config.yml` 为准：

- 在 `spells:` 里：用 `spells.get("大红冷却")`。
- 在专精顶层：用 `state_dict.get("大红冷却")`。

这类字段的详细冷却语义已经在 `技能冷却/readme.md` 中展开。

另外注意 `updateItemCoolDown()` 中使用 `math.min(1, remainingTime / 255)` 写入冷却值及 else 分支直接写 1，实际存在至少四条路径产生 value=1：(a) 冷却剩余时间恰好接近或超过 255 秒时钳制为 1，(b) 刚进入冷却且物品冷却时间本身接近 255 秒（remainingTime 约 255），(c) 物品完全未处于冷却（enableCooldownTimer=false，GetItemRemainingTime 返回 255，经 math.min(1, 255/255)=1 在 if 分支写入），(d) 物品数量为零或不可用（else 分支直接写 1）。Python 端读到 value=1 无法唯一区分无冷却、长冷却、物品不可用三种语义。

## 防御光环是特殊例外

`防御光环` 在恶魔猎手复仇专精里是 `type = "block"`，但它的数据来源是 WoW 的真实 Aura API：

```lua
C_UnitAuras.GetBuffDataByIndex(unit, i, "HELPFUL|BIG_DEFENSIVE")
C_UnitAuras.GetAuraDuration("player", state.DefensiveAuraInstanceID)
```

`GetDefensiveAuraInstanceID` 通过 `not issecretvalue(aura) and aura` 条件过滤受保护光环数据。在大秘境和评级 PvP 等受保护场景中，受保护光环的 auraInstanceID 不会被记录，防御光环剩余时间输出不可用。

因此它不属于 `core/auras.lua` 的玩家逻辑光环系统，但本质上仍是一个真实光环剩余时间。本文把它列在 block 字段里，是因为它通过 `blocks.state["防御光环"]` 写入，而不是通过 `blocks.auras` 写入。

注意 `GetDefensiveAuraInstanceID` 对于非 player 单位直接返回，`GetDefensiveAuraDuration` 硬编码 `'player'` 调用 `C_UnitAuras.GetAuraDuration`。若需要追踪队伍成员的防御光环，模组开发者必须自行实现参数化的版本。

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
- `step: bar`：从第二行 `countBars` 读取，不从顶部普通像素读取。countBars 是独立于顶部普通像素的渲染行（Fuyutsui > core/block.lua > CreateAutoLayoutBar）：通过 `CreateAutoLayoutBar()` 创建 StatusBar 帧，支持 `castCount`（施法次数）和 `charge`（充能层数）两种 valueType；背景色块用 G 通道编码索引，编码存在 -1 偏移。Lua 端从 i=-1（红色标记，G=0/255）开始迭代遍历背景色块，第一个数据值（i=0）映射到 G=1/255。Python 端通过 `_dict_value_from_raw_g(raw_g) = max(0, int(raw_g) - 1)` 将 G 通道值减 1 得到实际数值。此偏移产生自 Lua 端在数据块之前插入了一个额外标记块（i=-1）。mod 作者实现自定义 countBars 解析器时必须考虑此转换。末尾有灰色终点标记。多个职业配置（DeathKnight、DemonHunter、Priest、Monk、Shaman、Warlock 的 ClassBlocks）使用 `countBars` 键定义条计数器。

注意背景色块仅在 CreateAutoLayoutBar 创建时通过 for 循环一次性调用 SetColorTexture 渲染，后续 Refresh 函数仅更新前景 StatusBar 的数值（SetMinMaxValues/SetValue），不触及背景纹理。因此背景色块的 G 通道编码在整个运行期间静态不变。结合专精切换后 ClearAllFuyutsuiBars 为死代码的结论（见下文专精/天赋切换路径分析），旧专精的 countBars 背景编码会永久残留。

countBars 的 StatusBar 在 Fuyutsui > core/block.lua 注册了三个事件（`SPELL_UPDATE_USES`、`PLAYER_ENTERING_WORLD`、`SPELL_UPDATE_CHARGES`）驱动刷新，并通过内部的 `spellIdToBar[spellId]` 缓存实现重复性检查（同一法术 ID 只创建一个 StatusBar）。Python 端（Fuyutsui > Fuyutsui > GetPixels.py）通过扫描第一列红色标记定位 countBars 行，按红色分段、白色分隔、灰色终止的规则解析各条段的值。

注意专精/天赋切换时存在两条路径，影响 countBars 的残留行为。(1) `UNIT_SPELLCAST_SUCCEEDED`（spellID 200749/384255）看似先调用 `ClearAllFuyutsuiBars()`（Fuyutsui > core/block.lua > ClearAllFuyutsuiBars）清空 `createdBars` 和 `spellIdToBar`，1 秒后执行 `updatePlayerSpecInfo`。但路径 (1) 的 ClearAllFuyutsuiBars 死代码推断成立的前提是 isSec(spellID) 对事件参数也返回真（即事件参数 spellID 经过与 API 返回值相同的保护层），而此前提未经官方确认。若事件参数 spellID 不被 isSec 视为受保护值，则 ClearAllFuyutsuiBars 在 UNIT_SPELLCAST_SUCCEEDED 中并非死代码，路径 (1) 可能能正确重建 countBars。详见「受保护值(isSec)对事件链的影响」一节的不确定性说明。因此两条路径的 countBars 残留风险均建立在未经确认的前提上。(2) `PLAYER_TALENT_UPDATE` 事件（UI 天赋切换、休息区非法术操作）直接调用 `updatePlayerSpecInfo()`（Fuyutsui > main.lua > updatePlayerSpecInfo）和其内部的 `clearAllTextures()`，不执行 `ClearAllFuyutsuiBars()`。旧专精的 `createdBars` 和 `spellIdToBar` 未被清空，若新旧专精的法术 ID 分布不同，旧 `countBars` 可能在顶部像素区残留显示，新 `countBars` 可能因 `spellIdToBar` 碰撞（重复性检查）而不被创建。两条路径均无法正确清理旧 countBars，旧 countBars 必然残留。

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

> 备注：`法术失败` 由 `UNIT_SPELLCAST_FAILED` 事件驱动刷新。`英雄天赋` 在 `updatePlayerBlocks` 中经 `C_Timer.After(1)` 延迟初始化，此外还会在 `PLAYER_ENTERING_WORLD` 事件触发时（登录、区域切换、UI 重载等场景）被刷新。虽然不属定期轮询机制，但存在多个触发入口。`一键辅助` 在 `updatePlayerBlocks` 初始化时也会被调用一次，独立于 OnUpdate 每 0.2 秒的定期刷新。

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
- Lua block index 与 config step 必须严格 1:1 对应。当前代码中存在违反此规则的实例：法师冰霜专精（专精 3）的 `config.yml` 中施法技能 step 22、敌人人数 step 23 比 `Mage.lua` 的 block index（分别为 21、22）偏移了 1，导致 Python 读取的像素值对应错误的 Lua 写入位置。
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
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审 | 补充 EnumPowerType 映射表（Fuyutsui > core/config.lua > EnumPowerType） |
| 2026-05-30 | Iota | 有效性如何计算 | Theta 终审 | 补充 drinkStatus 法术名称本地化依赖警告及跨语言说明 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | countBars 职业列表补充萨满 |
| 2026-05-30 | Iota | 疾病判断 | Theta 终审 | 补充 UI_ERROR_MESSAGE 中文字符串语言依赖警告 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | roleMap 补充回退值 5，新增 updateUnitInSight 机制说明 |
| 2026-05-30 | Iota | 能量值和职业资源之后 | Theta 终审 | 新增「受保护值(isSec)对事件链的影响」独立子节，说明 isSec 在 UNIT_SPELLCAST_SUCCEEDED/FAILED/SENT 中的拦截行为及对大秘境场景的影响 |
| 2026-05-30 | Iota | 法术失败 | Theta 终审 | 补充 isUsable 前提条件，说明冷却中技能不写入法术失败像素 |
| 2026-05-30 | Iota | 目标类型 | Theta 终审 | 补充 Fuyutsui > main.lua 目标类型注释处及 dispelCapabilities 注释处注释错位说明 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 GROUP_ROSTER_UPDATE 1 秒防抖延迟说明 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 展开 inComingHeals 完整生命周期（helpfulSpells 表、施法开始/结束设置清零） |
| 2026-05-30 | Iota | 物品状态为什么也算 block | Theta 终审 | 补充 updateItemCoolDown 中 math.min(1, remainingTime/255) 数值钳制说明 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 补充 countBars 注册事件（SPELL_UPDATE_USES/PLAYER_ENTERING_WORLD/SPELL_UPDATE_CHARGES）及 spellIdToBar 重复性检查机制 |
| 2026-05-30 | Iota | 写 mod 时要注意 | Theta 终审 | 新增 isSec 受保护场景影响提示和 inComingHeals 硬编码法术限制提示 |
| 2026-05-30 | Iota | 有效性如何计算 | Theta 终审 | 补充移动事件（PLAYER_STARTED_MOVING/PLAYER_STOPPED_MOVING）触发 updatePlayerMoving() 清空 drinkStatus 并重新计算有效性的调用链 |
| 2026-05-30 | Iota | 生命值 | Theta 终审 | 补充 curve100 参数 b=100 时三个控制点等效映射及全范围约 +1 系统偏移说明 |
| 2026-05-30 | Iota | Lua 内部但未直接输出的玩家状态 | Theta 终审 | 补充 BAG_UPDATE 未注册、全部 5 个计数在初始化后冻结 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 rejuv 作为 group 可选配置字段，用于 Druid 回春术计数 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 展开 healAbsorb 完整生命周期（UNIT_HEAL_ABSORB_AMOUNT_CHANGED 触发、1 秒清零、参与曲线偏移公式） |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 UNIT_DIED 事件驱动的第二条死亡检测路径 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充玩家自身角色被 specRole 覆盖（专精固有职责而非队伍分配职责） |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 updateIndex 在队伍收缩时因 nil 提前 return 导致索引停滞的边缘风险 |
| 2026-05-30 | Iota | 施法、引导和蓄力 | Theta 终审 | 补充三状态纯事件驱动无防御超时机制及 EMPOWER_STOP 条件反转 |
| 2026-05-30 | Iota | 目标类型 | Theta 终审 | 补充驱散能力基于 IsSpellKnown 动态检测说明 |
| 2026-05-30 | Iota | 敌人人数 | Theta 终审 | 补充 state.mapID/encounterID 初始 nil 导致 startup 窗口期豁免条件不生效 |
| 2026-05-30 | Iota | 职业专精额外 block 字段 | Theta 终审 | 补充高亮 aura 字段通过 step 映射出现在 state_dict 的跨引用提示 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 补充 PLAYER_TALENT_UPDATE 不调用 ClearAllFuyutsuiBars 导致 countBars 残留风险 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 | Theta 终审+一审 | 补充 SetTestSecret(1) 默认强制 isSec 始终为真的说明 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 汇总表 | Theta 终审+一审 | 补充 UNIT_DIED 行至 isSec 汇总表 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审+一审 | 修正 specRole 引用（Fuyutsui > main.lua > GetCharacterSpecInfo；Fuyutsui > main.lua > updatePlayerSpecInfo） |
| 2026-05-30 | Iota | 物品状态为什么也算 block | Theta 终审+一审 | 扩充 value=1 歧义描述为四条路径（含无冷却路径） |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审+一审 | 补充 SetTestSecret(1) 导致专用资源分支默认不可达的注释 |
| 2026-05-30 | Iota | 法术失败 | Theta 终审+一审 | 补充 failedSpell/failedSpellId/failedSpellTimer 三个模块级局部变量说明 |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审 | 修正 SetTestSecret(1) 使 isSec 始终为真的错误结论，说明 UnitPower 简单整数不受保护，specialPowerMap 分支正常执行 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 | Theta 终审 | 修正 SetTestSecret(1) 调用位置（模块级而非 OnEnable）及语义描述（仅受保护类别返回真） |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 更正 updateIndex 停滞风险：正常流程中可触发（队员退队/下线），删除「正常流程中不会触发」断言 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 新增 IterateGroupMembers 队伍/团队模式下玩家自身包含规则差异说明 |
| 2026-05-30 | Iota | 有效性如何计算 | Theta 终审 | 补充 updatePlayerMounted() 在初始化时先于 updateShapeshiftForm() 调用导致双重失效 |
| 2026-05-30 | Iota | 施法、引导和蓄力 | Theta 终审 | 扩展 EMPOWER_STOP 条件反转为完整控制流分析（两个 unitTarget 分支对比 CHANNEL_STOP） |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 补充 countBars G 通道编码 -1 偏移解码规则及 Python 端 `_dict_value_from_raw_g` 转换公式 |
| 2026-05-30 | Iota | 生命值 | Theta 终审 | 补充 creatColorCurveScaling b>100 分支的两控制点曲线及入径（inComingHeals > healAbsorb） |
| 2026-05-30 | Iota | 职业专精额外 block 字段 | Theta 终审 | 补充 ClassBlocks powerType 为死配置说明（不被 loadPlayerBlocks/updatePlayerPowerType 消费） |
| 2026-05-30 | Iota | 全文 | Theta Iota | 将行号引用替换为调用链定位符（文件名 > 函数名 > 子函数名格式） |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审 | 升级"容易误解的分支细节"为显式警告段，列出受影响职业，补充 UnitPower 非受保护类别不确定性说明 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 修正路径(1)countBars 描述：在 SetTestSecret(1) 下 ClearAllFuyutsuiBars 为死代码，两条路径均无法正确清理 |
| 2026-05-30 | Iota | 职业专精额外 block 字段 | Theta 终审 | 补充死亡骑士鲜血专精 step 48 冲突实例（脓疮毒镰2/枯萎凋零） |
| 2026-05-30 | Iota | 写 mod 时要注意 | Theta 终审 | 补充法师冰霜专精 Lua block index 与 config step 偏移 1 的具体实例 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 | Theta 终审 | 补充 SetTestSecret(1) 额外设置 scriptErrors 和 doNotFlashLowHealthWarning |
| 2026-05-30 | Iota | 刷新频率 | Theta 终审 | 补充英雄天赋像素在 PLAYER_ENTERING_WORLD 时也被刷新，修正"初始化一次"表述 |
| 2026-05-30 | Iota | Python 端的结构 | Theta 终审 | 补充背景色块静态性质说明及旧 countBars 背景编码永久残留结论 |
| 2026-05-30 | Iota | Lua 内部但未直接输出的玩家状态 | Theta 终审 | 补充 SPELL_UPDATE_USES addon 级空函数体冗余注册说明 |
| 2026-05-30 | Iota | 队伍状态 | Theta 终审 | 补充 falseValueBlack 在 inRange 为假时写入职责像素的底层证据 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 | Theta Iota | 添加 SetTestSecret(1) 对事件参数 spellID 影响的不确定性标注；区分事件参数 spellID 与 API 返回 spellID 的本质差异 |
| 2026-05-30 | Iota | Python 端的结构 | Theta Iota | 为 ClearAllFuyutsuiBars 死代码推断附加不确定性说明，指出前提未经确认 |
| 2026-05-30 | Iota | Lua 内部但未直接输出的玩家状态 | Theta Iota | 补充 SPELL_UPDATE_CHARGES 冗余注册说明；顺带提及 SPELL_RANGE_CHECK_UPDATE 和 ACTION_RANGE_CHECK_UPDATE 空函数注册 |
| 2026-05-30 | Iota | 生命值 | Theta Iota | 补充 UNIT_HEAL_PREDICTION 对队伍成员不对称行为（仅检测死亡不刷新血量像素） |
| 2026-05-30 | Iota | 队伍状态 | Theta Iota | 为 updateIndex 停滞风险补充执行频率上下文（约 60 次/秒 OnUpdate 高频段） |
| 2026-05-30 | Iota | 敌人人数 | Theta Iota | 为 testEncounter 示例添加 encounterID 与 bossID 映射表输入键的概念区分 |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta Iota | 补充 UNIT_POWER_UPDATE 仍调用 updatePlayerPower 但不产生像素更新的说明 |
| 2026-05-30 | Iota | 配置开关状态 | Theta Iota | 补充输出模式与一键辅助字段独立机制说明（/fu dpsmode 与 C_AssistedCombat 无联动） |
| 2026-05-30 | Iota | 基础状态字段 — 移动行 | Theta 终审 | 补充 updatePlayerMoving() 写入移动状态前先无条件置 drinkStatus=false，影响有效性合成 |
| 2026-05-30 | Iota | 有效性如何计算 | Theta 终审 | 补充 PLAYER_STOPPED_MOVING 触发 drinkStatus=false，此联动为设计选择而非逻辑必然 |
| 2026-05-30 | Iota | 能量值和职业资源 | Theta 终审 | 补充 MAELSTROM 至受影响资源类型列表，补充元素/增强萨满漩涡主资源说明 |
| 2026-05-30 | Iota | Lua 内部但未直接输出的玩家状态 | Theta 终审 | 补充 ENCOUNTER_TIMELINE_EVENT_ADDED/REMOVED/STATE_CHANGED 冗余注册说明 |
| 2026-05-30 | Iota | 防御光环是特殊例外 | Theta 终审 | 补充 issecretvalue(aura) 在受保护场景中过滤防御光环详情 |
| 2026-05-30 | Iota | 防御光环是特殊例外 | Theta 终审 | 补充 GetDefensiveAuraInstanceID 非 player 直接返回及 GetDefensiveAuraDuration 硬编码 player 的扩展性约束 |
| 2026-05-30 | Iota | 目标类型 | Theta 终审 | 补充 dispelAbilities[11] 流血驱散空条目边缘情况说明 |
| 2026-05-30 | Iota | 生命值 | Theta 终审 | 补充 UNIT_HEAL_PREDICTION 对队伍成员引入最多 1 帧延迟 |
| 2026-05-30 | Iota | 修订记录 | Theta 终审 | 将行号引用替换为调用链定位符 |
| 2026-05-30 | Iota | 能量值和职业资源 — EnumPowerType 映射表 | Theta 最终审校 | 标注 BURNING_EMBERS=14 和 DEMONIC_FURY=15 为历史遗留条目 |
| 2026-05-30 | Iota | 敌人人数 — state.mapID 更新来源 | Theta 最终审校 | 补充 ZONE_CHANGED_INDOORS 为 state.mapID 第三个更新来源 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 — isSec 拦截汇总表 | Theta 最终审校 | 新增 SPELL_UPDATE_COOLDOWN 行，说明 isSec(spellID) 跳过 updateAuraBySpellCooldown |
| 2026-05-30 | Iota | 刷新频率 — 备注说明 | Theta 最终审校 | 补充一键辅助在 updatePlayerBlocks 初始化时也被调用一次 |
| 2026-05-30 | Iota | 施法、引导和蓄力 — STOP 事件丢失风险 | Theta 最终审校 | 补充 castTargetUnit/castTargetName/castTargetIndex 在 STOP 事件丢失时也携带过期值 |
| 2026-05-30 | Iota | 能量值和职业资源 — 受影响职业列表 | Theta 最终审校 | 补充恶魔猎手（怒意/痛苦）至受影响职业列表 |
| 2026-05-30 | Iota | 目标类型 | Theta 最终定稿 | 修正 dispelAbilities 表示例中的错误法术 ID，将 528（实际位于 offensiveDispelAbilities）替换为 dispelAbilities[1] 中的 527、4987、88423 |
| 2026-05-30 | Iota | 生命值 | Theta 最终定稿 | 修正 UNIT_HEAL_PREDICTION 延迟描述：从"最多 1 帧"改为轮转机制准确表述（N-1 帧，30 人团队最多约 29 帧/483ms） |
| 2026-05-30 | Iota | 职业专精额外 block 字段 — 死亡骑士 step 冲突 | Theta 终审修正 | 修正数据流向描述：脓疮毒镰2与枯萎凋零共享 step 48，Python 均从 row_data[48]（Lua index 48）读取，枯萎凋零字段实际包含脓疮毒镰2数值；缺少 step 49 意味着 Lua index 49 的真实枯萎凋零值不被任何 Python 字段读取 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 — 汇总表 SPELL_UPDATE_COOLDOWN 行 | Theta 终审修正 | 修正函数列为 `updateAuraBySpellCooldown()` 所在的事件处理器，移除与 `updateDrinkStatus` 的错误关联 |
| 2026-05-30 | Iota | 受保护值(isSec)对事件链的影响 — 汇总表后 | Theta 终审修正 | 新增注释说明 `Fuyutsui.noSecretAuras` 表已定义但无运行时代码消费，isSec 拦截完全由 WoW 内置 `issecretvalue()` 驱动 |
