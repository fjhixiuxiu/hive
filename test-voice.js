const WebSocket = require('ws');
const token = require('fs').readFileSync('/Users/dev/dev/hive/.env', 'utf8')
  .split('\n').find(l => l.startsWith('WEB_TOKEN='))?.split('=')[1];

if (!token) { console.error('No WEB_TOKEN found'); process.exit(1); }

const ws = new WebSocket('ws://127.0.0.1:3000');
ws.on('open', () => {
  console.log('Connected to hive');
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'auth') {
    console.log('Authenticated:', msg.ok);
    if (msg.ok) {
      console.log('Sending voice:join...');
      ws.send(JSON.stringify({
        type: 'voice:join',
        url: 'https://us02web.zoom.us/j/2120045747',
        botName: 'Hive',
        reportOnJoin: true,  // deliver standup report on join
      }));
    }
  } else if (msg.type.startsWith('voice:')) {
    console.log('VOICE:', JSON.stringify(msg, null, 2));
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
ws.on('close', () => console.log('Disconnected'));

// Keep alive for 2 minutes
setTimeout(() => { ws.close(); process.exit(0); }, 120000);
