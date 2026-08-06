// --- 1. Tab 切换扩展框架 ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.getAttribute('data-tab');

    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('border-blue-500', 'text-blue-400');
      b.classList.add('border-transparent', 'text-slate-400');
    });

    document.getElementById(targetTab).classList.remove('hidden');
    btn.classList.remove('border-transparent', 'text-slate-400');
    btn.classList.add('border-blue-500', 'text-blue-400');
  });
});

// --- 2. 涨跌幅计算 ---
const baseInput = document.getElementById('change-base');
const targetInput = document.getElementById('change-target');
const percentInput = document.getElementById('change-percent');
const resBox = document.getElementById('change-result');
const resVal = document.getElementById('change-result-val');

function calcChangeByTarget() {
  const base = parseFloat(baseInput.value);
  const target = parseFloat(targetInput.value);

  if (base && target) {
    const percent = ((target - base) / base) * 100;
    const diff = target - base;
    percentInput.value = percent.toFixed(2);
    
    resBox.classList.remove('hidden');
    const isUp = percent >= 0;
    const colorClass = isUp ? 'text-red-400' : 'text-emerald-400';
    const sign = isUp ? '+' : '';
    resVal.className = `text-2xl font-bold ${colorClass}`;
    resVal.innerHTML = `${sign}${percent.toFixed(2)}% <span class="text-sm font-normal text-slate-400">(${sign}${diff.toFixed(2)}元)</span>`;
  }
}

function calcChangeByPercent() {
  const base = parseFloat(baseInput.value);
  const percent = parseFloat(percentInput.value);

  if (base && !isNaN(percent)) {
    const target = base * (1 + percent / 100);
    const diff = target - base;
    targetInput.value = target.toFixed(2);

    resBox.classList.remove('hidden');
    const isUp = percent >= 0;
    const colorClass = isUp ? 'text-red-400' : 'text-emerald-400';
    const sign = isUp ? '+' : '';
    resVal.className = `text-2xl font-bold ${colorClass}`;
    resVal.innerHTML = `${target.toFixed(2)} 元 <span class="text-sm font-normal text-slate-400">(${sign}${diff.toFixed(2)}元)</span>`;
  }
}

baseInput.addEventListener('input', () => {
  if (percentInput.value !== '') calcChangeByPercent();
  else if (targetInput.value !== '') calcChangeByTarget();
});
targetInput.addEventListener('input', calcChangeByTarget);
percentInput.addEventListener('input', calcChangeByPercent);

document.querySelectorAll('.pct-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    percentInput.value = btn.getAttribute('data-pct');
    calcChangeByPercent();
  });
});

// --- 3. 做 T 计算 ---
let currentTradeType = 'buy';
const holdCost = document.getElementById('hold-cost');
const holdAmount = document.getElementById('hold-amount');
const tradePrice = document.getElementById('trade-price');
const tradeAmount = document.getElementById('trade-amount');
const buyBtn = document.getElementById('trade-type-buy');
const sellBtn = document.getElementById('trade-type-sell');

function setTradeType(type) {
  currentTradeType = type;
  if (type === 'buy') {
    buyBtn.className = "px-3 py-1 rounded-md bg-blue-600 text-white font-medium";
    sellBtn.className = "px-3 py-1 rounded-md text-slate-400 font-medium";
  } else {
    sellBtn.className = "px-3 py-1 rounded-md bg-emerald-600 text-white font-medium";
    buyBtn.className = "px-3 py-1 rounded-md text-slate-400 font-medium";
  }
  calcT();
}

buyBtn.addEventListener('click', () => setTradeType('buy'));
sellBtn.addEventListener('click', () => setTradeType('sell'));

function calcT() {
  const hCost = parseFloat(holdCost.value);
  const hAmt = parseFloat(holdAmount.value);
  const tPrice = parseFloat(tradePrice.value);
  const tAmt = parseFloat(tradeAmount.value);

  if (!hCost || !hAmt || !tPrice || !tAmt) return;

  let newTotalAmount = 0;
  let newTotalCostValue = 0;
  const originalTotalValue = hCost * hAmt;
  const tradeCash = tPrice * tAmt;

  if (currentTradeType === 'buy') {
    newTotalAmount = hAmt + tAmt;
    newTotalCostValue = originalTotalValue + tradeCash;
  } else {
    newTotalAmount = hAmt - tAmt;
    newTotalCostValue = originalTotalValue - tradeCash;
  }

  if (newTotalAmount <= 0) {
    document.getElementById('res-new-cost').innerText = "清仓/超卖";
    document.getElementById('res-new-amount').innerText = "0 股";
    return;
  }

  const newCostPrice = newTotalCostValue / newTotalAmount;
  const diffCost = newCostPrice - hCost;

  document.getElementById('res-new-cost').innerText = `¥${newCostPrice.toFixed(3)}`;
  document.getElementById('res-new-amount').innerText = `${newTotalAmount} 股`;
  document.getElementById('res-trade-cash').innerText = `${currentTradeType === 'buy' ? '-' : '+'}${tradeCash.toFixed(2)} 元`;

  const diffEl = document.getElementById('res-cost-diff');
  const isDown = diffCost < 0;
  diffEl.className = `text-base font-semibold ${isDown ? 'text-emerald-400' : 'text-red-400'}`;
  diffEl.innerText = `${diffCost > 0 ? '+' : ''}${diffCost.toFixed(3)} 元`;
}

[holdCost, holdAmount, tradePrice, tradeAmount].forEach(input => {
  input.addEventListener('input', calcT);
});

// --- 4. Service Worker 注册 (支持 PWA 离线运行) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('SW registration failed: ', err);
    });
  });
}