// When the agent's poll confirms delivery, the chat says so once per batch, as the system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, chromePage } from '../server.mjs';

const open = () => {
  const store = new SessionStore();
  const session = store.open('/tmp/ack-plan.html');
  return { store, session };
};
const systemMsgs = (session) => session.chat.filter((m) => m.from === 'system');

test('recordDelivered adds one system chat entry for the batch, singular', () => {
  const { store, session } = open();
  store.recordDelivered(session.key, [{ type: 'comment', text: 'a' }]);
  const msgs = systemMsgs(session);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'the agent received 1 item and is working on it');
});

test('a batch of three is one entry, plural', () => {
  const { store, session } = open();
  store.recordDelivered(session.key, [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const msgs = systemMsgs(session);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'the agent received 3 items and is working on it');
});

test('repeating recordDelivered for the same items adds nothing', () => {
  const { store, session } = open();
  const batch = [{ text: 'a' }, { text: 'b' }];
  store.recordDelivered(session.key, batch);
  store.recordDelivered(session.key, batch);
  assert.equal(systemMsgs(session).length, 1);
});

test('a later batch gets its own entry, counting only its new items', () => {
  const { store, session } = open();
  const a = { text: 'a' };
  store.recordDelivered(session.key, [a]);
  store.recordDelivered(session.key, [a, { text: 'b' }]);
  assert.deepEqual(systemMsgs(session).map((m) => m.text), [
    'the agent received 1 item and is working on it',
    'the agent received 1 item and is working on it',
  ]);
});

test('no entry when nothing was delivered or the session is unknown', () => {
  const { store, session } = open();
  store.recordDelivered(session.key, []);
  store.recordDelivered('/nope', [{ text: 'a' }]);
  assert.equal(systemMsgs(session).length, 0);
});

test('the shell labels system messages as curator and styles them quietly', () => {
  const html = chromePage({ id: 'abc', file: '/tmp/p.html' });
  assert.match(html, /\.msg\.system/);
  assert.match(html, /'system'/);
  assert.match(html, /'curator'/);
});
