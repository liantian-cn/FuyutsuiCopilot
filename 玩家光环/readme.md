# 玩家光环

本文只解释玩家自身相关的光环读取和传递。Buff 是增益，Debuff 是减益，Aura 是二者的统称。

Fuyutsui 里有两类容易混在一起的“光环”：

- 玩家逻辑光环：主要由 `Fuyutsui/core/auras.lua` 手写状态机维护，再通过玩家顶部像素传给 Python。这是职业逻辑里最常用的玩家 Buff、触发、高亮、层数数据来源。
- 真实 WoW Aura：通过 `C_UnitAuras` 读取游戏内单位身上的真实光环。玩家自身这里只看到少量特殊用途，例如“防御光环”。队伍成员光环也用 `C_UnitAuras`，但那属于队伍光环，不是本文主线。

## 总链路

玩家逻辑光环的链路是：

1. `Fuyutsui/core/auras.lua` 按职业 ID 建立 `Fuyutsui.Auras`。
2. 每个光环用中文键名保存状态，例如 `remaining`、`duration`、`expirationTime`、`count`。
3. `addAuras`、`updateAuras`、`removeAuras` 把“某个事件 + 某个 spellId”映射到要更新的光环。
4. `Fuyutsui/class/*.lua` 在职业块里用 `type = "aura"` 指定显示位置、`auraName` 和 `showKey`。
5. `main.lua` 的 `loadPlayerBlocks()` 把这些配置放入 `blocks.auras`。
6. `OnUpdate()` 每帧调用 `updateAura()` 计算剩余时间；每 0.2 秒调用 `updateAuraBlocks()` 写入顶部像素。
7. Python 端 `GetPixels.py` 读取顶部像素，再按 `config.yml` 的手写字段名和 `step` 生成 `state_dict`。

所以，Python 逻辑里读到的 `state_dict.get("圣光灌注")` 或 `state_dict.get("灌注层数")`，不是 Python 直接调用游戏 API 得到的，而是 Lua 插件先把逻辑光环状态编码成像素后传过来的。

## 逻辑光环不是自动扫描

`core/auras.lua` 不是一个“扫描玩家所有 Buff/Debuff”的通用模块。它是手写状态机。

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

这里的 `圣光灌注` 是手写键名；`54149`、`19750`、`275773` 也是手写 spellId。Fuyutsui 不会根据光环名字自动去 `UnitAura` 查询，也不会根据字段名后缀自动推导“持续时间”或“层数”。

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

如果事件条目里写了 `duration`，优先使用事件自己的持续时间；否则使用光环默认 `duration`。例如某些光环可以用同一个状态名，但不同技能触发不同持续时间。

之后 `updateAura()` 每帧检查 `expirationTime`：

- 当前时间还没到结束时间：`remaining = expirationTime - GetTime()`。
- 时间到了：清空 `expirationTime`，`remaining = 0`。
- 如果有层数，过期时也会把 `count` 归零或归到 `countMin`。

`updateAuraBlocks()` 每 0.2 秒把 `remaining` 写进顶部像素。因此 Python 读到的是经过像素量化后的整数值，不是完整浮点秒数。

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

所以，“XX层数”只是字段名，不代表来源一定是 bar。判断标准只有配置：

- `step: 27` 这种整数：读顶部普通像素。
- `step: bar`：读第二行 bar。

还要注意，有些职业文件里同时存在 `type = "aura"` 的层数像素和 `countBars`，但 Python 最终读哪个，完全由 `config.yml` 决定。写 mod 时要把 Lua 像素位置、`config.yml` 字段、Python 逻辑使用的字段名一起核对。

## 真实 Aura API 的位置

Fuyutsui 也确实使用了 `C_UnitAuras`，但它不是玩家逻辑光环的主链路。

玩家自身相关的特殊路径是“防御光环”：

- `UNIT_AURA` 触发时，`GetDefensiveAuraInstanceID()` 只处理 `unit == "player"`。
- 它读取 `C_UnitAuras.GetBuffDataByIndex(unit, i, "HELPFUL|BIG_DEFENSIVE")` 的前两个增益。
- 找到后保存 `auraInstanceID`。
- `GetDefensiveAuraDuration()` 再用 `C_UnitAuras.GetAuraDuration("player", auraInstanceID)` 取剩余时间并写入 `防御光环` 像素。

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
