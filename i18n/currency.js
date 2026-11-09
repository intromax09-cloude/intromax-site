// Валюта за мовою: українська версія показує гривню, en/ і ru/ — долари.
// Єдине джерело цін — долари (ITEMS конструктора в index.html); гривня з них рахується за курсом
// window.IMX_RATE з index.html з округленням донизу: до 1 000 грн — до 50 грн, далі — до 100 грн.
// Тут те саме правило для збирання мов (build.js) і бази AI-агента (ai/build-kb.js):
// гривневі суми в перекладах перетворюються назад на долари. Сума без доларового відповідника — помилка:
// значить, ціну в українській версії вписали не за правилом (порахувати через usdToUah або дати переклад вручну).
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = /window\.IMX_RATE\s*=\s*([\d.]+)/.exec(SRC);
if(!m) throw new Error('currency.js: у index.html немає window.IMX_RATE');
const RATE = +m[1];
const NB = ' ';

function usdToUah(usd){
  const v = usd * RATE, s = v < 1000 ? 50 : 100;
  return Math.floor(v / s + 1e-9) * s;
}
// найменша доларова сума, кратна 5, що дає саме цю гривневу
function uahToUsd(uah){
  if(uah === 0) return 0;
  for(let x = 5; x <= 20000; x += 5) if(usdToUah(x) === uah) return x;
  return null;
}
const num = s => +s.replace(/[\s ]/g, '');
const NUM = '\\d{1,3}(?:[ \\u00a0]\\d{3})*';
// «від 3 100 грн», «+1 800 UAH», «450–650 грн» → «$70», «+$40», «$10–15»
const PRICE = new RegExp('(\\+?)(' + NUM + ')(?:–(' + NUM + '))?[ \\u00a0](?:грн|UAH)(?![а-яіїєґa-z])', 'gi');

function toUsd(text, where){
  const bad = [];
  const out = text.replace(PRICE, (all, sign, a, b) => {
    const x = uahToUsd(num(a)), y = b ? uahToUsd(num(b)) : 0;
    if(x == null || y == null){ bad.push(all); return all; }
    return sign + '$' + x + (b ? '–' + y : '');
  });
  if(bad.length) throw new Error(`currency.js (${where}): гривневі суми без доларового відповідника: ${bad.join(' | ')}`);
  return out;
}

// JSON-LD: Offer у гривні → у долари
function offersToUsd(text){
  return text.replace(/"priceCurrency":"UAH","minPrice":(\d+)/g, (all, n) => {
    const x = uahToUsd(+n);
    if(x == null) throw new Error('currency.js: minPrice без доларового відповідника: ' + n);
    return '"priceCurrency":"USD","minPrice":' + x;
  });
}

module.exports = {RATE, NB, usdToUah, uahToUsd, toUsd, offersToUsd, PRICE};
