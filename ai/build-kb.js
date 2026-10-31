// Збирає базу знань AI-агента чату: текст сайту (index.html, розділи від «Послуг» до «Кому підходить»)
// + факти з ai/about.md → functions/_lib/kb.js. Запускати після будь-якої правки текстів, цін чи about.md:
//   node inbox/intromax-site/ai/build-kb.js   (з кореня сховища)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const from = html.indexOf('<section id="services"');
const to = html.indexOf('<section id="reviews"');
if(from < 0 || to < 0) throw new Error('Не знайшов розділи services / reviews в index.html');

const ENT = {'&nbsp;':' ', '&amp;':'&', '&quot;':'"', '&#39;':"'", '&rsquo;':"'", '&lsquo;':"'", '&laquo;':'«', '&raquo;':'»', '&mdash;':'—', '&ndash;':'–', '&lt;':'<', '&gt;':'>', '&#8249;':'', '&#8250;':''};

function text(part){
  return part
    .replace(/<(script|style|svg|button|form|canvas|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // ціна запуску із закресленою звичайною: <b class="pr" data-full="$100–200"><s>$100–200</s>$70–140</b>
    .replace(/<b class="pr" data-full="([^"]*)">(?:<s>[^<]*<\/s>)?([^<]*)<\/b>/g, '$2 (ціна запуску; звичайна $1)')
    // блоки, що діють лише до акції або лише після неї
    .replace(/(<[a-z0-9]+\b[^>]*\sdata-promo\b[^>]*>)/gi, '$1[до 31 грудня 2026] ')
    .replace(/(<[a-z0-9]+\b[^>]*\sdata-after\b[^>]*>)/gi, '$1[з 1 січня 2027] ')
    .replace(/<h2\b[^>]*>/gi, '\n\n## ').replace(/<h3\b[^>]*>/gi, '\n### ')
    .replace(/<(li)\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/h\d|\/div|\/tr|\/summary|\/li|\/details)\b[^>]*>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&[#a-z0-9]+;/gi, function(e){ return e in ENT ? ENT[e] : e; })
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(function(l){ return l.trim(); }).filter(Boolean)
    // одинокі цифри й службові підписи конструктора не несуть змісту
    .filter(function(l){ return !/^(\$0|\d{2} \/ [a-zа-яі]+|Додати в комплект|Ваш комплект|Заявка|Зібрати пакет|Відкрити живий сайт ↗)$/i.test(l); })
    .join('\n')
    .replace(/\n(## |### )/g, '\n\n$1')
    .trim();
}

const site = text(html.slice(from, to));
const about = fs.readFileSync(path.join(__dirname, 'about.md'), 'utf8')
  .replace(/^# .*\n+[\s\S]*?\n(?=## )/, ''); // без заголовка й службового пояснення

const kb = '# Сайт intromax.com.ua (текст сторінки)\n\n' + site + '\n\n# Додаткові факти про Intromax\n\n' + about.trim() + '\n';
const out = '// Згенеровано ai/build-kb.js з index.html і ai/about.md. Руками не правити.\n' +
  'export const KB = ' + JSON.stringify(kb) + ';\n';
fs.writeFileSync(path.join(ROOT, 'functions', '_lib', 'kb.js'), out);
console.log('kb.js: ' + kb.length + ' символів, ~' + Math.round(kb.length / 3.2) + ' токенів');
