# Fuyutsui 第三方说明文档

本仓库用于整理 Fuyutsui 的第三方开发说明，面向想编写或理解 mod 扩展逻辑的作者。

## 目录

- [截图原理](截图原理/readme.md)：解释 Python 端使用 `mss` 截图、截图范围和像素格式。
- [技能冷却](技能冷却/readme.md)：解释插件端如何读取技能冷却、充能、物品冷却，并通过像素传给 Python 逻辑。
- [玩家状态](玩家状态/readme.md)：解释血量、能量、移动、有效性、坐骑间接判断、目标与队伍等普通状态如何通过像素传给 Python。
- [玩家光环](玩家光环/readme.md)：解释玩家 Buff、Debuff、Aura 的逻辑状态、持续时间、层数和像素读取方式。
- [敌对光环](敌对光环/readme.md)：分析当前 Fuyutsui 是否能读取敌对目标身上的玩家 Debuff，以及 Aura、像素和 Python 配置链路的缺口。
- [队友状态](队友状态/readme.md)：解释队友血量、职责/距离、增益、可驱散状态和 group 像素槽如何传给 Python。
- [按键映射与动作输出](按键映射与动作输出/readme.md)：解释职业 keymap、`get_hotkey(unit, spell)`、单位编号到按键映射和 `send_key_to_wow` 后台按键发送流程。
