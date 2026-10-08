// Збирає en/index.html і ru/index.html з index.html (українська версія — джерело).
// Словники: i18n/en.json, i18n/ru.json — ключ = точний рядок з української версії.
// Падає, якщо для якогось рядка нема перекладу, і друкує список: так нова фраза
// на сайті не вийде в інші мови непоміченою. Використання: node i18n/build.js
'use strict';
const fs = require('fs');
const path = require('path');
const {segments, runsOf, collect} = require('./extract.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const SITE = 'https://intromax.com.ua';
const LANGS = {
  en:{html:'en', locale:'en_US', dir:'en'},
  ru:{html:'ru', locale:'ru_RU', dir:'ru'}
};

function escapeFor(run, val){
  if(run.kind === 'js'){
    const q = run.quote || "'";
    return val.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q).replace(/\n/g, '\\n')
      // ключі зберігають екрановані послідовності (’, \n) як є, тому відновлюємо їх
      .replace(/\\\\(u[0-9a-fA-F]{4}|n)/g, '\\$1');
  }
  if(run.kind === 'json') return JSON.stringify(val).slice(1, -1);
  if(run.kind === 'attr') return val.replace(/"/g, '&quot;');
  return val; // текст HTML: у перекладах допускаються теги як у джерелі
}

function translate(html, dict, lang){
  const missing = new Set(), used = new Set();
  const out = segments(html).map(seg => {
    const runs = [...runsOf(seg)];
    if(!runs.length) return seg.text;
    let text = seg.text;
    for(let i = runs.length - 1; i >= 0; i--){
      const r = runs[i];
      if(!(r.text in dict)){ missing.add(r.text); continue; }
      used.add(r.text);
      text = text.slice(0, r.start) + escapeFor(r, dict[r.text]) + text.slice(r.end);
    }
    return text;
  }).join('');
  return {out, missing:[...missing], unused:Object.keys(dict).filter(k => !used.has(k))};
}

function localize(html, lang){
  const L = LANGS[lang];
  let s = html;
  const rep = (a, b, n = 1) => {
    const c = s.split(a).length - 1;
    if(c !== n) throw new Error(`[${lang}] якір x${c}, очікував ${n}: ${a.slice(0, 80)}`);
    s = s.split(a).join(b);
  };
  rep('<html lang="uk">', `<html lang="${L.html}">`);
  rep(`<link rel="canonical" href="${SITE}/">`, `<link rel="canonical" href="${SITE}/${L.dir}/">`);
  rep(`<meta property="og:url" content="${SITE}/">`, `<meta property="og:url" content="${SITE}/${L.dir}/">`);
  rep('<meta property="og:locale" content="uk_UA">', `<meta property="og:locale" content="${L.locale}">`);
  // перемикач мов: поточна мова підсвічена
  s = s.replace(/ aria-current="page"/g, '');
  const cur = `href="/${L.dir}/" hreflang="${lang}"`;
  const n = s.split(cur).length - 1;
  if(n < 2) throw new Error(`[${lang}] перемикач мов не знайдено (${n})`);
  s = s.split(cur).join(cur + ' aria-current="page"');
  // JSON-LD: адреса сторінки
  rep(`"url":"${SITE}/",`, `"url":"${SITE}/${L.dir}/",`);
  return s;
}

function main(){
  const html = fs.readFileSync(SRC, 'utf8');
  if(/src="img\//.test(html) || /href="favicon-180\.png"/.test(html)){
    throw new Error('у index.html є відносні шляхи до картинок: зроби їх абсолютними (/img/..., /favicon-180.png)');
  }
  let failed = false;
  for(const lang of Object.keys(LANGS)){
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, lang + '.json'), 'utf8'));
    const {out, missing, unused} = translate(html, dict, lang);
    if(missing.length){
      failed = true;
      console.error(`\n[${lang}] без перекладу: ${missing.length}`);
      missing.forEach(m => console.error('  ' + JSON.stringify(m)));
    }
    if(unused.length){
      console.error(`\n[${lang}] у словнику є, на сторінці нема (застарілі ключі): ${unused.length}`);
      unused.forEach(m => console.error('  ' + JSON.stringify(m)));
    }
    if(lang === 'en'){
      const left = [...collect(out).keys()];
      if(left.length){
        failed = true;
        console.error(`\n[en] кирилиця лишилась у результаті: ${left.length}`);
        left.forEach(m => console.error('  ' + JSON.stringify(m)));
      }
    }
    if(missing.length) continue;
    const dir = path.join(ROOT, LANGS[lang].dir);
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir, 'index.html'), localize(out, lang));
    console.log(`${lang}/index.html зібрано, рядків перекладено: ${Object.keys(dict).length - unused.length}`);
  }
  if(failed) process.exit(1);
}

main();
