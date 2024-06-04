import * as net from 'node:net';

export default {
  async fetch(request) {
    const s = net.connect('8888', '127.0.0.1', () => {
      console.log('connected to server', s._getpeername());
    });

    s.setEncoding('utf8');
    s.on('data', console.log);

    s.write('pong1', () => console.log('written 1'));
    s.write('pong2', () => console.log('written 2'));
    s.write('pong3', () => console.log('written 3'));
    s.write('pong4', () => console.log('written 4'));
    s.write('pong5', () => console.log('written 5'));
    s.write('pong6', () => console.log('written 6'));
    s.write('pong7', () => console.log('written 7'));
    s.write('pong8', () => console.log('written 8'));

    s.once('ready', () => console.log('connection ready'));
    s.once('close', () => console.log('connection closed', s));
    s.on('error', (err) => console.log('connection error', err));

    await scheduler.wait(3 * 1000);
    s.end();
    await scheduler.wait(3 * 1000);

    return new Response("ok");
  }
};
