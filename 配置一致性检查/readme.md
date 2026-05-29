# 配置一致性检查

Fuyutsui 分为 **Lua 插件端**（运行在 WoW 客户端内）和 **Python 端**（运行在桌面，读取像素条并发送按键）。两端通过 **像素条** 传递数据：Lua 端将状态/冷却/光环等信息写入屏幕顶部的像素条，Python 端通过截图读取像素值并还原为结构化数据。

像素条上的每个数据点由 **step 编号**（即像素条的列位置）定位，Python 端通过 `config.yml` 中的 step 映射知道每个 step 对应什么含义。因此，**Lua 端写入的 step 位置必须与 `config.yml` 声明的 step 位置完全一致**，否则 Python 端会读错数据。

本文档系统性地列出所有需要 Lua 端与 Python 端保持一致的配置项，并给出检查方法。

---

## 一致性检查清单总览

| 编号 | 检查类别 | 涉及文件 | 不一致后果 |
|------|----------|----------|------------|
| 1 | 全局状态块 step | `config.yml` ↔ 所有 `class/*.lua` | 核心状态（战斗、移动、生命值等）读取错误 |
| 2 | 职业专精状态块 step | `config.yml` ↔ `class/*.lua` | 职业特定数据（符文、能量、距离等）读取错误 |
| 3 | 法术 spells step | `config.yml` ↔ `class/*.lua` | 法术冷却/CD 数据读取错误 |
| 4 | 光环 auras step | `config.yml` ↔ `class/*.lua` | 光环持续时间/层数读取错误 |
| 5 | 法术索引（spellsList） | `core/config.lua` ↔ `class/*_logic.py` | 按键映射错位，按错技能 |
| 6 | 按键映射 keymap 索引 | `keymap/*.yml` ↔ `class/*.lua` MacrosList | 按下的热键与预期技能不一致 |
| 7 | countBar 索引 | `config.yml` bar ↔ `class/*.lua` countBars | 充能层数/施法计数读取错误 |
| 8 | 队伍 group 配置 | `config.yml` group ↔ `class/*.lua` group | 队友状态（血量、光环）读取错位 |
| 9 | 光环名称 | `config.yml` ↔ `class/*.lua` ↔ `*_logic.py` | 光环判断失效 |
| 10 | 英雄天赋 ID | `core/config.lua` ↔ `*_logic.py` | 英雄天赋判断错误 |
| 11 | Boss ID 映射 | `core/config.lua` ↔ `*_logic.py` | 首领战判断错误 |
| 12 | 职业/专精 ID | `config.yml` ↔ `utils.py` ↔ `core/config.lua` | 职业识别错误 |
| 13 | 难度文本映射 | `core/config.lua` ↔ `*_logic.py` | 难度判断错误 |
| 14 | keymap 文件引用 | `config.yml` keymap 字段 ↔ `keymap/` 目录 | keymap 加载失败 |

---

## 1. 全局状态块 step（step 1–20）

### 说明

所有职业、所有专精共享的前 20 个 step。Lua 端在每个专精的 `ClassBlocks` 里定义这些块（索引 1–20），Python 端在 `config.yml` 顶层和 `state` 段中声明。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 顶层 `锚点`/`职业`/`专精` 及 `state:` 段
- **Lua**: `Fuyutsui/class/*.lua` — 每个专精的 `ClassBlocks[spec]` 中索引 1–20

### 需要一致的项

| step | config.yml 键名 | Lua 索引 | Lua name | 说明 |
|------|-----------------|----------|----------|------|
| 1 | `锚点` | `[1]` | 锚点 | 像素条起始标记 |
| 2 | `职业` | `[2]` | 职业 | 职业 ID |
| 3 | `专精` | `[3]` | 专精 | 专精索引 |
| 4 | `state.有效性` | `[4]` | 有效性 | 角色是否有效（非死亡/非坐骑等） |
| 5 | `state.战斗` | `[5]` | 战斗 | 是否在战斗中 |
| 6 | `state.移动` | `[6]` | 移动 | 是否在移动 |
| 7 | `state.施法` | `[7]` | 施法 | 施法进度 |
| 8 | `state.引导` | `[8]` | 引导 | 引导进度 |
| 9 | `state.蓄力` | `[9]` | 蓄力 | 蓄力进度 |
| 10 | `state.蓄力层数` | `[10]` | 蓄力层数 | 蓄力阶段 |
| 11 | `state.生命值` | `[11]` | 生命值 | 玩家生命值百分比 |
| 12 | `state.能量值` | `[12]` | 能量值 | 职业能量值 |
| 13 | `state.一键辅助` | `[13]` | 一键辅助 | 一键辅助状态 |
| 14 | `state.法术失败` | `[14]` | 法术失败 | 法术是否失败 |
| 15 | `state.目标类型` | `[15]` | 目标类型 | 目标类型（敌/友/无） |
| 16 | `state.队伍类型` | `[16]` | 队伍类型 | 队伍类型 |
| 17 | `state.队伍人数` | `[17]` | 队伍人数 | 队伍人数 |
| 18 | `state.首领战` | `[18]` | 首领战 | 首领 ID |
| 19 | `state.难度` | `[19]` | 难度 | 副本难度 |
| 20 | `state.英雄天赋` | `[20]` | 英雄天赋 | 英雄天赋编号 |

### 检查方法

1. 打开 `config.yml`，确认 `state:` 下 17 个字段的 step 依次为 4–20
2. 打开任意 `class/*.lua`，检查每个 `ClassBlocks[spec]` 的索引 1–20
3. 确认每个索引的 `name` 值与上表一致
4. **所有职业、所有专精的前 20 个块必须完全相同**

### 常见错误

- 某个职业的 `ClassBlocks` 中 step 顺序与其他职业不同
- config.yml 中调整了 step 但忘记同步修改所有 Lua 文件
- 某个专精缺少某一步（如 step 13 一键辅助）

### 数据流示意

```
Lua: blocks.state["生命值"] = 11  →  CreatTexture(11, value)
                                    ↓
                          像素条第 11 列 = 生命值数据
                                    ↓
Python: row_data[11]  →  config.yml state.生命值.step = 11  →  result["生命值"]
```

---

## 2. 职业专精状态块 step（step 21+）

### 说明

每个职业的每个专精有自己的状态块，step 从 21 开始。这些块定义职业特定的数据，如符文、神圣能量、真气、灵魂碎片、目标距离、敌人人数等。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 各职业 → 各专精下的字段
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks[spec]` 中索引 21+

### 需要一致的项

以死亡骑士为例：

| config.yml 键 | config.yml step | Lua 索引 | Lua name |
|---------------|-----------------|----------|----------|
| `符文` | 21 | `[21]` | 符文 |
| `目标生命值` | 22 | `[22]` | 目标生命值 |
| `敌人人数` | 23 | `[23]` | 敌人人数 |
| `爆发开关` | 24 | `[24]` | 爆发开关 |
| `输出模式` | 25 | `[25]` | 输出模式 |
| `AOE开关` | 26 | `[26]` | AOE开关 |
| `疾病判断` | 27 | `[27]` | 疾病判断 |
| … | … | … | … |

### 检查方法

对每个职业的每个专精：

1. 在 `config.yml` 中找到 `职业编号 → 专精编号`，列出所有 `{step, 字段名}` 对
2. 在对应的 `class/*.lua` 中找到 `ClassBlocks[专精编号]`，列出所有索引 21+ 的 `{index, name}` 对
3. **逐一比对**：config.yml 的 step = Lua 的 index；config.yml 的键名 = Lua 的 name
4. 特别注意 step 序号是否存在跳号或重复

### 常见错误

- **step 冲突**：两个不同字段使用了相同的 step 编号。例如 DK 邪恶的 `脓疮毒镰2` 和 `枯萎凋零` 都被分配为 step 48（见 `Fuyutsui/Fuyutsui/config.yml:497-499` > 与 `Fuyutsui/class/Deathknight.lua:127-128` > 比较）
- **step 偏移**：Lua 中索引 24 是 "爆发开关"，但 config.yml 中 step 24 写成了别的字段
- **漏字段**：Lua 中有定义但 config.yml 中缺失，导致 Python 端读不到该数据

---

## 3. 法术 spells step

### 说明

每个专精的 `spells` 子段定义该专精使用的法术及其在像素条上的 step 位置。这些 step 通常不与状态块 step 冲突（使用不同区段，如 31+ 或 40+ 或 61+）。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 各职业专精下的 `spells:` 段
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks[spec]` 中 `type = "spell"` 的条目

### 需要一致的项

以 DK 邪恶 (spec 3) 为例：

| config.yml 键 | config.yml step | Lua 索引 | Lua spellId | Lua name |
|---------------|-----------------|----------|-------------|----------|
| `spells.死亡之握` | 61 | `[61]` | 49576 | 死亡之握 |
| `spells.反魔法领域` | 62 | `[62]` | 51052 | 反魔法领域 |
| `spells.窒息` | 63 | `[63]` | 221562 | 窒息 |
| `spells.致盲冰雨` | 64 | `[64]` | 207167 | 致盲冰雨 |
| `spells.亡者复生` | 65 | `[65]` | 46584 | 亡者复生 |
| … | … | … | … | … |

### 检查方法

对每个专精：

1. 在 `config.yml` 中列出该专精 `spells:` 下所有条目的 `{step, 键名}`
2. 在 `class/*.lua` 中列出该专精所有 `type = "spell"` 的 `{index, name}`
3. **比对**：config.yml step = Lua index；config.yml 键名 = Lua name

### 注意

- 有些法术有 `charge = true` 变体（如 `[68] = { ..., charge = true }`），需确认 config.yml 中有对应的充能条目
- config.yml 中法术名称要和 Lua 的 `name` 完全一致（包括标点符号）

---

## 4. 光环 auras step

### 说明

某些职业专精在 `config.yml` 中直接定义光环的 step（而非放在 spells 下）。这些光环 step 同样需要与 Lua `ClassBlocks` 中 `type = "aura"` 的条目一致。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 各职业专精下的光环字段
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks[spec]` 中 `type = "aura"` 的条目
- **Lua**: `Fuyutsui/core/auras.lua` — 光环逻辑定义（光环名必须能对应）

### 需要一致的项

以 DK 邪恶 (spec 3) 为例：

| config.yml 键 | config.yml step | Lua 索引 | Lua auraName |
|---------------|-----------------|----------|--------------|
| `次级食尸鬼` | 41 | `[41]` | 次级食尸鬼 |
| `割魂索命` | 42 | `[42]` | 割魂索命 |
| `末日突降` | 43 | `[43]` | 末日突降 |
| … | … | … | … |
| `枯萎凋零` | 49 | `[49]` | 枯萎凋零 |

### 检查方法

对每个有光环的专精：

1. 在 `config.yml` 中列出非 `spells`、非 `group` 的独立字段（通常 step 在 40-53 区间）
2. 在 `class/*.lua` 中列出所有 `type = "aura"` 的条目
3. 比对 step 与 index
4. 检查 `auras.lua` 中该职业下是否定义了同名光环

### 常见错误

- **step 冲突**（最常见！）：两个 aura 分配了相同的 step，如 `脓疮毒镰2` 和 `枯萎凋零` 都是 step 48，导致后写入的覆盖前者
- **名称不匹配**：config.yml 中用了简称但 Lua 中用了全称，导致 Python 查找失败

---

## 5. 法术索引 spellsList 一致性

### 说明

`core/config.lua` 中的 `Fuyutsui.spellsList` 为每个法术 ID 分配一个 **全局 index**。这个 index 不是像素条 step，而是用于 Python 端 `action_map` 和 `failed_spell_map` 的键值。Python 逻辑文件通过这些键值查找法术对应的宏槽位。

### 涉及文件

- **Lua**: `Fuyutsui/core/config.lua` — `Fuyutsui.spellsList`
- **Python**: `Fuyutsui/Fuyutsui/class/*_logic.py` — `action_map` 和 `failed_spell_map`

### 数据流

```
Lua spellsList:  [49576] = { index = 39, failed = true }  -- 死亡之握
                              ↓
Python failed_spell_map:  { 39: "死亡之握" }
                              ↓
Python get_hotkey(0, "死亡之握")  →  从 keymap 查热键
```

### 需要一致的项

对每个职业的 logic 文件：

| config.lua | Python logic |
|------------|-------------|
| `spellsList[spellId].index` | `action_map` 或 `failed_spell_map` 的 key |
| `spellsList[spellId].failed` | 应该出现在 `failed_spell_map` 中（true）还是 `action_map` 中（false/无） |

### 检查方法

1. 从 `config.lua` 中提取该职业所有法术的 `{spellId, index, failed}`
2. 从对应的 `*_logic.py` 中提取 `action_map` 和 `failed_spell_map` 的所有 key
3. 比对：
   - `failed = true` 的 index 必须在 `failed_spell_map` 中
   - `failed` 为 false 或无的 index 必须在 `action_map` 中
   - key 值必须完全一致

---

## 6. 按键映射 keymap 索引一致性

### 说明

按键映射（keymap）通过索引号将宏槽位、技能名称和热键绑定在一起。Lua 端通过 `MacrosList` 定义每个宏槽位对应的技能，Python 端通过 keymap YAML 查找技能对应的热键。

### 涉及文件

- **Lua**: `Fuyutsui/class/*.lua` — `Fuyutsui.MacrosList.staticSpells` 和 `specialSpells`
- **Python**: `Fuyutsui/Fuyutsui/keymap/*.yml` — 每个职业的按键映射文件
- **Python**: `Fuyutsui/Fuyutsui/utils.py` — `get_hotkey()` 通过技能名查热键

### 需要一致的项

| MacrosList.staticSpells | keymap YAML |
|------------------------|-------------|
| `[index] = "技能名"` | `index: {技能: "技能名", 热键: "xxx"}` |

示例 — DK 的 keymap：

```yaml
# keymap/deathknight.yml
1: {unit: 0, 技能: "亡者复生", 热键: "CTRL-NUMPAD1"}
2: {unit: 0, 技能: "亡者大军", 热键: "CTRL-NUMPAD2"}
...
```

```lua
-- class/Deathknight.lua
Fuyutsui.MacrosList = {
    staticSpells = {
        [1] = "亡者复生",
        [2] = "亡者大军",
        ...
    },
}
```

### 检查方法

1. 从 `keymap/*.yml` 中列出所有 `{index: 技能名}`
2. 从 `class/*.lua` 的 `MacrosList.staticSpells` 中列出所有 `{index: 技能名}`
3. 比对：
   - 同一 index 的技能名必须一致
   - keymap 中有但 MacrosList 中没有的，会导致 Lua 不创建对应宏
   - MacrosList 中有但 keymap 中没有的，会导致 Python 找不到热键

---

## 7. countBar 索引一致性

### 说明

某些职业在 `config.yml` 中使用 `step: bar, bar: N` 表示该数据位于 **第二条像素条**（左侧竖条）的第 N 个段。Lua 端通过 `ClassBlocks` 中的 `countBars` 数组将数据写入第二条像素条。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — `step: bar, bar: N` 的字段
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks[spec]["countBars"]` 数组
- **Python**: `Fuyutsui/Fuyutsui/GetPixels.py` — `bar_data[seg_idx]` 读取

### 需要一致的项

以 DK 邪恶 (spec 3) 为例：

| config.yml 键 | bar 编号 | Lua countBars 索引 | Lua name |
|---------------|----------|--------------------|----------|
| `食尸鬼层数` | bar: 1 | `[1]` | 天灾打击 (castCount) |
| `腐化层数` | bar: 2 | `[2]` | 腐化 (charge) |
| `凋零层数` | bar: 3 | `[3]` | 枯萎凋零 (charge) |

### 检查方法

1. 在 `config.yml` 中搜索 `step: bar`，列出 `{键名, bar: N}`
2. 在对应的 `class/*.lua` 中找到 `countBars` 数组
3. 比对：config.yml 中的 `bar: N` 对应 `countBars[N]`
4. 确认名称和含义一致（如 `bar: 2` = "腐化" 对应 countBars[2] name = "腐化"）

### 注意

- countBars 是 Lua 数组（1-indexed），bar 编号也从 1 开始
- countBar 条目可以有 `valueType = "charge"` 或 `"castCount"`，config.yml 中应正确标注类型

---

## 8. 队伍 group 配置一致性

### 说明

治疗职业和部分混合职业有 `group` 配置，用于读取队友的状态数据（生命值、职责、光环等）。`group` 使用独立于主像素条的 step 空间（从 `start` 开始，每组 `num` 个 step，最多 30 组）。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 各专精下的 `group:` 段
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks[spec]` 中 `type = "group"` 的条目
- **Python**: `Fuyutsui/Fuyutsui/GetPixels.py` — `build_state_dict()` 中的 group 解析逻辑

### 需要一致的项

| 配置项 | config.yml | Lua |
|--------|-----------|-----|
| 起始 step | `group.start` | `blocks.groups.start = k`（k 为 Lua 索引） |
| 每组字段数 | `group.num` | `v.num` |
| 各字段 step | `group.字段名.step` | Lua index = `start + (unit-1)*num + step - 1` |

以戒律牧师 (spec 1) 为例：

```yaml
# config.yml
group:
  start: 70
  num: 5
  生命值: {step: 1, type: "int"}
  职责: {step: 2, type: "int"}
  驱散: {step: 3, type: "int"}
  救赎: {step: 4, type: "int"}
  真言术：盾: {step: 5, type: "int"}
```

```lua
-- Lua ClassBlock
[70] = { type = "group", start = 70, num = 5, ... }
```

第 i 个队员的"生命值"位于像素 step = `70 + (i-1) * 5 + 1 - 1` = `70 + (i-1) * 5`。

### 检查方法

1. 检查 `group.start` 值在 config.yml 和 Lua 中是否一致
2. 检查 `group.num` 值在两端是否一致
3. 逐字段检查 group 内部各字段的 step（相对编号 1–num）是否一致

### 常见错误

- `start` 值偏移，导致所有队员数据读取错位
- `num` 不一致，导致队员之间数据串位
- group 内部字段名在 config.yml 和 auras.lua/Python logic 中不匹配

---

## 9. 光环名称一致性

### 说明

光环名称跨多个文件使用：Lua `auras.lua` 定义光环逻辑，Lua `ClassBlocks` 引用光环名，`config.yml` 通过字段名或 spells 名映射 step，Python 逻辑文件中通过光环名判断状态（如 `_has_aura(data, "救赎")`）。

### 涉及文件

- **Lua**: `Fuyutsui/core/auras.lua` — 光环定义（键名为中文光环名）
- **Lua**: `Fuyutsui/class/*.lua` — `ClassBlocks` 中的 `auraName` 字段
- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 光环字段的键名
- **Python**: `Fuyutsui/Fuyutsui/class/*_logic.py` — 逻辑中对光环名的字符串引用
- **Python**: `Fuyutsui/Fuyutsui/utils.py` — `_has_aura()` / `get_unit_with_role_and_without_aura_name()` 等函数

### 需要一致的项

同一个光环在各处的名称字符串必须完全一致：

```
auras.lua:        auras[1]["盾牌格挡"]
                        ↓
ClassBlocks:      [25] = { type = "aura", auraName = "盾牌格挡", ... }  (战士 spec 3)
                        ↓  (name 字段，可能不同)
config.yml:       盾牌格挡: {step: 25}  (战士 spec 3)
                        ↓
*_logic.py:       state_dict.get("盾牌格挡")
```

### 检查方法

1. 对每个职业，列出 `auras.lua` 中该职业的所有光环键名
2. 列出 `config.yml` 中该职业所有专精下的光环字段键名
3. 交叉比对，确认名字完全一致
4. 在 Python logic 文件中搜索光环名字符串，确认与 `config.yml` 键名一致

---

## 10. 英雄天赋 ID 一致性

### 说明

`core/config.lua` 中 `Fuyutsui.heroTalents` 定义了法术 ID → 天赋编号的映射。Python 端通过读取 step 20（英雄天赋）获取天赋编号，逻辑中依据此编号做决策。两端的编号必须一致。

### 涉及文件

- **Lua**: `Fuyutsui/core/config.lua` — `Fuyutsui.heroTalents`
- **Python**: `Fuyutsui/Fuyutsui/class/*_logic.py` — 对英雄天赋编号的判断逻辑

### 需要一致的项

以战士为例：

| config.lua heroTalents | 天赋编号 | 含义 |
|------------------------|---------|------|
| `[436358] = 1` | 1 | 巨神兵 |
| `[444767] = 2` | 2 | 屠戮者 |
| `[434969] = 3` | 3 | 山丘领主 |

Python logic 中若判断 `hero_talent == 1` 表示巨神兵，则与 Lua 端一致。

### 检查方法

1. 从 `config.lua` 中提取各职业的 `heroTalents` 映射
2. 在对应 `*_logic.py` 中搜索天赋相关的判断逻辑（数字比较）
3. 确认编号含义一致

---

## 11. Boss ID 映射一致性

### 说明

`core/config.lua` 中 `Fuyutsui.bossID` 定义了 WoW NPC ID → 内部编号的映射。Python logic 文件中的 `raid_boss_list` 使用相同的内部编号来判断当前是否在需要特殊处理的首领战中。

### 涉及文件

- **Lua**: `Fuyutsui/core/config.lua` — `Fuyutsui.bossID`
- **Python**: `Fuyutsui/Fuyutsui/class/*_logic.py` — `raid_boss_list`

### 需要一致的项

| config.lua bossID | 编号 | 说明 |
|-------------------|------|------|
| `[3176] = 1` | 1 | 元首阿福扎恩 |
| `[3177] = 2` | 2 | 弗拉希乌斯 |
| … | … | … |
| `[3333] = 53` | 53 | 洛萨克森 |

Python logic 中 `raid_boss_list` 使用相同编号：

```python
raid_boss_list = {
    1, 2, 3, ..., 53, 56, 60, 64, 68, 72, 75, 79
}
```

### 检查方法

1. 从 `config.lua` `bossID` 中提取所有编号 → NPC ID 的映射
2. 对比各 `*_logic.py` 中的 `raid_boss_list`
3. 确认每个文件中使用的编号都在 `config.lua` 中有对应定义

---

## 12. 职业/专精 ID 一致性

### 说明

职业和专精的编号在多个位置定义，必须保持一致。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 顶层以职业 ID（1–13）为键
- **Python**: `Fuyutsui/Fuyutsui/utils.py` — `_CLASS_NAMES` 和 `_SPEC_NAMES`
- **Lua**: `Fuyutsui/core/config.lua` — `Fuyutsui.rangeSpecID`（专精 ID → 射程）
- **Lua**: `Fuyutsui/class/*.lua` — 文件以职业英文名命名，内部 `ClassBlocks` 以专精索引为键

### 职业 ID 对照表

| ID | 职业 | Lua 文件 | Python logic 文件 | config.yml 键 |
|----|------|----------|-------------------|---------------|
| 1 | 战士 | Warrior.lua | warrior_logic.py | `1:` |
| 2 | 圣骑士 | Paladin.lua | paladin_logic.py | `2:` |
| 3 | 猎人 | Hunter.lua | hunter_logic.py | `3:` |
| 4 | 盗贼 | Rogue.lua | rogue_logic.py | `4:` |
| 5 | 牧师 | Priest.lua | priest_logic.py | `5:` |
| 6 | 死亡骑士 | DeathKnight.lua | deathknight_logic.py | `6:` |
| 7 | 萨满 | Shaman.lua | shaman_logic.py | `7:` |
| 8 | 法师 | Mage.lua | mage_logic.py | `8:` |
| 9 | 术士 | Warlock.lua | warlock_logic.py | `9:` |
| 10 | 武僧 | Monk.lua | monk_logic.py | `10:` |
| 11 | 德鲁伊 | Druid.lua | druid_logic.py | `11:` |
| 12 | 恶魔猎手 | DemonHunter.lua | demonhunter_logic.py | `12:` |
| 13 | 唤魔师 | Evoker.lua | evoker_logic.py | `13:` |

### 检查方法

1. 确认 `config.yml` 顶层键 1–13 与上表一致
2. 确认 `utils.py` 中 `_CLASS_NAMES` 的 key 与上表一致
3. 确认 `config.lua` 中 `rangeSpecID` 的专精 ID 与实际游戏专精 ID 一致

---

## 13. 难度文本映射一致性

### 说明

`core/config.lua` 中 `Fuyutsui.difficutlyToText` 定义了副本难度 ID → 文本的映射。Python 端 step 19 读取的是难度 ID，需要在逻辑中正确解释。

### 涉及文件

- **Lua**: `Fuyutsui/core/config.lua` — `Fuyutsui.difficutlyToText`
- **Python**: `Fuyutsui/Fuyutsui/config.yml` — `state.难度: {step: 19}`

### 当前映射

| 难度 ID | 含义 |
|---------|------|
| 1 | 5人本普通 |
| 2 | 5人本英雄 |
| 14 | 团本普通 |
| 15 | 团本英雄 |
| 16 | 团本史诗 |
| 17 | 团本随机 |
| 23 | 5人本史诗 |

### 检查方法

确认 Python 逻辑中对难度 ID 的判断与 Lua 端映射一致。

---

## 14. keymap 文件引用一致性

### 说明

`config.yml` 中每个职业配置了 `keymap` 字段，指向 `keymap/` 目录下的 YAML 文件。Python 的 `utils.py` 通过 `select_keymap_for_class()` 按此字段加载对应的 keymap。

### 涉及文件

- **Python**: `Fuyutsui/Fuyutsui/config.yml` — 各职业的 `keymap:` 字段
- **Python**: `Fuyutsui/Fuyutsui/utils.py` — `select_keymap_for_class()`
- **文件系统**: `Fuyutsui/Fuyutsui/keymap/` 目录

### 当前映射

| 职业 | config.yml keymap 值 | 对应文件 |
|------|---------------------|---------|
| 战士 | `warrior.yml` | keymap/warrior.yml |
| 圣骑士 | `paladin.yml` | keymap/paladin.yml |
| 猎人 | `hunter.yml` | keymap/hunter.yml |
| 盗贼 | `rogue.yml` | keymap/rogue.yml |
| 牧师 | `priest.yml` | keymap/priest.yml |
| 死亡骑士 | `deathknight.yml` | keymap/deathknight.yml |
| 萨满 | `shaman.yml` | keymap/shaman.yml |
| 法师 | `mage.yml` | keymap/mage.yml |
| 术士 | `warlock.yml` | keymap/warlock.yml |
| 武僧 | `monk.yml` | keymap/monk.yml |
| 德鲁伊 | `druid.yml` | keymap/druid.yml |
| 恶魔猎手 | `demonhunter.yml` | keymap/demonhunter.yml |
| 唤魔师 | `evoker.yml` | keymap/evoker.yml |

### 检查方法

1. 确认 `config.yml` 中每个职业的 `keymap` 字段指向的文件名在 `keymap/` 目录中实际存在
2. 确认文件名拼写完全一致（区分大小写）

---

## 系统性检查流程

当新增一个职业或专精、或修改了像素条布局时，建议按以下顺序检查：

### 第一步：全局状态块检查

```
config.yml state: 段          ←→  所有 class/*.lua ClassBlocks[*][1-20]
```

确保双方 step 1–20 完全一致。

### 第二步：职业专精配置检查

```
config.yml 职业.专精.各字段    ←→  class/*.lua ClassBlocks[专精][21+]
```

逐字段比较 step/index 和名称。重点关注 **step 是否重复**。

### 第三步：法术 step 检查

```
config.yml 职业.专精.spells    ←→  class/*.lua ClassBlocks[专精] 中 type="spell"
```

### 第四步：光环 step 检查

```
config.yml 职业.专精.各光环    ←→  class/*.lua ClassBlocks[专精] 中 type="aura"
                                ←→  core/auras.lua 同名光环定义
```

### 第五步：法术索引检查

```
core/config.lua spellsList    ←→  class/*_logic.py action_map + failed_spell_map
```

### 第六步：keymap 检查

```
class/*.lua MacrosList        ←→  keymap/*.yml
config.yml keymap 字段         ←→  keymap/ 目录文件存在性
```

### 第七步：countBar 和 group 检查

```
config.yml bar: N 字段         ←→  class/*.lua countBars[N]
config.yml group 段            ←→  class/*.lua type="group"
```

### 第八步：枚举/映射一致性检查

```
core/config.lua heroTalents   ←→  *_logic.py 天赋判断
core/config.lua bossID        ←→  *_logic.py raid_boss_list
core/config.lua difficultyToText ←→ *_logic.py 难度判断
```

---

## 已知不一致问题记录

| 日期 | 问题描述 | 涉及文件 | 状态 |
|------|---------|----------|------|
| — | DK 邪恶 `枯萎凋零`（光环 step 49）与 `脓疮毒镰2`（step 48）在 config.yml 中都被写为 step 48 | `config.yml:497-499`, `DeathKnight.lua:126-128` | 待修复 |

---

## 相关文档

- [截图原理](../截图原理/readme.md) — 像素条的工作机制
- [按键映射与动作输出](../按键映射与动作输出/readme.md) — keymap 和宏的详细说明
- [技能冷却](../技能冷却/readme.md) — 冷却检测和 step 映射原理
- [Mod编写入门](../Mod编写入门/readme.md) — 如何新增职业/专精
