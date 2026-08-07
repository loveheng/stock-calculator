import React, { useState, useEffect, useCallback } from 'react';
import { getFeeConfig, addTLedgerRecord } from '../store';
import { calcTTrade, roundTo, isValidLotSize } from '../mathUtils';

/**
 * 做T计算器
 * 正T（先买后卖）：计算额外占用资金、保本卖出价
 * 倒T（先卖后买）：计算盘中腾出资金、保本接回价
 * 会话隔离：仅展示当前本次操作产生的记录，历史记录由 Statistics 页面展示
 */
export default function TCalculator() {
  const [mode, setMode] = useState('long'); // 'long' = 正T, 'short' = 倒T
  const [ticker, setTicker] = useState('');
  const [buyPrice, setBuyPrice] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [note, setNote] = useState('');

  const [result, setResult] = useState(null);
  const [sessionRecords, setSessionRecords] = useState([]);
  const [feeConfig, setFeeConfig] = useState(getFeeConfig());

  // 监听费率配置变化
  useEffect(() => {
    const handler = () => setFeeConfig(getFeeConfig());
    window.addEventListener('fee-config-changed', handler);
    return () => window.removeEventListener('fee-config-changed', handler);
  }, []);

  // 实时计算
  const handleCalculate = useCallback(() => {
    const bp = parseFloat(buyPrice) || 0;
    const ba = parseInt(buyAmount) || 0;
    const sp = parseFloat(sellPrice) || 0;
    const sa = parseInt(sellAmount) || 0;

    if (bp <= 0 && sp <= 0) {
      setResult(null);
      return;
    }

    const res = calcTTrade({ mode, buyPrice: bp, buyAmount: ba, sellPrice: sp, sellAmount: sa }, feeConfig);
    setResult(res);
  }, [mode, buyPrice, buyAmount, sellPrice, sellAmount, feeConfig]);

  useEffect(() => {
    handleCalculate();
  }, [handleCalculate]);

  // 保存记录到账本
  const handleSave = () => {
    const bp = parseFloat(buyPrice) || 0;
    const ba = parseInt(buyAmount) || 0;
    const sp = parseFloat(sellPrice) || 0;
    const sa = parseInt(sellAmount) || 0;

    if (!ticker.trim()) {
      alert('请输入标的名称/代码');
      return;
    }

    const res = calcTTrade({ mode, buyPrice: bp, buyAmount: ba, sellPrice: sp, sellAmount: sa }, feeConfig);

    const record = {
      ticker: ticker.trim(),
      mode,
      buyPrice: bp || null,
      buyAmount: ba || null,
      sellPrice: sp || null,
      sellAmount: sa || null,
      buyFee: res.buyFee,
      sellFee: res.sellFee,
      totalFee: res.totalFee,
      netProfit: res.netProfit,
      profitRate: res.profitRate,
      capitalRequired: res.capitalRequired,
      capitalReleased: res.capitalReleased,
      breakevenPrice: res.breakevenPrice,
      buybackPrice: res.buybackPrice,
      status: res.status,
      note: note.trim(),
    };

    addTLedgerRecord(record);
    // 更新会话记录
    setSessionRecords(prev => [record, ...prev]);
    // 清空表单
    setTicker('');
    setBuyPrice('');
    setBuyAmount('');
    setSellPrice('');
    setSellAmount('');
    setNote('');
    setResult(null);
    alert('记录已保存！');
  };

  return (
    <div className="page-container">
      <h2>做T计算器</h2>
      <p className="page-desc">计算正T/倒T的盈亏、保本价与资金占用/释放</p>

      {/* 模式切换 */}
      <div className="mode-selector">
        <button
          className={`mode-btn long ${mode === 'long' ? 'active' : ''}`}
          onClick={() => setMode('long')}
        >
          正T 先买后卖
        </button>
        <button
          className={`mode-btn short ${mode === 'short' ? 'active' : ''}`}
          onClick={() => setMode('short')}
        >
          倒T 先卖后买
        </button>
      </div>

      {/* 模式说明 */}
      <div className="mode-hint">
        {mode === 'long' ? (
          <span>正T模式：先买入，再卖出。计算<strong>额外占用资金</strong>与<strong>保本卖出价</strong>。</span>
        ) : (
          <span>倒T模式：先卖出，再买回。计算<strong>盘中释放资金</strong>与<strong>保本接回价</strong>。</span>
        )}
      </div>

      {/* 输入表单 */}
      <div className="card">
        <div className="form-group">
          <label>标的名称/代码</label>
          <input
            type="text"
            value={ticker}
            onChange={e => setTicker(e.target.value)}
            placeholder="例如：贵州茅台"
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{mode === 'long' ? '买入价格' : '卖出价格'}</label>
            <input
              type="number"
              step="0.001"
              value={mode === 'long' ? buyPrice : sellPrice}
              onChange={e => mode === 'long' ? setBuyPrice(e.target.value) : setSellPrice(e.target.value)}
              placeholder="价格"
            />
          </div>
          <div className="form-group">
            <label>{mode === 'long' ? '买入数量' : '卖出数量'}</label>
            <input
              type="number"
              step="100"
              value={mode === 'long' ? buyAmount : sellAmount}
              onChange={e => mode === 'long' ? setBuyAmount(e.target.value) : setSellAmount(e.target.value)}
              placeholder="股数"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{mode === 'long' ? '卖出价格' : '买入价格'}</label>
            <input
              type="number"
              step="0.001"
              value={mode === 'long' ? sellPrice : buyPrice}
              onChange={e => mode === 'long' ? setSellPrice(e.target.value) : setBuyPrice(e.target.value)}
              placeholder="价格"
            />
          </div>
          <div className="form-group">
            <label>{mode === 'long' ? '卖出数量' : '买入数量'}</label>
            <input
              type="number"
              step="100"
              value={mode === 'long' ? sellAmount : buyAmount}
              onChange={e => mode === 'long' ? setSellAmount(e.target.value) : setBuyAmount(e.target.value)}
              placeholder="股数"
            />
          </div>
        </div>

        <div className="form-group">
          <label>备注（可选）</label>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="交易备注"
          />
        </div>
      </div>

      {/* 计算结果 */}
      {result && (
        <div className="card result-card">
          <h3>计算结果</h3>

          {/* 手续费明细 */}
          <div className="result-section">
            <h4>手续费明细</h4>
            {result.buyFee && (
              <div className="fee-detail">
                <span className="fee-label">买入佣金</span>
                <span className="fee-value">¥{result.buyFee.commission}</span>
              </div>
            )}
            {result.buyFee && (
              <div className="fee-detail">
                <span className="fee-label">买入过户费</span>
                <span className="fee-value">¥{result.buyFee.transfer}</span>
              </div>
            )}
            {result.sellFee && (
              <div className="fee-detail">
                <span className="fee-label">卖出佣金</span>
                <span className="fee-value">¥{result.sellFee.commission}</span>
              </div>
            )}
            {result.sellFee && (
              <div className="fee-detail">
                <span className="fee-label">卖出印花税</span>
                <span className="fee-value">¥{result.sellFee.stamp}</span>
              </div>
            )}
            {result.sellFee && (
              <div className="fee-detail">
                <span className="fee-label">卖出过户费</span>
                <span className="fee-value">¥{result.sellFee.transfer}</span>
              </div>
            )}
            <div className="fee-detail total">
              <span className="fee-label">摩擦成本合计</span>
              <span className="fee-value">¥{result.totalFee}</span>
            </div>
          </div>

          {/* 正T结果 */}
          {mode === 'long' && (
            <div className="result-section">
              <h4>正T分析</h4>
              <div className="result-item">
                <span>额外占用资金</span>
                <span className="value highlight">¥{result.capitalRequired}</span>
              </div>
              {result.breakevenPrice && (
                <div className="result-item">
                  <span>保本卖出价</span>
                  <span className="value highlight">¥{result.breakevenPrice}</span>
                </div>
              )}
              {result.netProfit !== null && (
                <div className="result-item">
                  <span>净利润</span>
                  <span className={`value ${result.netProfit >= 0 ? 'profit' : 'loss'}`}>
                    ¥{result.netProfit}
                  </span>
                </div>
              )}
              {result.status && (
                <div className="result-item">
                  <span>状态</span>
                  <span className="value">{result.status}</span>
                </div>
              )}
            </div>
          )}

          {/* 倒T结果 */}
          {mode === 'short' && (
            <div className="result-section">
              <h4>倒T分析</h4>
              <div className="result-item">
                <span>盘中释放资金</span>
                <span className="value highlight">¥{result.capitalReleased}</span>
              </div>
              {result.buybackPrice && (
                <div className="result-item">
                  <span>保本接回价</span>
                  <span className="value highlight">¥{result.buybackPrice}</span>
                </div>
              )}
              {result.netProfit !== null && (
                <div className="result-item">
                  <span>净利润</span>
                  <span className={`value ${result.netProfit >= 0 ? 'profit' : 'loss'}`}>
                    ¥{result.netProfit}
                  </span>
                </div>
              )}
              {result.status && (
                <div className="result-item">
                  <span>状态</span>
                  <span className="value">{result.status}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 保存按钮 */}
      {result && (
        <button className="btn btn-primary btn-block" onClick={handleSave}>
          保存记录
        </button>
      )}

      {/* 会话记录 */}
      {sessionRecords.length > 0 && (
        <div className="card">
          <h3>本次操作记录</h3>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>标的</th>
                  <th>模式</th>
                  <th>净利润</th>
                  <th>摩擦成本</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sessionRecords.map((r, i) => (
                  <tr key={i}>
                    <td>{r.ticker}</td>
                    <td>{r.mode === 'long' ? '正T' : '倒T'}</td>
                    <td className={r.netProfit >= 0 ? 'profit' : 'loss'}>
                      {r.netProfit !== null ? `¥${r.netProfit}` : '-'}
                    </td>
                    <td>{r.totalFee !== null ? `¥${r.totalFee}` : '-'}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}