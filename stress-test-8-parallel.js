/**
 * Stress test: 8 parallel POST requests to /press
 * Run this while watching RAM on your Vultr server (Task Manager).
 * Usage: node stress-test-8-parallel.js
 */

const url = 'https://manychat-followupsv2.setty.ai/press';
const body = {
  type: 'text',
  chatId: '55465521',
  message: 'test',
  pageId: 'fb2860983'
};
const headers = {
  'Authorization': 'Bearer pablonicotinepouches',
  'Content-Type': 'application/json'
};

const start = Date.now();
console.log(`Sending 8 parallel requests to ${url} at ${new Date().toISOString()}...\n`);

const requests = Array.from({ length: 8 }, (_, i) => {
  const reqNum = i + 1;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
    .then(async (res) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 100) };
      }
      console.log(`[${elapsed}s] Request ${reqNum}: ${res.status} ${res.statusText}`, data.ok !== undefined ? `ok=${data.ok}` : '');
      return { reqNum, status: res.status, ok: data.ok, data };
    })
    .catch((err) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[${elapsed}s] Request ${reqNum}: ERROR`, err.message);
      return { reqNum, error: err.message };
    });
});

Promise.all(requests).then((results) => {
  const total = ((Date.now() - start) / 1000).toFixed(1);
  const ok = results.filter((r) => r.ok === true).length;
  const err = results.filter((r) => r.error).length;
  console.log(`\nDone in ${total}s. OK: ${ok}/8, Errors: ${err}/8`);
});
