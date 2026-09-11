  // §recent ==================================================================
  // The original key of each of the last few generations, resolved the moment
  // the generation lands and kept apart from the ledger.
  //
  // The ledger is pruned against the library listing: a turn the listing stops
  // naming has its rows dropped on the next read, which is the very moment a
  // lost image is noticed. What is kept here is not the media token but the
  // `gg/<key>` the download rpc answered with, so recovery walks the download
  // chain from it and asks the server nothing else. That is also the
  // experiment this exists to run: a key that still serves after the turn was
  // taken off the conversation and the library says the file outlived its
  // links; a 404 says it did not, and only bytes kept here would have done.
  //
  // localStorage rather than IndexedDB: three rows of a few hundred characters,
  // read at recovery and written once per generation, and nothing to await.
  // RECENT_STORE and RECENT_KEEP live in §settings: the menu reads the buffer
  // at boot, before this part's own top-level statements have run.

  function readRecent() {
    try {
      var raw = localStorage.getItem(RECENT_STORE);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      say('warn', LOG_IMG, 'recent: the buffer could not be read and reads as empty:', err.message);
      return [];
    }
  }

  function writeRecent(list) {
    try {
      localStorage.setItem(RECENT_STORE, JSON.stringify(list));
    } catch (err) {
      say('warn', LOG_IMG, 'recent: the buffer could not be written:', err.message);
    }
  }

  // Newest first, capped. A key already held moves to the front, and a new key
  // for an image already held - the same turn and slot - replaces it, so a
  // repeated landing of one generation cannot fill the ring with itself.
  function recentPush(list, entry, keep) {
    var out = list.filter(function (held) {
      if (held.key === entry.key) return false;
      return !(held.resp === entry.resp && held.slot === entry.slot);
    });
    out.unshift(entry);
    return out.slice(0, keep);
  }

  // The turns a generation answer carries, each with its token rows in the
  // order the download rpc is worth asking in: the row declaring the most bytes
  // first, the longer token as the tiebreak (see tokensOfTurn). The answer
  // streams in chunks that repeat the image node, so rows are reduced to one
  // per token across all of them; a chunk naming no conversation cannot be
  // asked about and contributes nothing.
  function recentRowsFrom(payloads) {
    var byTurn = Object.create(null);
    var turns = [];
    var seen = Object.create(null);
    payloads.forEach(function (chunk) {
      var conv = conversationIn(chunk);
      if (!conv) return;
      tokenEntries(chunk).forEach(function (row) {
        if (seen[row.token]) return;
        seen[row.token] = true;
        var at = row.resp + '#' + row.slot;
        if (!byTurn[at]) {
          byTurn[at] = { resp: row.resp, slot: row.slot, conv: conv, rows: [] };
          turns.push(byTurn[at]);
        }
        byTurn[at].rows.push(row);
      });
    });
    turns.forEach(function (turn) {
      turn.rows.sort(function (a, b) {
        var byBytes = (b.bytes || 0) - (a.bytes || 0);
        if (byBytes) return byBytes;
        return b.token.length - a.token.length;
      });
    });
    return turns;
  }

  // One turn, all the way to a key. The rows are asked in order and the first
  // key answered is kept; a row the rpc refuses, or answers with nothing, hands
  // on to the next, the same way the download button walks a turn.
  function resolveRecent(turn, i) {
    if (i >= turn.rows.length) {
      return Promise.reject(new Error('none of the ' + turn.rows.length
        + ' token(s) was answered with a key'));
    }
    return originalByToken(turn.rows[i], turn.conv).catch(function (err) {
      if (i + 1 >= turn.rows.length) throw err;
      dbg('recent: token ' + (i + 1) + ' of ' + turn.rows.length + ' for ' + turn.resp
        + ' was not answered (' + err.message + '), the next is asked');
      return resolveRecent(turn, i + 1);
    });
  }

  // Called with the chunks of a generation answer once it has landed. One rpc
  // per image generated, made in the background; a text turn carries no token
  // and costs nothing.
  function rememberRecent(payloads) {
    var turns = recentRowsFrom(payloads);
    if (!turns.length) return Promise.resolve();
    return turns.reduce(function (chain, turn) {
      return chain.then(function () {
        return resolveRecent(turn, 0).then(function (key) {
          var list = recentPush(readRecent(), {
            key: key,
            resp: turn.resp,
            slot: turn.slot,
            conv: turn.conv,
            at: Date.now()
          }, RECENT_KEEP);
          writeRecent(list);
          info('recent: kept the original key of ' + turn.resp.slice(-6) + '#' + turn.slot
            + ' (' + list.length + ' on record)');
          renderMenu();
        }, function (err) {
          say('warn', LOG_IMG, 'recent: no original key kept for ' + turn.resp
            + ' - ' + err.message);
        });
      });
    }, Promise.resolve());
  }

  // From the menu. Every held key is walked from its seed and saved, newest
  // first; one that no longer serves is reported with the status the chain
  // answered and the rest still run.
  function recoverRecent() {
    var list = readRecent();
    if (!list.length) {
      say('warn', LOG_IMG, 'recent: nothing on record - a key is kept as each generation lands');
      return Promise.resolve();
    }
    info('recent: recovering ' + list.length + ' generation(s) from the held keys');
    var saved = 0;
    return list.reduce(function (chain, entry, i) {
      return chain.then(function () {
        var id = entry.resp + '#' + entry.slot;
        progress('recover: ' + (i + 1) + ' of ' + list.length + ', walking the chain for '
          + id.slice(-8));
        return followChain(seedUrl(entry.key), 4).then(function (blob) {
          saveBlob(blob, saveName(id, blob.type));
          saved++;
          progress('recover: ' + id.slice(-8) + ' saved', i + 1 === list.length);
        }, function (err) {
          // The finding itself: which of the two the server did to the file.
          say('error', LOG_IMG, 'recent: the held key of ' + entry.resp + '#' + entry.slot
            + ' no longer serves (' + err.message + ') - the file did not outlive its links');
          progress('recover: ' + id.slice(-8) + ' refused, ' + err.message, i + 1 === list.length);
        });
      });
    }, Promise.resolve()).then(function () {
      info('recent: ' + saved + ' of ' + list.length + ' recovered');
    });
  }

