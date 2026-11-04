# Правки по аудиту (ветка fix/site-2 → audit/2026-11-04)

Проверка для всех пунктов: `node i18n/build.js` (exit 0, «en/ru зібрано, рядків перекладено: 1129»); JSON-LD во всех трёх файлах парсится; страницы `/`, `/en/`, `/ru/` открыты в Playwright (Chromium) на 375 и 1280 px: горизонтальной прокрутки нет (scrollWidth = clientWidth), ошибок JS нет, скриншоты просмотрены.
Откат любого пункта: `git revert <коммит>` либо вернуть указанные фрагменты; после правки `index.html` или `i18n/*.json` выполнить `node i18n/build.js`.

| № | Что изменено | Как проверено | Как откатить |
|---|---|---|---|
| 1 | В JSON-LD (`index.html`, `en/`, `ru/`) удалён `maxPrice` у 7 Offer; `minPrice` совпадает с видимым «від $X», `priceCurrency`, `validThrough` оставлены. Цены на странице не менялись | `grep maxPrice` = 0; JSON-LD парсится как JSON; PriceSpecification с одним `minPrice` валиден по schema.org | вернуть `,"maxPrice":N` (значения в аудите, находка 1) |
| 2 | «діапазон» заменён на «від $X / стартовая сумма» в блоке цен, FAQ и FAQ JSON-LD; переводы EN/RU в `i18n/en.json`, `ru.json`, `strings.json` (2 ключа) | сборка прошла, слово «діапазон/range/диапазон» в видимых текстах не осталось (остальные «range» — ползунки калькулятора) | вернуть старые ключи/значения в 4 файлах и пересобрать |
| 13 | Мобильный (≤760 px): `.dock-cta` и `.pp-switch button` `min-height:44px`; `.lang a` — область клика 44+ px через `::after` (вид не меняется). Десктоп без изменений | Playwright 375 px: `.lang a` 45×46, `.dock-cta` высота 44, `.pp-switch button` min-height 44px; на 1280 px размеры прежние (30/42/37) | удалить три `@media (max-width:760px)` правила рядом с `.lang`, `.dock-cta`, `.pp-switch` |
| 14 | `input.field:focus-visible` и `.field input:focus-visible` получили `outline:2px solid var(--amber)` | по CSS (в браузере с клавиатурой не снимал скриншот фокуса) | удалить добавленные строки focus-visible |
| 15 | Новый токен `--amber-dim-text:#a8843f` (4,64:1 на `--ink-2`) только для текста `.dock-sheet a.seen b`; `--amber-dim` для фонов (644, 767) не тронут | расчёт контраста WCAG: было 3,21:1, стало 4,64:1 | вернуть `var(--amber-dim)` в правиле, убрать токен |
| 10 | `_headers`: `Cache-Control` для `/img/*` (30 суток), `/og-image.png`, `/favicon-180.png` (сутки); `Strict-Transport-Security: max-age=15552000` (6 мес., без includeSubDomains/preload); CSP только `Content-Security-Policy-Report-Only` | синтаксис просмотрен; в Pages заголовки не применяются локально, проверить на деплое (DevTools → консоль покажет нарушения CSP, ничего не блокируется) | вернуть прежний `_headers` |
| 16 | Удалены `data-netlify`, `netlify-honeypot` и ветка `netlify.app`: `REVIEW_ENDPOINT = '/api/review'`. Скрытое поле `form-name`/`bot-field` оставлено (JS их может читать) | форма отправляется через fetch на `/api/review` (код не менялся); сборка OK | вернуть строки из диффа |
| 18 | `og:locale:alternate` в `index.html` (en_US, ru_RU); `i18n/build.js` подставляет для каждой версии остальные локали | в `en/` — uk_UA, ru_RU; в `ru/` — uk_UA, en_US; сборка работает | убрать два `<meta>` и блок `alts` в `build.js` |

Не менялось: цены, оффер, структура, `functions/`, секреты, находки 8, 9, 11, 12 (см. `docs/site-todo.md`).
