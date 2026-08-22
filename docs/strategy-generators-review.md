# 沙盘预设策略生成器（strategyGenerators.ts）工程审查

> 版本：审查稿 v1（只读，不含任何代码改动）
> 范围：`src/utils/strategyGenerators.ts`
> 性质：发现与建议汇总，供决策后再动代码。

---

## 0. 结论速览

这套文件在「反未来函数」「防死锁」「DCA 时序现金流」上已经过多轮加固，方向正确。但站在**资金台账**与**信号-成交边界**视角，仍存在几处实质性隐患，主要集中在三块：

1. **资金/占用台账不统一**（最高优先级，最可能在实际数据上翻车）
2. **参数不真正生效**（`stop-profit` 调参几乎没用）
3. **反未来的“薄弱钉子”**（`execAtNext` 退化分支可能自成交）

---

## 1. 资金/占用台账不统一（最高优先级）

### 1.1 现象：同一变量 `spent` 在不同策略里语义互相矛盾

#### grid（`ringGrid`）

- 买入入账：`spent += qty * price * (1+buffer)`（约 L434）。
- 卖出**只** `position -= qty`，`spent` **从不减少**（约 L440-444）。

后果：
- 一旦累计买入把 `spent` 推到 `totalPool - FIXED_FEE` 附近，`spent < totalPool - FIXED_FEE` 恒不成立（约 L428）。
- 即便之后涨价卖光、手里换回现金，也**再也买不进**——「跌买→涨卖→再低吸」的网格循环会退化为「一次性买满、最后一次大抛」。

#### pyramid

- 解套卖出后 `spent = 0`、`position`、`costAccum`、`levelBought`、`ref` 一起归零。
- 这是「当作新波段/新账户」的处理，做了**三池中唯一**的"归零回流"，与其它策略不一致。

#### ma20-bounce

- 卖出只回补 `spentA`（摊薄口径），`spentB` 卖出从不释放——若 `possible availedNow` 按 `spentA+spentB` 计总占用，会导致卖出后仍买不动。

### 1.2 建议：统一台账

抽公共 helper 一把算清：

```ts
// 每个策略维护：position（持仓股数）、costBasis（持仓成本）、realizedCash（卖出回流）
可用现金 = 初始 + 注入 − costBasis + realIn()
```

并在**每个策略+每笔卖出**都套用同一公式，而不是各写各的 `spent` 规则。目标是让以下不变量恒成立：

```
Σ 买入成本 − Σ 卖出回流 ≤ 初始 + Σ 注入
```

## 2. 卖出不过账、手续费不对称

- 买入按 `price×(1+buffer)` 计提规费/滑点；
- **卖出既不扣费、也不把收入回流到可用现金**。

后果：回测对**做 T / 反复交易**的策略系统性高估可用资金、低估交易阻力。要严谨就做买卖两条对称记账（买入计费入成本，卖出计费 + 回流现金）。

## 3. `stop-profit` 的 `generate` 不吃关键参数

- 建仓量 = `lv.qty`（`stopProfitGenerator.generate` 约 L533）。
- 而 `lv.qty` 由 `computeStopProfitLevels`（L472-488）基于 `simulatedCash/currentCost/riskPercent/近期低` 计算。
- 因此 UI 把 `riskPercent`（账户风险%）从 2 调到 8、或改 `rewardRatio`，**实际生成订单的量/结构几乎不变**（`rewardRatio` 只改界面 tp2 价格）。

建议：让 `generate` 在真正建仓时**依据实际可用资金与参数**重算仓，而不是直接复用界面预览值。

## 4. 反未来函数：边界一致性与退化分支

### 4.1 `execAtNext` 退化分支可能自成交
- 无下一根 K 时，`execAtNext` 回退 `kline[i]` 用**收盘价成交**（L163-166)——这是未来函数/自成交隐患点。
- 当前靠各循环 `…-1` 边界规避，但各策略写法不一（ma20 用 `maSlow..len-1`、grid 用 `windowSize..len-1`、其余用 `len-1`）。一旦有人“优化循环”误改边界，退化分支就会静默按收盘成交。

建议：把“无下一日则不成交（丢弃）”设为硬约束默认，而非 fallback。

### 4.2 同一根 K 内先卖后买（ma20）
- L234-268 在同一个 for body 先执行「减仓 50% 卖」又执行「回踩低吸买」，用 `bar.close` 同时作信号与撮合依据，存在同日先卖后买抖动。

## 5. 数值/健壮性

- `calcATR` 前 `n-1` 根返回 `NaN`，`maxLoop` 用 `Number.isNaN`，而 `fast/slow` 用 `==null`——判空风格不统一，易改错。
- `costPerShare = spentA / position` 依赖 `position>0` 兜底（ma20 approx L241）；一旦 `spentA` 与 `position` 失配（回顾 §1），该比值会失真。
- `expectedPeriods = floor(len/period)`，当 `len<period` 下界 1 → `perPeriod=totalPool`，基准线“分散定投”语义弱化（虽有 `budget=min(period, availableNow)` 兜着）。
- `computeRemainingCash` 用“成本价”而非“市值”，当可买资金用会失真。

## 6. 单测盲区

- 现有测试只有 `pure-dca` 断言「累计买入 ≤ 资金底座」；
- **其余 5 个策略**（ma20-bounce / pyramid / grid / stop-profit / max-opportunity）都没有资金不变量断言，而上述 bug 恰好都长在资金上。

建议为 6 个策略统一补：
- 资金不变量：`Σ(买入成本) − Σ(卖出回流) ≤ 初始 + Σ 注入`
- `seqIndex` 连续 / 时间升序 (已在契约测试覆盖)

---

## 7. 修复优先级建议（后续动工时）

| 优先级 | 项 | 改动范围 | 风险 | 状态 |
|---|---|---|---|---|
| P0 | grid：卖出净价回补 `spent`（让网格循环能继续低吸） | 小 | 低 | ✅ 已修（`ringGrid` 卖出时 `spent = Math.max(0, spent - qty*price*(1-SELL_BUFFER))`） |
| P0 | `execAtNext`：无下一日不成交（去自成交/future 隐患） | 小 | 低 | ✅ 已修（返回 `null`，7 处调用全部加空值防护） |
| P1 | `stop-profit`：`riskPercent` 参数真正影响建仓量 | 中 | 中 | ✅ 已修（`generate` 按执行日已入账现金 + riskPercent 重算入场量，不再复用预览值 `lv.qty`） |
| P1 | 资金台账统一（helper + 6 策略资金不变量单测） | 大 | 高（牵动多策略行为） | ✅ 已修（grid 卖出净价回补、ma20 卖出按成本均摊同时释放 A/B 池；新增 6 策略统一资金不变量单测） |
| P2 | 卖出记账（计手续费 + 回流水）；ma20 同根买卖抖动 | 中 | 中 | 部分（卖出扣 SELL_BUFFER + max-opportunity 盈利回流为可投权益已修；ma20 同根抖动待处理） |

---

*本稿只讨论问题，不对现有稳定逻辑做改动；需要落地时逐项按优先级推进，并配合资金不变量单测。*