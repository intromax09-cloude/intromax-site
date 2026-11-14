// Службові файли (i18n/) лежать у репозиторії, але на сайті їх віддавати не можна.
// Pages віддає всю кореневу папку як статику; ця функція перехоплює /i18n/* раніше статики (так само, як functions/templates).
export const onRequest = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
