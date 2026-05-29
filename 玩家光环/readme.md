# 玩家光环

本文只解释玩家自身相关的光环读取和传递。Buff 是增益，Debuff 是减益，Aura 是二者的统称。

Fuyutsui 里有两类容易混在一起的"光环"：

- 玩家逻辑光环：主要由 `Fuyutsui/core/auras.lua` 手写状态机维护，再通过玩家顶部像素传给 Python。这是职业逻辑里最常用的玩家 Buff、触发、高亮、层数数据来源。
- 真实 WoW Aura：通过 `C_UnitAuras` 读取游戏内单位身上的真实光环。玩家自身这里只看到少量特殊用途，例如"防御光环"。队伍成员光环也用 `C_UnitAuras`，但那属于队伍光环，不是本文主线。

## 总链路

玩家逻辑光环的链路是：

1. `Fuyutsui/core/auras.lua` 按职业 ID 建立 `Fuyutsui.Auras`。
2. 每个光环用中文键名保存状态，例如 `remaining`、`duration`、`expirationTime`、`count`。
3. `addAuras`、`updateAuras`、`removeAuras` 把"某个事件 + 某个 spellId"映射到要更新的光环。
4. `Fuyutsui/class/*.lua` 在职业块里用 `type = "aura"` 指定显示位置、`auraName` 和 `showKey`。
5. `main.lua` 的 `loadPlayerBlocks()` 把这些配置放入 `blocks.auras`。
6. `OnUpdate()` 每帧调用 `updateAura()` 计算剩余时间；每 0.2 秒调用 `updateAuraBlocks()` 写入顶部像素。
7. Python 端 `GetPixels.py` 读取顶部像素，再按 `config.yml` 的手写字段名和 `step` 生成 `state_dict`。

所以，Python 逻辑里读到的 `state_dict.get("圣光灌注")` 或 `state_dict.get("灌注层数")`，不是 Python 直接调用游戏 API 得到的，而是 Lua 插件先把逻辑光环状态编码成像素后传过来的。

## 逻辑光环不是自动扫描

`core/auras.lua` 不是一个"扫描玩家所有 Buff/Debuff"的通用模块。它是手写状态机。

一个典型光环包含这些字段：

```lua
["圣光灌注"] = {
    remaining = 0,
    duration = 15,
    count = 0,
    countMin = 0,
    countMax = 2,
    expirationTime = nil,
    addAuras = {
        [54149] = { event = e["法术冷却"], step = 2 },
    },
    updateAuras = {
        [19750] = { event = e["施法成功"], step = -1 },
        [275773] = { event = e["施法成功"], step = -1 },
    },
    removeAuras = {
        [54149] = { event = e["屏幕提示隐藏"] },
    },
}
```

这里的 `圣光灌注` 是手写键名；`54149`、`19750`、`275773` 也是手写 spellId。Fuyutsui 不会根据光环名字自动去 `UnitAura` 查询，也不会根据字段名后缀自动推导"持续时间"或"层数"。

## 事件驱动：索引表的加载时构建

`auras.lua` 定义了三张全局索引表 `addAuras`、`updateAuras`、`removeAuras`。文件底部的 `do...end` 块在插件加载时运行一次，遍历当前职业所有光环，把每个光环的 spellId 映射按 `event -> spellId -> auraName` 两级索引重新组织：

```lua
do
    Fuyutsui.Auras = auras[classId] or {}
    local function indexAura(target, auraName, auraData)
        for spellId, info in pairs(auraData) do
            local ev = info.event
            local byEvent = target[ev]
            if not byEvent then
                byEvent = {}
                target[ev] = byEvent
            end
            local bySpell = byEvent[spellId]
            if not bySpell then
                bySpell = {}
                byEvent[spellId] = bySpell
            end
            bySpell[auraName] = info
        end
    end

    for name, data in pairs(Fuyutsui.Auras) do
        if data.addAuras then
            indexAura(addAuras, name, data.addAuras)
        end
        if data.updateAuras then
            indexAura(updateAuras, name, data.updateAuras)
        end
        if data.removeAuras then
            indexAura(removeAuras, name, data.removeAuras)
        end
    end
end
```

这意味着运行时事件分发是 O(1) 的：收到 `SPELL_UPDATE_COOLDOWN` 事件后，`updateAuraBySpellCooldown(spellID)` 只要查 `addAuras[e["法术冷却"]][spellID]` 就能拿到所有受影响的 `{auraName -> info}` 映射，不需要遍历全职业的光环列表。

写 mod 时需要注意：如果你在游戏运行中通过热重载手段修改了 `auras` 表，但没有重新执行这个索引构建过程，新光环不会被事件系统发现。

## 光环字段详解

### 标准字段

| 字段 | 含义 |
|------|------|
| `remaining` | 当前剩余时间（每帧计算，用于像素输出） |
| `duration` | 默认持续时间，单位近似秒 |
| `expirationTime` | 绝对过期时间戳，由事件设置、每帧检查 |
| `count` | 当前层数 |
| `countMin` | 最小层数 |
| `countMax` | 最大层数 |

### `isIcon` 字段 — 基于图标覆盖的光环

少数光环不是基于时间的，而是基于技能图标是否被覆盖（override）。这类光环用 `isIcon` 字段：

```lua
["神圣军备"] = {
    remaining = 0,
    duration = 0,
    expirationTime = nil,
    isIcon = 0,
    addAuras = {
        [432459] = {
            event = e["图标改变"],
            overrideSpellID = 432472,
        },
    },
    removeAuras = {
        [432459] = {
            event = e["图标改变"],
            overrideSpellID = 432472,
        },
    },
}
```

`isIcon` 有三个状态值：

- `0`：图标未被覆盖（默认状态）
- `1`：图标被覆盖但覆盖法术 ID 不匹配（等待中）
- `2`：图标被覆盖且覆盖法术 ID 匹配（触发中）

核心机制通过 `updateAuraByIconMap()` 实现：调用 `C_Spell.GetOverrideSpell(spellID)` 检查当前覆盖法术 ID，如果与配置的 `overrideSpellID` 匹配则设置 `expirationTime`（若有 `duration`）并设 `isIcon = 2`；否则清除 `expirationTime` 并设 `isIcon = 1`。

使用 `isIcon` 的光环在 `showKey` 中可以写 `"isIcon"` 来把状态值输出给 Python。和 `remaining`、`count` 一样，`isIcon` 的值也经过 `v / 255` 写入像素的 B 通道。Python 端读到的 B 通道整数值分别是 0、1、2（因为 `0/255 ≈ 0`、`1/255 ≈ 0.0039`、`2/255 ≈ 0.0078`，量化后恰好对应 0、1、2）。Python 端可以据此区分"图标还没变化"（0）和"图标已变化但没激活"（1）以及"激活中"（2）。

`PLAYER_ENTERING_WORLD` 时，`updateAuraIconByEnteringWorld()` 会遍历所有 `e["图标改变"]` 下的 spellId 并调用 `updateAuraByIconMap()` 进行首次初始化。

已知使用 `isIcon` 的光环：圣骑士`神圣军备`、术士`魔典：邪能破坏者`（`isIcon = 1` 即初始就认为覆盖）。

### `name` 和 `spellId` — 多条目共享显示名

有时同一个概念的光环可能由多个不同的 spellId 触发（例如来自不同天赋或不同等级），但 Python 端只需要读一个字段名。此时可以用 `name` 和 `spellId` 让多个光环条目共享同一个显示名：

```lua
["脓疮毒镰"] = {
    name = "脓疮毒镰",
    spellId = 458123,
    remaining = 0,
    duration = 15,
    -- ...
},
["脓疮毒镰2"] = {
    name = "脓疮毒镰",
    spellId = 1241077,
    remaining = 0,
    duration = 25,
    -- ...
},
```

`name` 用于被 `Fuyutsui.Auras` 中其他光环引用（见武僧示例）；`spellId` 用于 Lua 内部查找。Python 端只看到职业块中配置的 `auraName`，不感知 `name`/`spellId` 的存在。

武僧的 `生生不息1`/`生生不息2`、萨满的 `飞旋之土`/`飞旋之水`、DK 的 `脓疮毒镰`/`脓疮毒镰2` 都使用了这种模式。

## 事件如何改变持续时间

持续时间的核心字段是：

- `duration`：默认持续时间，单位近似为秒。
- `expirationTime`：结束时间戳。
- `remaining`：当前剩余时间，给像素输出使用。

当相关事件触发时，Fuyutsui 会按事件类型找到对应 spellId 的映射：

- `SPELL_UPDATE_COOLDOWN` -> `updateAuraBySpellCooldown()`
- `UNIT_SPELLCAST_SUCCEEDED` -> `updateAuraBySuccess()`
- `SPELL_UPDATE_ICON` -> `updateAuraByIcon()`
- `COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED` -> `updateAuraBySpellOverride()`
- `SPELL_ACTIVATION_OVERLAY_SHOW/HIDE` -> 屏幕提示显示或隐藏
- `SPELL_ACTIVATION_OVERLAY_GLOW_SHOW/HIDE` -> 图标发光状态

新增或刷新光环时，逻辑会设置：

```lua
aura.expirationTime = GetTime() + duration
```

如果事件条目里写了 `duration`，优先使用事件自己的持续时间；否则使用光环默认 `duration`。例如武僧 `青龙之心`：

```lua
["青龙之心"] = {
    remaining = 0,
    duration = 4,
    expirationTime = nil,
    addAuras = {
        [443421] = { event = e["法术冷却"], duration = 4, },
        [116680] = { event = e["施法成功"], duration = 8 }, -- 氤氲之雾
    },
    -- ...
},
```

- 施放 `443421`（抚慰之雾的某个关联冷却）时，持续 4 秒（使用默认 `duration`）。
- 施放 `116680`（氤氲之雾）成功时，覆盖为 8 秒（事件条目的 `duration` 优先）。
- 同一个光环，不同技能触发可以有不同的持续时间。

之后 `updateAura()` 每帧检查 `expirationTime`：

- 当前时间还没到结束时间：`remaining = expirationTime - GetTime()`。
- 时间到了：清空 `expirationTime`，`remaining = 0`。
- 如果有层数，过期时也会把 `count` 归零或归到 `countMin`。

`updateAuraBlocks()` 每 0.2 秒把 `remaining` 写进顶部像素。因此 Python 读到的是经过像素量化后的整数值，不是完整浮点秒数。

### 发光高亮的轮询确认

`SPELL_ACTIVATION_OVERLAY_GLOW_SHOW` 和 `SPELL_ACTIVATION_OVERLAY_GLOW_HIDE` 的处理函数 `updateAuraByOverlayGlow()` 不是简单地根据事件类型打开/关闭光环，而是在收到事件后**额外调用 `C_SpellActivationOverlay.IsSpellOverlayed(spellID)` 进行二次确认**：

```lua
function Fuyutsui:updateAuraByOverlayGlow(spellID)
    local removeBySpell = removeAuras[e["图标发光隐藏"]]
    local map = removeBySpell and removeBySpell[spellID]
    if not map then return end
    local now = GetTime()
    local isSpellOverlayed = C_SpellActivationOverlay.IsSpellOverlayed(spellID)
    for auraName in pairs(map) do
        local aura = Fuyutsui.Auras[auraName]
        if aura then
            if isSpellOverlayed and aura.duration then
                aura.expirationTime = now + aura.duration  -- 还在发光，刷新时间
            else
                aura.expirationTime = nil  -- 确实不发光了，清除
            end
        end
    end
end
```

关键行为：
- 即使收到 `GLOW_HIDE` 事件，如果 `IsSpellOverlayed()` 仍然返回 `true`，光环的持续时间**会被刷新**而不是清除。
- 即使收到 `GLOW_SHOW` 事件，如果 `IsSpellOverlayed()` 返回 `false`，光环**不会激活**。

这是一种防御性设计：游戏有时会快速连续触发 SHOW/HIDE 事件（例如切换目标、UI 刷新），单纯跟随事件会导致光环状态抖动。通过额外调用 `IsSpellOverlayed()` 确认当前真实发光状态，保证光环状态与 UI 一致。

这类光环的 `duration` 通常设得较长（例如 15 秒），因为不需要严格计时——只要发光还在就持续激活。`removeAuras` 用 `e["图标发光隐藏"]` 事件，但实际是否清除取决于 `IsSpellOverlayed()` 的返回值。

使用此机制的光环：战士`斩杀高亮`、`英勇打击高亮`、`顺劈斩高亮`、`致死高亮`；恶魔猎手`无羁邪怒`。

### 屏幕提示事件

`SPELL_ACTIVATION_OVERLAY_SHOW` 和 `SPELL_ACTIVATION_OVERLAY_HIDE` 是独立的另一类 UI 事件。屏幕提示不像发光高亮那样做轮询确认，而是直接跟随事件设置/清除 `expirationTime`：

- `SHOW` 时通过 `updateAuraByActivationOverlayShow()` 设置光环过期时间（走 `applyAuraMapForSpellEvent`）。
- `HIDE` 时通过 `updateAuraByActivationOverlayHide()` 清除过期时间（走 `clearAurasFromRemoveMap`，`resetCount = false`，只清时间不清层数）。

屏幕提示与发光高亮的关键区别：

| 特性 | 发光高亮 | 屏幕提示 |
|------|---------|---------|
| 事件 | `GLOW_SHOW/HIDE` | `OVERLAY_SHOW/HIDE` |
| 二次确认 | 有（`IsSpellOverlayed()`） | 无 |
| 清除时重置层数 | 不适用（只用 removeAuras） | 否（`resetCount = false`） |

圣骑士`神圣意志`、`圣光灌注` 使用 `屏幕提示隐藏` 来清除光环。

### 法术覆盖事件

`COOLDOWN_VIEWER_SPELL_OVERRIDE_UPDATED` 在技能的覆盖法术 ID 变更时触发。`updateAuraBySpellOverride()` 检查新的 `overrideSpellID`：

- 如果 `overrideSpellID` 匹配事件条目中配置的 `overrideSpellID`，则设置/刷新 `expirationTime`。
- 如果不匹配，则清除 `expirationTime`。

这主要用于检测"同一个按钮位现在变成了另一个技能"的场景。萨满`风暴涌流图腾`使用 `[5394] = { event = e["图标改变"], overrideSpellID = 1267068 }` 来清除逻辑光环。

## 技能如何改变层数

层数的核心字段是：

- `count`：当前层数。
- `countMin`：最小层数。
- `countMax`：最大层数。
- `step`：某个事件对层数的增减。

规则在 `applyAuraMapForSpellEvent()` 和 `updateAuraMapForSpellEvent()` 里：

- `step > 0`：层数增加，最多到 `countMax`，同时刷新持续时间。
- `step < 0`：层数减少，最少到 `countMin`。
- 移除类事件如果要求重置层数，会把 `count` 设回 `countMin`。
- 光环过期后，`updateAura()` 会把层数清掉。

例如 `圣光灌注`：

- `54149` 触发时 `step = 2`，层数直接加到最多 2，并刷新 15 秒持续时间。
- 施放 `圣光闪现` 或 `审判` 成功时 `step = -1`，消耗 1 层。
- 屏幕提示隐藏时清掉持续时间，随后层数也会归零。

再例如 `风暴涌流图腾`：

- `1267089` 触发时 `step = 1`。
- `1267068` 施法成功时 `step = -1`。
- `5394` 的图标覆盖变化可以清掉这个逻辑光环。

如果事件条目里有 `castBar = true`，则 `UNIT_SPELLCAST_SUCCEEDED` 路径要求这次成功施法带读条 ID，避免瞬发或非读条事件误扣层数。

### `count = 0` 导致光环立即清除

`updateAura()` 中有一种反向因果关系：即使 `expirationTime` 尚未到期，如果 `count` 存在且 `<= 0`，光环就会被清除：

```lua
local expTime = info.expirationTime
if expTime then
    if info.count and info.count <= 0 then
        expTime = nil  -- 层数归零 → 立即视为过期
    end
    if expTime then
        -- 正常计算 remaining...
    else
        info.expirationTime = nil
        info.remaining = 0
        if info.count then info.count = 0 end
    end
else
    if info.remaining ~= 0 then info.remaining = 0 end
    if info.count and info.count ~= info.countMin then info.count = info.countMin end
end
```

这意味着：
- 如果某光环的 `countMin = 0`，且所有层数被消耗完（`count = 0`），`expirationTime` 会被立即忽略，光环清除。
- 即使持续时间还剩余很多秒，层数用完光环就消失。
- 这是故意的设计：层数类 Buff（如 `圣光灌注`）的有效期由"有时间 && 有层数"两者共同决定。

### `resetCount` 参数：不同事件不同清理策略

`clearAurasFromRemoveMap()` 的第二个参数 `resetCount` 控制是否在清除光环时重置层数：

```lua
function Fuyutsui:updateAuraBySpellCooldown(spellID)
    -- ...
    clearAurasFromRemoveMap(removeBySpell and removeBySpell[spellID], true)  -- resetCount = true
end

function Fuyutsui:updateAuraBySuccess(spellID, castBarID)
    -- ...
    clearAurasFromRemoveMap(removeBySpell and removeBySpell[spellID], true)  -- resetCount = true
end

function Fuyutsui:updateAuraByActivationOverlayHide(spellId)
    local removeBySpell = removeAuras[e["屏幕提示隐藏"]]
    clearAurasFromRemoveMap(removeBySpell and removeBySpell[spellId], false)  -- resetCount = false
end
```

| 调用路径 | `resetCount` | 行为 |
|----------|-------------|------|
| 冷却事件移除 | `true` | 清除 `expirationTime`，重置 `count` 到 `countMin` |
| 施法成功移除 | `true` | 同上 |
| 屏幕提示隐藏 | `false` | 只清除 `expirationTime`，不动 `count` |

`resetCount = false` 的原因：屏幕提示隐藏是一个 UI 事件，可能因为游戏内部 UI 刷新而触发（不意味着 Buff 真正消失）。如果此时重置层数，可能导致层数信息丢失。实际的层数归零在 `updateAura()` 的每帧检查中发生（见上一节）。

### `castBar = true` 防止瞬发误扣层数

当事件条目设置 `castBar = true` 时，`applyAuraMapForSpellEvent()` 和 `updateAuraMapForSpellEvent()` 要求 `castBarID` 非空才会执行：

```lua
if aura and ((not info.castBar) or castBarID) then
    -- 只有两种情况下执行：
    -- 1. 事件条目没有 castBar 要求（即瞬发或冷却类事件）
    -- 2. 事件条目有 castBar 要求，且当前施法确实有读条 ID
end
```

`UNIT_SPELLCAST_SUCCEEDED` 事件的 `castBarID` 参数在瞬发施法时为 `nil`，在读条施法时为非 `nil`。设置 `castBar = true` 意味着："只有这次施法确实是读条施法（不是瞬发）时，才消耗层数"。

萨满`潮汐奔涌`使用此机制：

```lua
removeAuras = {
    [77472] = { event = e["施法成功"], step = -1, castBar = true },
},
```

`77472`（治疗波）需要读条。如果因为某种原因（例如自然迅捷）治疗波变成瞬发，`castBarID` 为 `nil`，不会消耗 `潮汐奔涌` 层数。

### `addAuras` 与 `updateAuras` 的区别

两个函数几乎相同，但有一个关键区别。在 `updateAuraMapForSpellEvent()`（`updateAuras` 路径）中：

```lua
if aura.count and info.step then
    -- 有 count 和 step 时，只处理层数
    if info.step > 0 then
        aura.expirationTime = now + aura.duration
        aura.count = math.min(aura.countMax, aura.count + info.step)
    else
        aura.count = math.max(aura.countMin, aura.count + info.step)
    end
elseif aura.duration then
    -- 没有 count/step 时，才刷新持续时间
    aura.expirationTime = now + aura.duration
end
```

而 `applyAuraMapForSpellEvent()`（`addAuras` 路径）中：

```lua
if info.duration then
    aura.expirationTime = now + info.duration
elseif aura.duration then
    aura.expirationTime = now + aura.duration
end
if aura.count and info.step then
    -- 处理层数...
end
```

区别在于：`addAuras` 总是先刷新持续时间再处理层数（两个逻辑独立）；`updateAuras` 在没有层数时才刷新持续时间。这反映了它们的预期用途：`addAuras` 用于"获得/激活光环"，`updateAuras` 用于"消耗/修改已有光环"。

## 持续时间和层数是不是两个像素

如果同一个逻辑光环既要给 Python 读持续时间，又要给 Python 读层数，通常会配置成两个普通顶部像素。

以圣骑士为例：

```lua
[26] = { type = "aura", name = "圣光灌注", auraName = "圣光灌注", showKey = "remaining" },
[27] = { type = "aura", name = "灌注层数", auraName = "圣光灌注", showKey = "count" },
```

这两个像素都指向同一个 `auraName = "圣光灌注"`：

- 第 26 格输出 `remaining`。
- 第 27 格输出 `count`。

`updateAuraBlocks()` 的输出方式相同，都是：

```lua
self:CreatTexture(k, v / 255)
```

也就是说，持续时间和层数本身不是两种不同格式；它们只是同一个逻辑光环的两个字段，被写到两个不同的顶部像素。

### 颜色编码与精度

`CreatTexture(k, v / 255)` 将原始值直接除以 255，映射到 `SetColorTexture(0, k/255, v/255, 1)` 的 B 通道。Python 端读取时 B 通道是 0-255 的整数值。

这意味着：

- 对于 `remaining`：原始值是秒级的浮点数（如 7.3 秒），写入时变成 `7.3 / 255 ≈ 0.0286`，但是 `SetColorTexture` 的浮点参数最终在屏幕上还是被量化到 0-255 的整数颜色通道。Python 读到的 B 通道值是 `math.floor(v)`（取整后的结果），精度约为 1 秒/单位。
- 对于 `count`：原始值是小整数（如 2 层），写入时 `2 / 255 ≈ 0.0078`，量化后 Python 读到的就是 2。层数通常较小（≤10），所以传层数没有问题。

对于持续时间超过 255 秒的光环（极少见），`v / 255 > 1.0`，`SetColorTexture` 会 clamp 到 1.0，Python 读到 255。这意味着 255 秒是单像素通道能表示的最大剩余时间。如果需要表示更长的持续时间，需要另外的处理方式（目前源码中没见到超过 255 秒的光环）。

### 更新频率差异

不同环节的更新频率不一致，需要注意：

| 环节 | 频率 | 说明 |
|------|------|------|
| `updateAura()` | 每帧（~60Hz） | 用 `GetTime()` 计算 `remaining` |
| `updateAuraBlocks()` | 每 0.2 秒（5Hz） | 把 `remaining` 写入顶部像素 |
| Python `get_info()` | 约每 0.2 秒 | 截图并解析像素 |

这意味着：
- Python 端看到的持续时间最多有 0.2 秒的延迟。
- 在同一帧内，`updateAura()` 先于 `updateAuraBlocks()` 执行，所以写入像素的 `remaining` 是最新计算值。
- 由于 Python 轮询和 Lua 写像素的周期大致相同但不严格同步，边界情况下可能读到上一轮的值（额外 ~0.2 秒延迟）。

写 mod 时，光环持续时间适合秒级判断（"有 buff 吗？"），不适合需要毫秒精度的操作。

## 层数是不是 bar

不一定。是否是 bar 只看 Python 端 `config.yml` 的 `step`。

普通顶部像素写法：

```yaml
圣光灌注: {step: 26, type: "int" }
灌注层数: {step: 27, type: "int" }
```

这表示 Python 从顶部第一行的第 26、27 个像素读取。

bar 写法：

```yaml
激流层数: {step: bar, bar: 1, type: "int"}
治疗之泉图腾层数: {step: bar, bar: 2, type: "int"}
```

这表示 Python 不读顶部普通像素，而是读第二行 `countBars`。`countBars` 由 `CreateAutoLayoutBar()` 创建，常用于技能充能或施法次数，例如 `valueType = "charge"` 或 `valueType = "castCount"`。

所以，"XX层数"只是字段名，不代表来源一定是 bar。判断标准只有配置：

- `step: 27` 这种整数：读顶部普通像素。
- `step: bar`：读第二行 bar。

还要注意，有些职业文件里同时存在 `type = "aura"` 的层数像素和 `countBars`，但 Python 最终读哪个，完全由 `config.yml` 决定。写 mod 时要把 Lua 像素位置、`config.yml` 字段、Python 逻辑使用的字段名一起核对。

### `countBars` 的编码方式

`countBars` 位于屏幕顶部第二行（`TOPLEFT, 0, -2`），与顶部第一行的普通像素用不同的编码方案。Lua 端通过 `CreateAutoLayoutBar()` 创建每条 bar，Python 端通过 `scan_screen_data()` 的左边界扫描（`scan_row_data_red_white_markers`）读取。

#### 标记色与分隔色

每条 bar 由一组颜色像素组成，结构如下：

| 颜色 (RGB) | 作用 |
|---|---|
| `(1, 0, 0)` — 红色 | 段起始标记（与后面的 `(1, 1, 0)` 配对） |
| `(1, 1, 0)` — 红黄色 | 段开始确认（紧跟红色之后，表示"这是一个新段"） |
| `(255, 255, 255)` — 白色 | 值分隔符（白色像素后面的第一个非白色像素是实际值） |
| `(200, 200, 200)` — 灰色 | 行终止标记（遇到后停止扫描该行） |

#### 值的编码

Lua 端为每个条目创建背景纹理时：

```lua
tex:SetColorTexture(1 / 255, currentRelativeIndex / 255, 0, 1)
```

- R 通道始终为 `1/255`（即 R=1）
- G 通道为相对索引（`currentRelativeIndex / 255`）
- B 通道始终为 0

Python 端读取时，取白色分隔符后面第一个非白色像素的 G 通道值，再减 1 得到实际值：

```python
def _dict_value_from_raw_g(raw_g):
    return max(0, int(raw_g) - 1)
```

例如：G 通道值为 3 时，实际 bar 值为 2（表示当前有 2 层充能）。

#### 多条 bar 的排列

`CreateAutoLayoutBar()` 为每条 bar 分配一段连续像素空间：

```lua
local startIndex = nextAvailableIndex
local barWidth = maxValue * BAR_CONFIG.width
nextAvailableIndex = startIndex + maxValue + 3  -- +maxValue 为值区域，+3 为灰色终点+间隔
```

每条 bar 的结构是：`[红色(1,0,0)] [红黄色(1,1,0)] [值像素 × maxValue] [灰色终点(200,200,200)]`。

多条 bar 按创建顺序从左到右排列，共享一个灰色终点纹理（每次创建新 bar 时移动到新位置）。Python 端通过 `seg_idx`（段索引）区分不同 bar，`bar_data[1]` 对应 `config.yml` 中 `bar: 1` 的字段，`bar_data[2]` 对应 `bar: 2`，依此类推。

#### `countBars` 与顶部普通像素的区别

| 特性 | 顶部普通像素 | countBars |
|---|---|---|
| 位置 | 第一行 | 第二行（y=-2） |
| 编码 | G=索引, B=值 | 红/红黄标记 + 白色分隔 + G 通道值-1 |
| 用途 | 持续时间、层数、isIcon | 技能充能、施法次数 |
| 刷新方式 | `updateAuraBlocks()` 每 0.2 秒 | WoW 事件驱动（`SPELL_UPDATE_CHARGES` 等） |
| 读取方式 | `row_data[step]` | `bar_data[bar]` |

## 真实 Aura API 的位置

Fuyutsui 也确实使用了 `C_UnitAuras`，但它不是玩家逻辑光环的主链路。

玩家自身相关的特殊路径是"防御光环"：

- `UNIT_AURA` 触发时，`GetDefensiveAuraInstanceID()` 只处理 `unit == "player"`。
- 它读取 `C_UnitAuras.GetBuffDataByIndex(unit, i, "HELPFUL|BIG_DEFENSIVE")` 的前两个增益。`"BIG_DEFENSIVE"` 是 WoW 的光环分类标签，指大型防御技能（如盾墙、圣佑术等）。
- 找到后保存 `auraInstanceID`。
- `GetDefensiveAuraDuration()` 再用 `C_UnitAuras.GetAuraDuration("player", auraInstanceID)` 取剩余时间。

防御光环的时间映射使用 `C_CurveUtil` 而不是简单的 `/255`：

```lua
local curve255 = Fuyutsui:creatColorCurve(255, 255)
-- creatColorCurve 内部：
-- curve:AddPoint(0, CreateColor(0, 0, 0, 1))
-- curve:AddPoint(255, CreateColor(0, 0, 255/255, 1))
-- 即：0 秒 → B=0，255 秒 → B=1（量化后为 255）

local duration = C_UnitAuras.GetAuraDuration("player", DefensiveAuraInstanceID)
local auraduration = duration:EvaluateRemainingDuration(curve255)
local _, _, b = auraduration:GetRGB()
self:CreatTexture(blocks.state["防御光环"], b)
```

`EvaluateRemainingDuration(curve255)` 把剩余时间（0-255 秒）映射到一条线性颜色曲线上，输出一个颜色对象。取其 B 通道值后直接写入像素。这和逻辑光环的 `v / 255` 效果相同（都是把秒数映射到 0-255 的 B 通道），但走了 WoW 的曲线求值 API。

队伍光环路径也会用 `C_UnitAuras`：

- `updateUnitFullAura(unit)` 读取 `PLAYER|HELPFUL|RAID_IN_COMBAT`。
- `UNIT_AURA` 增量更新时要求 `aura.sourceUnit == "player"`。
- `OnUpdateUnitAura()` 根据 `blocks.groups.auras` 把队伍成员身上的指定光环持续时间写入队伍像素。

这条链路用于判断队友身上的玩家施加光环，例如治疗职业给队友的 HoT、盾、道标等。它不是本文说的职业玩家逻辑光环，但容易和 `Fuyutsui.Auras` 混淆。

## 写 mod 时要注意

- 字段名全部是手写接口。`XX`、`XX层数`、`XXBuff` 不会被自动关联。
- `auraName` 必须能在 `Fuyutsui.Auras` 里找到；找不到时该像素输出 0。
- `showKey` 必须是该光环真实存在的字段，例如 `remaining`、`count`、`isIcon`。
- Lua 职业文件的像素索引必须和 Python `config.yml` 的 `step` 对齐。
- 如果 Python 字段配置成 `step: bar`，它读的是 `countBars`，不是 `updateAuraBlocks()` 写出的普通光环像素。
- `issecretvalue` 或 `isSec` 会过滤受保护值，相关 spellId 或 aura 数据可能被跳过。
- 逻辑光环多数是事件推导状态，和游戏真实 Buff/Debuff 图标可能存在短暂差异；要靠事件映射补齐刷新、消耗和清除路径。
- 顶部像素只有 0-255 的整数通道。持续时间适合传秒级判断，不适合传高精度计时。
- 新增光环除了在 `auras.lua` 中定义光环状态和事件映射外，还需要在职业 Lua 文件的 `ClassBlocks` 中添加 `type = "aura"` 的像素输出配置，以及在 Python `config.yml` 中添加对应的 `step` 字段映射。三者缺一不可。
- 如果光环使用 `isIcon` 字段，注意在 `showKey` 中使用 `"isIcon"` 而不是 `"remaining"`；`isIcon` 的值 0/1/2 也经过 `v / 255` 写入像素，Python 端读到的 B 通道整数值恰好是 0、1、2。
- 不要在 `addAuras` 和 `updateAuras` 中对同一个 (spellId, event) 组合做重复映射；如果某个技能既"获得"又"更新"同一个光环，应该只放在一张映射表中，然后在对应的 `applyAuraMapForSpellEvent` 或 `updateAuraMapForSpellEvent` 中处理。
- `updateAura()` 每帧执行，其中的计算开销会随光环数量线性增长。如果一个职业定义了非常多的逻辑光环（>50），理论上会影响帧率。目前各职业的光环数量都在合理范围内（≤20）。
