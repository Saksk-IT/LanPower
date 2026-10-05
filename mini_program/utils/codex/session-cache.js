// Retain one authorized Cloud session in memory across native page unload/recreation.
// Nothing from this lease is persisted; account/Cloud/device changes dispose it immediately.
let retained = null;

function discardRetainedSession() {
  const entry = retained; retained = null;
  if (entry) { clearTimeout(entry.timer); entry.session.dispose(); }
}

function retainSession(key, session, duration = 60000) {
  discardRetainedSession();
  const entry = retained = {key, session};
  entry.timer = setTimeout(() => { if (retained === entry) discardRetainedSession(); }, duration);
  if (entry.timer && entry.timer.unref) entry.timer.unref();
}

function takeRetainedSession(key) {
  if (!retained) return null;
  if (retained.key !== key) { discardRetainedSession(); return null; }
  const entry = retained; retained = null; clearTimeout(entry.timer); return entry.session;
}

module.exports = {retainSession, takeRetainedSession, discardRetainedSession};
