// Службові файли (reports/) лежать у репозиторії, але на сайті їх віддавати не можна.
// Pages віддає всю кореневу папку як статику; ця функція перехоплює /reports/* раніше статики (так само, як functions/templates).
export const onRequest = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
