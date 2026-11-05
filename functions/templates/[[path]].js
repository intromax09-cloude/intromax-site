// Шаблоны для клиентов лежат в репозитории, но на сайте их отдавать не нужно.
// Pages отдаёт всю корневую папку как статику; эта функция перехватывает /templates/* раньше статики.
export const onRequest = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
