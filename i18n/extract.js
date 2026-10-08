// Витягує з index.html усі рядки з кирилицею, які треба перекласти:
// текстові вузли HTML, значення атрибутів, рядкові літерали в <script>, JSON-LD.
// Стилі (<style>) і коментарі не чіпає. Використання: node i18n/extract.js > i18n/strings.json
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'index.html');
const CYR = /[Ѐ-ӿ]/;

// Розбиває файл на сегменти: html | style | script | json. Повертає масив {type, text}.
function segments(html){
  const out = [];
  const re = /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let last = 0, m;
  while((m = re.exec(html))){
    if(m.index > last) out.push({type:'html', text:html.slice(last, m.index)});
    const open = m[0].match(/^<(style|script)\b[^>]*>/i)[0];
    const close = m[0].slice(-(m[1].length + 3));
    const body = m[0].slice(open.length, m[0].length - close.length);
    const isLd = /application\/ld\+json/i.test(open);
    out.push({type:'html', text:open});
    out.push({type: m[1].toLowerCase() === 'style' ? 'style' : (isLd ? 'json' : 'script'), text:body});
    out.push({type:'html', text:close});
    last = m.index + m[0].length;
  }
  if(last < html.length) out.push({type:'html', text:html.slice(last)});
  return out;
}

// HTML-сегмент: текстові вузли між тегами + значення атрибутів із кирилицею. Коментарі пропускає.
// Повертає {kind, text, start, end} — межі в межах сегмента, щоб build міг підставити переклад на місце.
function* htmlRuns(text){
  const re = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g;
  let m;
  while((m = re.exec(text))){
    const tok = m[0];
    if(tok.startsWith('<!--')) continue;
    if(tok.startsWith('<')){
      const attrRe = /\s([a-zA-Z-]+)=("([^"]*)"|'([^']*)')/g;
      let a;
      while((a = attrRe.exec(tok))){
        const val = a[3] !== undefined ? a[3] : a[4];
        if(CYR.test(val)){
          const off = m.index + a.index + a[0].indexOf(val, a[1].length + 2);
          yield {kind:'attr', name:a[1], text:val, start:off, end:off + val.length};
        }
      }
    } else if(CYR.test(tok)){
      const lead = tok.match(/^\s*/)[0].length, trail = tok.match(/\s*$/)[0].length;
      const t = tok.slice(lead, tok.length - trail);
      if(t) yield {kind:'text', text:t, start:m.index + lead, end:m.index + tok.length - trail};
    }
  }
}

// JS-сегмент: рядкові літерали в лапках ' або ". Коментарі й регулярні вирази пропускає.
function* jsRuns(text){
  let i = 0, n = text.length;
  while(i < n){
    const c = text[i];
    if(c === '/' && text[i+1] === '/'){ const j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if(c === '/' && text[i+1] === '*'){ const j = text.indexOf('*/', i); i = j < 0 ? n : j + 2; continue; }
    if(c === '/'){
      // регулярний вираз, якщо перед / стоїть оператор, дужка або return: пропускаємо до закривної /
      const before = text.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
      if(/[(,=:[!&|?{};]$/.test(before) || /\breturn$/.test(before)){
        let j = i + 1, cls = false;
        while(j < n){
          const d = text[j];
          if(d === '\\'){ j += 2; continue; }
          if(d === '[') cls = true;
          else if(d === ']') cls = false;
          else if(d === '/' && !cls) break;
          else if(d === '\n') break;
          j++;
        }
        i = j + 1; continue;
      }
    }
    if(c === "'" || c === '"'){
      let j = i + 1, raw = '';
      while(j < n && text[j] !== c){
        if(text[j] === '\\'){ raw += text[j] + text[j+1]; j += 2; continue; }
        raw += text[j]; j++;
      }
      if(CYR.test(raw)) yield {kind:'js', text:raw, start:i + 1, end:j, quote:c};
      i = j + 1; continue;
    }
    i++;
  }
}

function* jsonRuns(text){
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while((m = re.exec(text))) if(CYR.test(m[1])) yield {kind:'json', text:m[1], start:m.index + 1, end:m.index + 1 + m[1].length};
}

function runsOf(seg){
  if(seg.type === 'html') return htmlRuns(seg.text);
  if(seg.type === 'script') return jsRuns(seg.text);
  if(seg.type === 'json') return jsonRuns(seg.text);
  return [];
}

function collect(html){
  const seen = new Map();
  for(const seg of segments(html)){
    for(const r of runsOf(seg)) if(!seen.has(r.text)) seen.set(r.text, r.kind);
  }
  return seen;
}

module.exports = {segments, runsOf, collect};

if(require.main === module){
  const html = fs.readFileSync(SRC, 'utf8');
  const map = collect(html);
  const obj = {};
  for(const [k] of map) obj[k] = '';
  process.stdout.write(JSON.stringify(obj, null, 1));
  console.error('рядків: ' + map.size);
}
