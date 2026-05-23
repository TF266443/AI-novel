# XT Webnovel Writing Skills 包 v2.0

基于 `xt-webnovel-writing-main` 文件逐条校对，25条主规则(A-R) + 7条子规则 + 50+补充条款全覆盖。

## 文件清单（7个skill JSON）

### 核心必装（3个）
| 文件 | 覆盖范围 | 源文件 |
|------|----------|--------|
| `xt_core_rollback.json` | 8条回滚级(D/K/M/N/O/P/Q/R含全部子条款) | anti-ai-tells.md |
| `xt_style_prose.json` | 12条FAIL级(A/B/C/E/F/G/H/I/J/L含B/E/G/H全部扩展) | anti-ai-tells.md |
| `xt_supplement_missing.json` | 校对补全12条(D-4/D补5/D补6/C补2/P补/P补2/P补6/G补3/G补5/O补2/O补3/完整过渡词表) | anti-ai-tells.md |

### 结构方法（1个）
| 文件 | 覆盖范围 | 源文件 |
|------|----------|--------|
| `xt_structure_plot.json` | 八步事件法+7模板开头池+3铁律+5章开局+19闸门 | plot-design/workflow.md |

### 工艺组（3个）
| 文件 | 覆盖范围 | 源文件 |
|------|----------|--------|
| `xt_craft_vr.json` | VR三步+5描写模板+爽点4步+词替换+4层诊断 | excitement-and-craft/workflow.md |
| `xt_characters_relationship.json` | 灵魂系统+关系双轨+主角反模板+感情审风险 | anti-ai-tells.md(E扩展) |
| `xt_dialogue_transition.json` | 对话工艺+5场景桥+场景块分段+章尾收束 | anti-ai-tells.md(I/Q/K/N) |

## 校对验证结果

| 检查项 | 结果 |
|--------|------|
| 18条主规则A-R | ✅ 全覆盖 |
| 7条子规则(B扩展/E扩展1,2/G扩展1,2/G细化/H扩展/N细化) | ✅ 全覆盖 |
| A-补充章首模板池决策表 | ✅ xt_style_prose |
| D-4句法级人类缀笔(回滚) | ✅ xt_supplement_missing |
| O-在场元叙事禁入(回滚) | ✅ xt_core_rollback |
| O-补充2人设破绽模板化 | ✅ xt_supplement_missing |
| O-补充3视觉锚留白 | ✅ xt_supplement_missing |
| P-补充巧合链 | ✅ xt_supplement_missing |
| P-补充2文化速写(回滚) | ✅ xt_supplement_missing |
| P-补充6反差钩子 | ✅ xt_supplement_missing |
| P-补充7背景灌输 | ✅ xt_supplement_missing |
| G-补充3系统面板 | ✅ xt_supplement_missing |
| G-补充5知识共振 | ✅ xt_supplement_missing |
| C-补充2段落功能单一化 | ✅ xt_supplement_missing |
| D-补充5开局身体感 | ✅ xt_supplement_missing |
| D-补充6时序连续性 | ✅ xt_supplement_missing |
| 完整禁止过渡词列表 | ✅ xt_supplement_missing |
| 八步事件法(8步全) | ✅ xt_structure_plot |
| 7模板开头池(含优先级) | ✅ xt_style_prose |
| 5种描写模板 | ✅ xt_craft_vr |
| VR三步沉浸 | ✅ xt_craft_vr |
| 关系双轨阶梯(感情+友谊) | ✅ xt_characters_relationship |
| 5种场景桥接方法 | ✅ xt_dialogue_transition |
| 19道闸门(0-18b) | ✅ xt_structure_plot |

## 使用方式
1. 首页 → 写作技能 → 逐个导入 7 个 JSON 文件
2. 工作台 Header → 技能下拉 → 勾选需要的技能
3. 推荐先全选核心3个 + 结构1个，工艺3个按需选装
