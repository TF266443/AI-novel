# XT Webnovel Writing Skills 包

基于 `xt-webnovel-writing-main` 的完整规则体系，共 12 个 skill JSON 文件，分为 4 组。

## 文件清单

### 核心组（必装，2个）
| 文件 | 内容 | 规则数 |
|------|------|--------|
| `xt_core_rollback.json` | 8条回滚级硬门(D/K/M/N/O/P/Q/R) | 8条回滚+全部子条款 |
| `xt_style_prose.json` | 12条FAIL级文笔规则(A/B/C/E/F/G/H/I/J/L) | 12条FAIL+50+补充条款 |

### 结构组（必装，1个）
| 文件 | 内容 | 
|------|------|
| `xt_structure_plot.json` | 八步事件法+7模板开头池+3铁律+5章开局配置+19道闸门 |

### 工艺组（选装，3个）
| 文件 | 内容 |
|------|------|
| `xt_craft_vr.json` | VR三步沉浸+5种描写模板+爽点生成4步+词替换+4层诊断 |
| `xt_characters_relationship.json` | 角色灵魂系统+关系双轨阶梯+主角反模板化+感情审风险 |
| `xt_dialogue_transition.json` | 对话工艺+场景过渡5桥+场景块分段+章尾收束 |

### 基础组（选装，6个）
| 文件 | 内容 |
|------|------|
| `anti_ai_rollback_rules.json` | 8条rollback硬门(中文摘要版) |
| `anti_ai_warn_rules.json` | 10条WARN/FAIL规则(中文摘要版) |
| `structure_eight_step.json` | 八步事件法(独立版) |
| `structure_opening_pool.json` | 7模板开头池(独立版) |
| `craft_vr_immersion.json` | VR沉浸描写(独立版) |
| `skill_pack_manifest.json` | 原20条规则包清单 |

## 使用方式

1. 首页 → 写作技能 → 导入 JSON
2. 先导入核心组 3 个文件 + 工艺组按需选装
3. 工作台 Header → 技能下拉 → 勾选需要的技能
4. 改写时自动注入已启用的技能

## 规则覆盖

总计覆盖 xt-webnovel-writing-main 的：
- 18条主规则(A-R) + 7条子规则 = 25条正式规则
- 50+条补充条款(merged into main clauses)
- 八步事件法 + 7模板开头池
- 19道闸门
- 5种描写模板 + VR三步法
- 关系双轨阶梯 + 角色灵魂系统
- 5种场景桥接方法
