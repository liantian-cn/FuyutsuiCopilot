# 敌对光环

本文只讨论敌对单位身上的光环。Buff 是增益，Debuff 是减益，Aura 是二者统称。用户关心的是“玩家释放到敌人身上的 Debuff”，例如当前目标身上的持续伤害、易伤、斩杀标记、层数类 Debuff 等。

先给结论：按当前源码，Fuyutsui 没有把“当前敌对目标身上的玩家 Debuff”读取并传给 Python。它有读取当前目标、读取 Aura、过滤 `sourceUnit == "player"` 的零散能力，但这些能力没有组成一条“敌对目标 Debuff -> 顶部像素 -> Python `state_dict`”链路。

## 能力边界

Fuyutsui 现在和敌对目标相关的主链路是“目标是否有效、能否攻击、距离、生命值、施法、引导、目标类型”，而不是敌对 Debuff。

现有敌对目标信息大致包括：

- `PLAYER_TARGET_CHANGED` 时调用 `updateTargetFullInfo()`，更新目标类型、死亡状态、生命值。
- `OnUpdate()` 每帧调用 `updateTargetCastingInfo()` 和 `updateTargetChannelInfo()`，读取 `target` 的施法和引导。
- 距离变化时通过 `updateTargetRangeBlock()` 写入 `目标距离`。
- `目标类型` 通过 `getTargetDispelType()` 写入像素，用于判断敌对目标是否有可进攻驱散的 Buff，或友方目标是否有可防御驱散的 Debuff。

这里最容易误判的是 `目标类型`。敌对目标时，`getTargetDispelType()` 使用：

```lua
filter = "HELPFUL|RAID_PLAYER_DISPELLABLE"
C_UnitAuras.GetUnitAuraInstanceIDs("target", filter, 1, 4)
C_UnitAuras.GetAuraDispelTypeColor("target", auraInstanceIDs[1], target.enemyCurve)
```

也就是说，敌对目标路径读取的是敌人身上的可驱散增益 Buff，例如法术增益或激怒；它不是读取玩家施放在敌人身上的 `HARMFUL|PLAYER` Debuff。

## 当前为什么不能判断敌对 Debuff

要让 Python 逻辑判断“目标身上是否有玩家 Debuff”，至少需要四段链路同时存在：

1. Lua 插件端保存当前目标的 Debuff 状态。
2. Lua 插件端把 Debuff 的持续时间、层数或存在状态写入顶部像素。
3. Python `config.yml` 为这些像素定义字段名和 `step`。
4. Python 职业逻辑读取这些字段。

当前源码缺少这条链路：

- `Fuyutsui/class/*.lua` 没有为“敌对目标 Debuff”定义专用 `type` 或像素输出项。
- `Fuyutsui/main.lua` 的 `loadPlayerBlocks()` 只把 `type = "aura"` 放进 `blocks.auras`，这条路径服务的是 `Fuyutsui/core/auras.lua` 的玩家逻辑光环，不是目标真实 Debuff。
- `UNIT_AURA` 虽然能收到单位光环变化，但后续只处理 `group[unit]` 存在的单位。当前目标 `"target"` 不在 `group` 表里时会直接返回。
- `Fuyutsui/Fuyutsui/config.yml` 没有目标 Debuff 字段，Python 端自然不会生成对应的 `state_dict` 值。

关键判断点在 `UNIT_AURA`：

```lua
function Fuyutsui:UNIT_AURA(_, unit, info)
    self:GetDefensiveAuraInstanceID(unit, info)
    local obj = group[unit]
    if not obj then return end
    ...
end
```

如果 `unit == "target"`，但目标不是队伍表里的单位，`group[unit]` 为空，函数会返回。因此当前目标身上的 Debuff 即使触发了 `UNIT_AURA`，也不会进入 Fuyutsui 的已保存光环表。

## 现有 `UNIT_AURA` 实际服务谁

`UNIT_AURA` 当前主要服务队伍成员光环。它维护的是 `group[unit].aura`，用于治疗逻辑判断队友身上的玩家施放光环，例如救赎、真言术：盾、回春、生命绽放等。

新增光环时：

```lua
if not isSec(v.spellId) and v.sourceUnit == "player" then
    obj.aura[v.auraInstanceID] = v
end
```

更新光环时：

```lua
local aura = C_UnitAuras.GetAuraDataByAuraInstanceID(unit, v)
if aura and not isSec(aura.spellId) and aura.sourceUnit == "player" then
    obj.aura[aura.auraInstanceID] = aura
end
```

这说明 Fuyutsui 确实会过滤“玩家释放的光环”，但这条过滤在当前实现中挂在队伍单位缓存上，不挂在敌对目标缓存上。

## 持续时间如何变化

敌对目标 Debuff 当前没有实现，所以没有“目标 Debuff 持续时间随技能改变”的现成输出。

但队伍光环路径展示了 Fuyutsui 对真实 Aura 持续时间的处理方式：

1. `UNIT_AURA` 的 `addedAuras` 把新增光环对象保存到 `group[unit].aura`。
2. `updatedAuraInstanceIDs` 发生时，用 `C_UnitAuras.GetAuraDataByAuraInstanceID(unit, auraInstanceID)` 重新取一遍 Aura 数据并覆盖缓存。
3. `removedAuraInstanceIDs` 发生时，从缓存里删除。
4. `OnUpdateUnitAura()` 每 0.2 秒遍历配置的光环 spellId，用 `C_UnitAuras.GetAuraDuration(unit, auraInstanceID)` 取得持续时间对象，再用 `EvaluateRemainingDuration(curve255)` 把剩余时间映射到 0-255 的 B 通道。

这套机制的重点是：持续时间变化不靠 Python 推断，也不靠技能名后缀推断，而是等 WoW 的 Aura 实例更新，然后重新读取该 `auraInstanceID` 的真实持续时间。

如果未来要实现敌对目标 Debuff，合理做法也是使用类似方式：为 `"target"` 建立单独缓存，在 `UNIT_AURA` 里处理 `unit == "target"`，过滤 `aura.sourceUnit == "player"` 和需要的 spellId，然后用 `GetAuraDuration("target", auraInstanceID)` 输出剩余时间。

## 层数如何变化

敌对目标 Debuff 当前没有层数输出。

现有真实 Aura 队伍路径也基本不输出 Aura 的层数。`C_UnitAuras.GetAuraDataByAuraInstanceID()` 返回的 Aura 数据里通常会有 `applications` 之类的层数字段，但当前 `OnUpdateUnitAura()` 只读取持续时间，不读取层数：

```lua
local duration = C_UnitAuras.GetAuraDuration(unit, maxAura.auraInstanceID)
```

唯一容易被误认为“层数”的是德鲁伊的 `rejuv`：

```lua
local rejuvCount = getRejuvCount(unit)
self:CreatTexture(index, rejuvCount / 255)
```

它不是同一个 Aura 的层数，而是统计同一队友身上有几个回春相关 spellId，例如 `774` 和 `155777`。这是“匹配到的光环数量”，不是 Debuff stack。

如果未来要输出敌对 Debuff 层数，需要显式读取 Aura 数据里的层数字段，并单独分配一个像素字段。不能指望 Fuyutsui 自动根据字段名后缀“层数”或“充能”判断读取方式。

## 像素与 bar

当前敌对 Debuff 没有像素输出，所以不存在“敌对 Debuff 持续时间和层数是否是两个像素”的现成答案。

从现有架构看，如果按 Fuyutsui 现有风格扩展，通常会是：

- 持续时间：一个顶部第一行普通像素，B 通道表示 0-255 秒。
- 层数：另一个顶部第一行普通像素，B 通道表示整数层数。
- 存在状态：也可以用一个顶部第一行普通像素，0 表示无，非 0 表示有。

`countBars` 不是 Aura 层数的默认方案。它在 `Fuyutsui/core/block.lua` 里用于 `CreateAutoLayoutBar()`，当前服务的是技能充能或施法次数，例如 `valueType = "charge"`、`valueType = "castCount"`。Python 端只有字段写成 `step: bar` 并指定 `bar` 下标时才会读第二行 bar 数据。

因此，“层数是不是 bar”不能靠名字判断。只有 Lua 端创建了 `countBars`，并且 Python `config.yml` 字段写了 `step: bar`，它才是 bar。敌对 Debuff 当前没有这样的配置。

## 与玩家逻辑光环的区别

`Fuyutsui/core/auras.lua` 里的 `addAuras`、`updateAuras`、`removeAuras` 是手写状态机。它通过技能成功、冷却更新、图标变化、屏幕提示等事件推导玩家自身 Buff、触发、高亮、层数等逻辑状态。

这套状态机不是敌对目标 Debuff 扫描器：

- 它不遍历 `"target"` 的 `UnitAura`。
- 它不保存 `auraInstanceID`。
- 它不检查 `sourceUnit == "player"`。
- 它按手写 spellId 和事件修改 `Fuyutsui.Auras[auraName]`。

所以不能把玩家光环文档里的 `type = "aura"`、`auraName`、`showKey` 直接理解成“目标 Debuff 读取方式”。那是另一条链路。

## 如果要补敌对 Debuff，缺什么

第三方 mod 作者如果想让 Fuyutsui 支持当前目标 Debuff，需要新增一条独立链路，而不是复用玩家光环目录里的结论：

1. 在 Lua 端建立 `target.auras` 或独立 `enemyAuras` 缓存。
2. 在 `PLAYER_TARGET_CHANGED` 时清空并全量扫描当前目标。
3. 在 `UNIT_AURA` 中处理 `unit == "target"`。
4. 只保存 `sourceUnit == "player"` 且 spellId 在白名单内的 Debuff。
5. 对 `addedAuras`、`updatedAuraInstanceIDs`、`removedAuraInstanceIDs` 都维护缓存。
6. 为每个需要输出的 Debuff 持续时间、层数或存在状态分配独立顶部像素。
7. 在 `config.yml` 增加对应字段，Python 职业逻辑再读取这些字段。

还要注意目标切换问题。敌对目标 Debuff 与队伍光环不同，`"target"` 这个 unit token 会不断指向不同单位。只靠 `auraInstanceID` 不够，还需要在目标切换时按 `UnitGUID("target")` 清理或重建缓存，否则容易把上一个目标的 Debuff 残留到新目标。

## 容易踩错的点

- `目标类型` 不是目标 Debuff，它只编码目标是否可攻击、是否有可驱散光环以及驱散类型。
- 敌对目标时，`目标类型` 看的是敌人 Buff；友方目标时，才看友方 Debuff。
- 当前 `UNIT_AURA` 的 `sourceUnit == "player"` 过滤存在，但它用于队伍单位缓存，不用于敌对目标。
- 当前队伍光环输出的是“某个队友身上是否有这些玩家光环，以及剩余多久”，不是敌人 Debuff。
- 层数不会因为字段名包含“层数”就自动读取；必须手写读取 Aura 的层数字段并手写像素输出。
- bar 也不会因为字段名包含“层数”就自动使用；只有 `step: bar` 才从第二行 bar 读取。
- 若目标 Debuff 来自宠物、守护者或分身，`sourceUnit == "player"` 可能不覆盖所有实际归属，需要单独验证。这一点当前源码没有处理。
- 如果一个 Debuff 会被技能刷新、延长、缩短或消耗层数，应该优先以 WoW 的 `UNIT_AURA` 更新结果为准，而不是只根据“我刚刚施放了某技能”在本地推断。
