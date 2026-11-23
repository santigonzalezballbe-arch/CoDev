// Who has a session open, from the CoDev logs in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSessions, lastSession, openMarker, closeMarker, needsClose } from '../desktop/presence.js';

const NOW = Date.UTC(2026, 10, 23, 15, 0);
const MIN = 60_000;

test('the last marker in each log decides', () => {
  const pau = `## task\nsome work\n\n## 14:50 — Pau opened a session\n${openMarker({ ts: NOW - 10 * MIN, room: 'CoDev', name: 'Pau' })}\n`;
  const ana = `${openMarker({ ts: NOW - 60 * MIN, room: 'r', name: 'Ana' })}\n\n${closeMarker({ ts: NOW - 30 * MIN })}\n`;
  const old = `${openMarker({ ts: NOW - 13 * 60 * MIN, room: 'r', name: 'Old' })}\n`;
  const none = '## a task with no session markers\n';
  const got = openSessions(
    [
      { file: 'codev/history/pau.md', text: pau },
      { file: 'codev/history/ana.md', text: ana },
      { file: 'codev/history/old.md', text: old },
      { file: 'codev/history/none.md', text: none },
    ],
    NOW
  );
  assert.deepEqual(got, [{ name: 'Pau', room: 'CoDev', since: NOW - 10 * MIN, file: 'codev/history/pau.md' }]);
});

test('a session reopened after closing counts again, and quotes cannot break the marker', () => {
  const text = [openMarker({ ts: 1, room: 'a' }), closeMarker({ ts: 2 }), openMarker({ ts: 3, room: 'my "room"', name: 'Jo<an>' })].join('\n');
  assert.deepEqual(lastSession(text), { state: 'open', ts: 3, room: 'my room', name: 'Joan' });
});

test('a killed terminal closes only the session it started, and only once', () => {
  const opened = openMarker({ ts: 1000_000, room: 'r', name: 'Foix' });
  assert.equal(needsClose(opened, 1000_000 - 2000), true, 'its own session, still open');
  assert.equal(needsClose(`${opened}\n${closeMarker({ ts: 1000_500 })}`, 1000_000), false, 'the hook already closed it');
  assert.equal(needsClose(opened, 1000_000 + 10 * 60_000), false, 'an older session is not this terminal’s');
  assert.equal(needsClose('', 0), false, 'no log');
});
