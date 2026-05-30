# 法术失败

"法术失败"机制用于检测玩家施放的即时法术是否成功命中目标。当玩家按下按键施法、但法术因为各种原因（目标不在范围、目标已死亡、路径不通等）未能放出时，法术失败的冷却时间会变为 0 且法术可用，Fuyutsui 将此状态编码到 block 索引 14，Python 端检测后**重新按下该法术的按键**，实现自动重试。

## 数据流总览

```text
WoW UNIT_SPELLCAST_FAILED 事件
  → Lua: updateSpellFailed(spellID)
  → 检查 spell 是否在 failed_spell 列表中
  → 写入 block 索引 14（B 通道 = spell index/255）
  → 1.5 秒后自动清零

WoW UNIT_SPELLCAST_SUCCEEDED 事件
  → Lua: updateFailedSpellBySuccess(spellID)
  → 如果 success 的 spellID == failedSpellId: 立即清零

Python:
  → 读取 state_dict["法术失败"]
  → _get_failed_spell(): 查 failed_spell_map 获取法术名
  → 验证法术冷却 == 0
  → 若成立：最高优先级，重新按下该法术
```

## Lua 端

### 槽位定义

**固定位置：** 所有职业、所有专精中均为 `[14] = { type = "block", name = "法术失败" }`。

定义在各 `class/*.lua` 文件（如 `Fuyutsui/class/Mage.lua` 第 18 行）：
```lua
[14] = { type = "block", name = "法术失败" },
```

### config.yml 映射

`Fuyutsui/Fuyutsui/config.yml` 第 16 行：
```yaml
法术失败: {step: 14, type: "int" }
```

### 模块级状态变量

`Fuyutsui/main.lua` 第 19 行：
```lua
local failedSpell, failedSpellId, failedSpellTimer, updateIndex = nil, nil, nil, 1
```

| 变量 | 类型 | 含义 |
|---|---|---|
| `failedSpell` | number/nil | 当前失败法术在 spellsList 中的 index |
| `failedSpellId` | number/nil | 当前失败法术的 spellId |
| `failedSpellTimer` | timer/nil | 1.5 秒后自动清零的定时器 |

### 事件注册

`Fuyutsui/core/core.lua` 第 52–53 行：
```lua
self:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")
self:RegisterEvent("UNIT_SPELLCAST_FAILED")
```

### 事件处理

`Fuyutsui/main.lua` 第 1496–1522 行：

```lua
function Fuyutsui:UNIT_SPELLCAST_SUCCEEDED(_, unitTarget, castGUID, spellID, castBarID)
    if unitTarget ~= "player" or isSec(spellID) then return end
    self:updateDrinkStatus(spellID)
    self:updateFailedSpellBySuccess(spellID)
    self:updateAuraBySuccess(spellID, castBarID)
    -- ...
end

function Fuyutsui:UNIT_SPELLCAST_FAILED(_, unitTarget, castGUID, spellID, castBarID)
    if unitTarget ~= "player" then return end
    if not isSec(spellID) then
        self:updateSpellFailed(spellID)
    end
end
```

> 注意：`isSec(spellID)` 过滤了"秘密法术"（不需要向 Python 暴露的内部法术）。

### updateSpellFailed 函数

`Fuyutsui/main.lua` 第 519–547 行：

```lua
-- 14. 更新玩家法术失败
function Fuyutsui:updateSpellFailed(spellID)
    local isUsable = C_Spell.IsSpellUsable(spellID)

    if spellsList[spellID] and spellsList[spellID].failed then
        failedSpell = spellsList[spellID].index
        state.failedSpell = failedSpell / 255 or 0
    else
        failedSpell = nil
        state.failedSpell = 0
    end

    if not isUsable or not failedSpell then return end

    failedSpellId = spellID

    if failedSpellTimer then
        failedSpellTimer:Cancel()
        failedSpellTimer = nil
    end

    failedSpellTimer = C_Timer.NewTimer(1.5, function()
        self:CreatTexture(blocks.state["法术失败"], 0)
        failedSpellTimer = nil
        failedSpell = nil
        failedSpellId = nil
    end)
    self:CreatTexture(blocks.state["法术失败"], state.failedSpell)
end
```

**执行逻辑：**

1. 检查 `C_Spell.IsSpellUsable(spellID)` — 法术是否可用
2. 在 `spellsList` 中查找该 spell 是否标记了 `failed = true`（只处理白名单中的法术）
3. 若法术不在白名单中 → 跳过（`failedSpell = nil`，`state.failedSpell = 0`）
4. 若法术不可用 → 跳过（法术确实进入了冷却，不是"假失败"）
5. 通过上述检查后：写入 block 索引 14，并启动 1.5 秒定时器自动清零
6. 若之前已有定时器在运行 → 先取消旧定时器再创建新的

**关键判断：** `isUsable == true` 且 `failed == true` — 即法术"可用但被标记为失败"。这表示法术虽然没能施放成功，但也没进入冷却（典型的"目标不在视野""距离太远"等失败）。

### updateFailedSpellBySuccess 函数

`Fuyutsui/main.lua` 第 549–556 行：

```lua
-- 14. 通过施法成功更新玩家法术失败
function Fuyutsui:updateFailedSpellBySuccess(spellID)
    if spellID ~= failedSpellId then return end
    failedSpell = nil
    failedSpellId = nil
    print("|cff00ff00插入技能: |r", GetSpellName(spellID))
    self:CreatTexture(blocks.state["法术失败"], 0)
end
```

**执行逻辑：**
- 当一个法术施放成功时，检查成功施放的 spellID 是否等于之前记录的 `failedSpellId`
- 如果匹配：说明重试成功，立即清零法术失败信号
- 打印 `"插入技能: <技能名>"`（绿色）用于调试

## spellsList 的 failed 标记

`Fuyutsui/core/config.lua` 中为每个职业的法术定义了 `failed = true` 标记。**只有在此列表中的法术才会触发法术失败机制。**

### 标记规则

仅标记**即时施法、可对目标使用、有冷却时间**的法术。引导类法术、无冷却法术、召唤/坐骑类法术不标记。

### 各职业 failed 法术汇总

**术士（Warlock）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 5782 | 恐惧 |
| 2 | 6789 | 死亡缠绕 |
| 3 | 30283 | 暗影之怒 |
| 4 | 196277 | 内爆 |
| 5 | 265187 | 召唤恶魔暴君 |
| 6 | 1276467 | 魔典：邪能破坏者 |

**牧师（Priest）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 8122 | 心灵尖啸 |
| 2 | 32375 | 群体驱散 |
| 3 | 62618 | 真言术：障 |
| 4 | 421453 | 终极苦修 |
| 5 | 200183 | 神圣化身 |
| 6 | 120517 | 光晕 |
| 7 | 64843 | 神圣赞美诗 |
| 8 | 228260 | 虚空形态 |
| 9 | 15286 | 吸血鬼的拥抱 |
| 30 | 194509 | 真言术：耀 |
| 35 | 472433 | 福音 |

**德鲁伊（Druid）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 132469 | 台风 |
| 2 | 99 | 夺魂咆哮 |
| 3 | 102793 | 乌索尔旋风 |
| 31 | 78675 | 日光术 |

**法师（Mage）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 18 | 110959 | 强化隐形术 |
| 19 | 122 | 冰霜新星 |
| 20 | 31661 | 龙息术 |

**圣骑士（Paladin）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 115750 | 盲目之光 |
| 2 | 31821 | 光环掌握 |
| 3 | 1044 | 自由祝福 |
| 4 | 853 | 制裁之锤 |
| 5 | 1022 | 保护祝福 |
| 6 | 642 | 圣盾术 |
| 7 | 375576 | 圣洁鸣钟 |
| 16 | 255937 | 灰烬觉醒 |
| 24 | 200025 | 美德道标 |

**武僧（Monk）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 322109 | 轮回之触 |
| 2 | 119381 | 扫堂腿 |
| 3 | 101643 | 魂体双分 |
| 4 | 119996 | 转移 |
| 5 | 115310 | 还魂术 |
| 6 | 116844 | 平心之环 |
| 7 | 115078 | 分筋错骨 |
| 8 | 132578 | 玄牛下凡 |

**战士（Warrior）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 202168 | 胜利在望 |
| 2 | 376079 | 勇士之矛 |
| 3 | 6544 | 英勇飞跃 |
| 4 | 97462 | 集结呐喊 |
| 5 | 46968 | 震荡波 |
| 6 | 107570 | 风暴之锤 |
| 7 | 384110 | 破裂投掷 |
| 8 | 64382 | 碎裂投掷 |
| 9 | 5246 | 破胆怒吼 |
| 10 | 385952 | 盾牌冲锋 |

**死亡骑士（DeathKnight）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 1 | 51052 | 反魔法领域 |
| 2 | 221562 | 窒息 |
| 3 | 207167 | 致盲冰雨 |
| 4 | 42650 | 亡者大军 |
| 23 | 108199 | 血魔之握 |
| 24 | 1263569 | 憎恶附肢 |
| 39 | 49576 | 死亡之握 |

**猎人（Hunter）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 22 | 109304 | 意气风发 |
| 27 | 19577 | 胁迫 |
| 39 | 5116 | 震荡射击 |
| 40 | 19801 | 宁神射击 |
| 41 | 187698 | 焦油陷阱 |
| 42 | 1513 | 恐吓野兽 |
| 43 | 109248 | 束缚射击 |
| 45 | 195645 | 摔绊 |

**恶魔猎手（DemonHunter）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 3 | 207684 | 悲苦咒符 |
| 6 | 179057 | 混乱新星 |
| 16 | 187827 | 恶魔变形 |
| 26 | 212084 | 邪能毁灭 |
| 27 | 202137 | 沉默咒符 |
| 28 | 1234195 | 虚空新星 |
| 43 | 196718 | 黑暗 |

**唤魔师（Evoker）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| （无 failed = true 标记 — 唤魔师法术全部未标记） |

**萨满（Shaman）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| 13 | 444995 | 涌动图腾 |
| 14 | 192058 | 电能图腾 |
| 15 | 192063 | 阵风 |
| 16 | 98008 | 灵魂链接图腾 |
| 17 | 198103 | 土元素 |
| 18 | 8143 | 战栗图腾 |
| 19 | 383013 | 清毒图腾 |
| 20 | 108287 | 图腾投射 |
| 21 | 114052 | 升腾 |
| 22 | 108280 | 治疗之潮图腾 |
| 45 | 73920 | 治疗之雨 |
| 47 | 192077 | 狂风图腾 |

**潜行者（Rogue）：**
| spellsList index | 法术 ID | 法术名称 |
|---|---|---|
| （无 failed = true 标记 — 潜行者法术全部未标记） |

> 注意：唤魔师和潜行者在 spellsList 中没有任何 `failed = true` 标记，意味着这两个职业的法术失败机制在 Lua 端**不生效**。

## Python 端

### 通用函数

每个职业的 `*_logic.py` 文件都定义了一个 `_get_failed_spell()` 函数和 `failed_spell_map` 字典，**只包含该职业需要重试的法术**（通常是长冷却、高价值的即时法术）：

```python
failed_spell_map = {
    1: "心灵尖啸",
    2: "群体驱散",
    3: "真言术：障",
    # ...
}

def _get_failed_spell(state_dict):
    法术失败 = state_dict.get("法术失败", 0)
    spells = state_dict.get("spells") or {}
    spell_name = failed_spell_map.get(法术失败)
    if spell_name and spells.get(spell_name, -1) == 0:
        return spell_name
    return None
```

**双重验证逻辑：**
1. `法术失败 != 0`：Lua 端报告了法术失败
2. `spell_name = failed_spell_map.get(法术失败)`：将 spellsList index 映射回法术名
3. `spells.get(spell_name, -1) == 0`：**确认该法术的冷却时间确实为 0**（防止误判）
4. 三者全部满足才返回法术名，否则返回 `None`

### 决策优先级

法术失败在所有职业逻辑中具有**最高优先级**（仅次于"正在引导"检查）：

```python
# 典型结构（战士为例）
if 法术失败 != 0 and 失败法术 is not None:
    current_step = f"施放 {失败法术}"
    action_hotkey = get_hotkey(0, 失败法术)
elif 一键辅助 == 12:
    # ...
elif ...:
    # 其他逻辑
```

### 各职业 failed_spell_map 配置

**术士（warlock_logic.py）：**
```python
failed_spell_map = {
    1: "死亡缠绕",
    2: "暗影之怒",
    3: "暗影之怒",     # 注意：index 2 和 3 都映射到暗影之怒
    4: "内爆",
    5: "召唤恶魔暴君",
    6: "魔典邪能破坏者",
}
```

**牧师（priest_logic.py）：**
```python
failed_spell_map = {
    1: "心灵尖啸",
    2: "群体驱散",
    3: "真言术：障",
    4: "终极苦修",
    5: "神圣化身",
    6: "光晕",
    7: "神圣赞美诗",
    8: "虚空形态",
    9: "吸血鬼的拥抱",
    30: "真言术：耀",
    35: "福音",
}
```

**德鲁伊（druid_logic.py）：**
```python
failed_spell_map = {
    1: "台风",
    2: "夺魂咆哮",
    3: "乌索尔旋风",
    4: "自然迅捷",     # 注意：index 4 在 spellsList 中是自然迅捷，但无 failed=true 标记
}
```
> 注意：自然迅捷在 spellsList 的 index=4 没有 `failed = true` 标记（Lua 端不触发），但 Python 端依然定义了映射。

**法师（mage_logic.py）：**
```python
failed_spell_map = {
    18: "强化隐形术",
    19: "冰霜新星",
    20: "龙息术",
}
```

**圣骑士（paladin_logic.py）：**
```python
failed_spell_map = {
    1: "盲目之光",
    2: "光环掌握",
    3: "自由祝福",
    4: "制裁之锤",
    5: "保护祝福",
    6: "圣盾术",
    7: "圣洁鸣钟",
    8: "复仇者之盾",   # 注意：index 8 在 spellsList 中无 failed=true 标记
    16: "灰烬觉醒",
    24: "美德道标",
}

# 专精限定：圣洁鸣钟只在防护专精重试
failed_spell_spec = {"圣洁鸣钟": "防护"}

def _get_failed_spell(state_dict, spec_name=""):
    法术失败 = state_dict.get("法术失败", 0)
    spells = state_dict.get("spells") or {}
    spell_name = failed_spell_map.get(法术失败)
    if spell_name and spells.get(spell_name, -1) == 0 \
        and (spell_name not in failed_spell_spec 
             or failed_spell_spec[spell_name] == spec_name):
        return spell_name
    return None
```

**武僧（monk_logic.py）：**
```python
failed_spell_map = {
    1: "轮回之触",
    2: "扫堂腿",
    3: "魂体双分",
    4: "魂体双分：转移",
    5: "还魂术",
    6: "平心之环",
    7: "分筋错骨",
    8: "玄牛下凡",
}
```

**战士（warrior_logic.py）：**
```python
failed_spell_map = {
    1: "胜利在望",
    2: "勇士之矛",
    3: "英勇飞跃",
    4: "集结呐喊",
    5: "震荡波",
    6: "风暴之锤",
    7: "破裂投掷",
    8: "碎裂投掷",
    9: "破胆怒吼",
    10: "盾牌冲锋",
}
```

**死亡骑士（deathknight_logic.py）：**
```python
failed_spell_map = {
    1: "反魔法领域",
    2: "窒息",
    3: "致盲冰雨",
    4: "亡者大军",
    5: "血魔之握",     # 注意：spellsList index 23，但这里映射为 5
    # ...
}
```

**猎人（hunter_logic.py）：**
```python
failed_spell_map = {
    1: "意气风发",
    2: "胁迫",
}
```

**恶魔猎手（demonhunter_logic.py）：**
```python
failed_spell_map = {
    3: "悲苦咒符",
    4: "禁锢",         # spellsList 中 index=4 无 failed=true 标记
    6: "混乱新星",
    16: "恶魔变形",
    26: "邪能毁灭",
    27: "沉默咒符",
    28: "虚空新星",
    43: "黑暗",
}
```

**唤魔师（evoker_logic.py）：**
```python
failed_spell_map = {
    1: "黑曜鳞片",     # spellsList 中黑曜鳞片无 failed=true 标记
    2: "灼烧之焰",     # spellsList 中灼烧之焰无 failed=true 标记
}
```
> 唤魔师在 spellsList 中无任何 `failed=true` 标记，Python 端的 failed_spell_map 实际上永远不会被触发。这可能是一个待实现或废弃的配置。

**潜行者（rogue_logic.py）：**
```python
failed_spell_map = {
    # 空字典
}
```
> 潜行者的 failed_spell_map 为空，法术失败机制不生效。

**萨满（shaman_logic.py）：**
```python
failed_spell_map = {
    13: "涌动图腾",
    14: "电能图腾",
    15: "阵风",
    16: "灵魂链接图腾",
    17: "土元素",
    18: "战栗图腾",
    19: "清毒图腾",
    20: "图腾投射",
    21: "升腾",
    22: "治疗之潮图腾",
    45: "治疗之雨",
    46: "倾盆大雨",     # spellsList 中倾盆大雨无 failed=true 标记
}
```

### 特殊用法：萨满恢复的条件性处理

萨满恢复专精中有一个特殊的法术失败处理：

```python
elif 法术失败 == 46 and 倾盆大雨层数 >= 1:
    current_step = f"施放 治疗之雨"
    action_hotkey = get_hotkey(0, "治疗之雨")
```

这里 `法术失败 == 46` 对应倾盆大雨失败，但若倾盆大雨层数 ≥1，则改为施放治疗之雨（因为倾盆大雨触发瞬发治疗之雨）。

## 编码细节

### 传递值

- Lua 端写入 B 通道：`spellsList[spellID].index / 255`（仅当 `isUsable == true` 且 `failed == true`）
- 传输方式：像素 B 通道（0–255 整数）
- 值为 0 表示无法术失败，非零值为失败法术在 spellsList 中的 index

### 自动清零机制

法术失败信号通过两种方式清零：
1. **1.5 秒超时**：`C_Timer.NewTimer(1.5, ...)` 自动将 block 索引 14 置 0
2. **施法成功**：`UNIT_SPELLCAST_SUCCEEDED` 事件触发时，若成功施放的 spellID 匹配之前的 failedSpellId，立即清零

这两种机制确保法术失败信号不会持续过久，也不会覆盖下一次真正的法术失败。

## 相关文件

| 文件 | 作用 |
|---|---|
| `Fuyutsui/main.lua:19` | failedSpell 等模块级状态变量 |
| `Fuyutsui/main.lua:519-556` | updateSpellFailed() 和 updateFailedSpellBySuccess() |
| `Fuyutsui/main.lua:1496-1522` | UNIT_SPELLCAST_SUCCEEDED / FAILED 事件处理 |
| `Fuyutsui/core/core.lua:52-53` | 事件注册 |
| `Fuyutsui/core/config.lua` | spellsList 定义（含 failed=true 标记） |
| `Fuyutsui/Fuyutsui/config.yml:16` | step 14→"法术失败" 映射 |
| `Fuyutsui/Fuyutsui/class/*_logic.py` | 各职业 failed_spell_map 和 _get_failed_spell() |

## 相关文档

- `块分配表/readme.md`：block 索引 14 的位置和编码规则
- `一键辅助/readme.md`：action_map 机制（与法术失败的决策优先级配合）
- `截图原理/readme.md`：Python 端如何读取像素数据
