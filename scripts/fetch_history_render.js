const http = require('http');
const fs = require('fs');
const url = 'http://127.0.0.1:3002/admin/history/year/4/class/1';

http.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    fs.writeFileSync('debug_history_render.html', data);
    console.log('Saved rendered HTML to debug_history_render.html, statusCode:', res.statusCode);
  });
}).on('error', (err) => {
  console.error('Request error:', err.message);
});
