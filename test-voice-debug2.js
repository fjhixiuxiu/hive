const WebSocket = require('ws');
const token = require('fs').readFileSync('/Users/dev/dev/hive/.env', 'utf8')
  .split('\n').find(l => l.startsWith('WEB_TOKEN='))?.split('=')[1];

const ws = new WebSocket('ws://127.0.0.1:3000');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'auth' && msg.ok) {
    console.log('Authenticated. Joining meeting...');
    ws.send(JSON.stringify({
      type: 'voice:join',
      url: 'https://us02web.zoom.us/j/2120045747',
      botName: 'Hive',
      reportOnJoin: true,
    }));

    // Query debug info every 10 seconds
    setInterval(() => {
      ws.send(JSON.stringify({ type: 'voice:debug' }));
    }, 10000);
  } else if (msg.type === 'voice:debug') {
    console.log('\n=== VOICE DEBUG ===');
    console.log(JSON.stringify(msg.debug, null, 2));
    console.log('===================\n');
  } else if (msg.type && msg.type.startsWith('voice:')) {
    console.log('VOICE:', JSON.stringify(msg, null, 2));
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
setTimeout(() => { ws.close(); process.exit(0); }, 180000);
