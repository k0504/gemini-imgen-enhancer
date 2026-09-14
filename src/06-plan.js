  // §plan ====================================================================
  // What the attachment array should look like after the resend. Entries are
  // positional, so an existing entry only stores the index it came from and the
  // payload value is read at send time.
  var plan = null;

  function makePlan(host) {
    // A send's preparation begins here, not at the request, so the cost
    // counters start over with the plan rather than with the send.
    resetWork();
    var container = directChild(host, 'file-preview-container');
    // Taken while the message is certainly still in the tree, because the send
    // that consumes this plan is what destroys the node.
    var index = indexOfHost(host);
    var thumbs = recordThumbs(index, function () {
      return (container
        ? Array.prototype.slice.call(container.querySelectorAll('user-query-file-preview'))
        : []).map(function (preview) {
          var img = preview.querySelector('img');
          return img ? img.src : '';
        });
    });
    var base = recordAttachments(index);
    var baseBlobs = recordBlobs(index);
    // Asked as edit mode opens, so a message that cannot be resent says so
    // while the user is still deciding rather than on the press. See §durable
    // for what puts a record in this state; none of it is repairable from here.
    var blocked = recordBlocker(index, appPath());
    if (blocked) {
      say('error', LOG_IMG, 'message #' + index + ' cannot be resent: ' + blocked);
    }
    var entries = thumbs.map(function (thumb, i) {
      return { kind: 'existing', index: i, thumb: thumb };
    });
    dbg('makePlan: message #' + index + ',', thumbs.length, 'attachments, base =',
      base ? 'record (' + attShape(base) + ')' : 'request body (no record)');
    var p = {
      host: host,
      container: container,
      index: index,
      // Which conversation this plan's entries came from. The name lookup it
      // arms below resolves an rpc later, and asking the location by then
      // answered whichever thread the user had routed to: a name map from
      // another conversation misses every thumbnail, and a miss is a permanent
      // rename to image-<n>.jpg.
      conv: conversationId(),
      // And the pathname beside it, because a record is keyed by pathname while
      // an rpc is asked by conversation id, and the two are not interchangeable.
      // Anything judging this plan after an await needs to know which thread it
      // belongs to rather than which one is on screen by then.
      path: appPath(),
      base: base,
      baseBlobs: baseBlobs,
      blocked: blocked,
      // Declared by §retry before it opened edit mode. A retry changes no
      // image; what the flag does for the plan is make planIsDirty report it
      // dirty, which routes its send through the same pipeline as an edit.
      retry: false,
      originalCount: thumbs.length,
      originalThumbs: thumbs.slice(),
      entries: entries,
      armedAt: null,
      sentinelApplied: false
    };
    p.retry = claimRetryIntent(host);
    // As early as edit mode opens. Which entries cost an upload is settled
    // there, once: one whose reference the server still honours - its token,
    // or a contrib this document minted - goes out as it stands, retry or
    // edit, and only a dead contrib is re-uploaded. So the ordinary plan is
    // ready the moment it is made, and the wait, where there is one, is spent
    // before the press rather than inside the answer.
    freshenExisting(p);
    return p;
  }

  function planIsDirty(p) {
    if (!p) return false;
    // A retry changes nothing, but reporting dirty is what routes its send
    // through the plan pipeline - the record, the refresh.
    // Unlocking Update is no longer among the things this decides; that reads
    // readiness alone, in syncSentinel.
    if (p.retry) return true;
    if (p.entries.length !== p.originalCount) return true;
    for (var i = 0; i < p.entries.length; i++) {
      if (p.entries[i].kind !== 'existing' || p.entries[i].index !== i) return true;
    }
    return false;
  }

  // Every entry has to have something to be written from: an existing one the
  // reference it already holds, when the server still honours it, or the fresh
  // contrib of its re-upload when it does not; a new one the contrib its upload
  // minted. settleExisting decides which of the two an existing entry is, once,
  // when the plan is made.
  //
  // This gates the Update button rather than the send, so the wait is spent
  // before the press instead of inside the answer. Most plans have nothing to
  // wait for; the re-uploads that do occur start when edit mode opens.
  function planIsReady(p) {
    // A record that cannot be trusted is not made ready by finishing the
    // uploads: what the list would be written from is the thing in doubt.
    if (p.blocked) return false;
    return p.entries.every(function (entry) {
      return entry.kind === 'existing'
        ? !!(entry.sendAsIs || entry.freshAttachment)
        : !!entry.attachment;
    });
  }

  function activePlan() {
    if (!plan) return null;
    if (plan.armedAt !== null && Date.now() - plan.armedAt > PLAN_TTL_MS) {
      // A dirty plan that expires takes the user's edit with it, and the send
      // that reads this getter a moment later goes out without it, so the loss
      // is reported. A clean one is the ordinary editor closed with Escape:
      // nothing was staged, the next send is usually an unrelated composer
      // message, and a warning there would name a loss that never happened.
      if (planIsDirty(plan)) {
        // The user's staged edit, gone. Nothing incorrect is sent by it - the
        // plan simply stops existing - but what was staged is not recoverable,
        // so it is said at error level rather than dressed up as a cost.
        say('error', LOG_IMG, 'the edit staged on message #' + plan.index
          + ' expired unsent and its changes are dropped');
      } else {
        dbg('activePlan: plan #' + plan.index + ' expired unsent with nothing staged');
      }
      plan = null;
      return null;
    }
    return plan;
  }

  function textareaOf(p) {
    return p.host && p.host.isConnected ? p.host.querySelector('textarea') : null;
  }

  // Angular only notices a value that arrives through the native setter followed
  // by an input event; assigning textarea.value directly leaves its model stale.
  //
  // The caret is put back because the write lands mid-edit: the sentinel follows
  // readiness, and readiness settles when the re-uploads the edit's own opening
  // started land, seconds in, with the user typing. An assigned value collapses
  // the selection to the end of the text, so the caret jumped out of the
  // sentence on the first upload to land and again on the first to fail.
  //
  // The offsets are carried across on the common prefix rather than kept as they
  // stand: the sentinel goes on at the end, but the user types on past it, so a
  // strip can remove a character from before the caret. Anything inside the part
  // both texts share keeps its offset; anything after it moves by the change in
  // length, which is the removal counted without walking the text.
  function writeTextarea(textarea, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var typing = document.activeElement === textarea;
    var before = textarea.value;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    setter.call(textarea, value);
    if (typing) {
      var shared = 0;
      while (shared < before.length && shared < value.length
        && before.charAt(shared) === value.charAt(shared)) shared++;
      textarea.setSelectionRange(carryCaret(start, shared, value.length - before.length, value.length),
        carryCaret(end, shared, value.length - before.length, value.length));
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function carryCaret(offset, shared, delta, length) {
    var moved = offset <= shared ? offset : offset + delta;
    return Math.max(0, Math.min(moved, length));
  }

  // The plan's own flag decides this, never a scan of the current text: a
  // sentinel left behind by an earlier run would otherwise look like one this
  // plan had already applied, so no value change would be dispatched and
  // Gemini's Update button would stay disabled with no way to unlock it.
  //
  // Readiness alone, with no part for dirtiness. Gemini unlocks Update on a
  // change to the prompt text and on nothing else, so waiting for the
  // attachments to change left an edit that changed only the images locked
  // until its uploads landed - and one that changed nothing locked for good,
  // though §resend has had a route for it the whole time: written from the
  // record where there is one, sent as it stands where there is not.
  // Readiness stays because an entry whose reference is dead has nothing to be
  // written from until its re-upload lands, so a plan that is not ready has no
  // list to write and its press would be refused.
  function syncSentinel(p) {
    var textarea = textareaOf(p);
    if (!textarea) return;
    var wanted = planIsReady(p);
    if (wanted === p.sentinelApplied) return;
    dbg('syncSentinel:', wanted ? 'appending zero-width space to textarea' : 'removing zero-width space from textarea');
    writeTextarea(textarea, wanted
      ? textarea.value + SENTINEL
      : textarea.value.split(SENTINEL).join(''));
    p.sentinelApplied = wanted;
  }

  function discardPlan() {
    if (plan) dbg('discardPlan: message #' + plan.index);
    // Nothing was committed, so the thumbnails the strip minted for added files
    // have no reader left. A send takes the other path, where the record keeps
    // them.
    if (plan) releaseEntries(plan.entries);
    if (plan && plan.sentinelApplied) {
      var textarea = textareaOf(plan);
      if (textarea) writeTextarea(textarea, textarea.value.split(SENTINEL).join(''));
    }
    plan = null;
    teardownEditorUi();
  }

  // §freshen =================================================================
  // An existing image goes out with the reference it already holds whenever
  // the server still honours it: the token the page or §refresh gave the
  // record, or a contrib this document minted inside its ttl. That is what the
  // page itself sends on an edit, and what §retry measured at 6.3s against
  // 78.2s for re-uploading everything. Only a contrib the server no longer
  // honours is re-uploaded, from sources tried in order of how much can go
  // wrong with them: the bytes in the record cannot expire or be blocked, and
  // refetching a thumbnail is the last resort because lh3 answers with a scaled
  // copy and the page's CSP blocks blob: URLs outright.
  //
  // This starts the moment the plan is made, so that the send itself stays
  // synchronous.
  function thumbFullSize(url) {
    // A size suffix asks for a scaled copy and s0 asks for the stored original.
    // Most of these URLs carry no suffix at all and redirect to an s512 copy,
    // so the suffix has to be appended rather than replaced; replacing alone
    // sent 512px thumbnails as the reference images. Where the suffix ends is
    // thumbKey's to know, in §refresh, which drops it for the same reason.
    return thumbKey(url) + '=s0';
  }

  // The source is checked before the request is made and the bytes after it
  // answers, and the two checks are deliberately on opposite sides of the
  // transport fallback below: a response that arrived and is not an image is
  // not a transport failure, and routing it into GM_xmlhttpRequest would ask
  // the same address a second time and verify nothing about either answer.
  function fetchBytes(url, what) {
    mustBeImageSource(url, what);
    var got = /^(blob:|data:)/.test(url)
      ? fetch(url).then(function (r) { return r.blob(); })
      : fetchOverNetwork(thumbFullSize(url));
    return got.then(function (blob) {
      return mustBeImageBytes(blob, what + ' fetched from ' + String(url).slice(0, 80))
        .then(function () { return blob; });
    });
  }

  function fetchOverNetwork(full) {
    return fetch(full, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.blob();
    }).catch(function (err) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        throw new Error('cors blocked and GM_xmlhttpRequest not granted; '
          + 'update the dev loader to the current header (' + err + ')');
      }
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: full,
          responseType: 'blob',
          onload: function (r) {
            if (r.status === 200) resolve(r.response);
            else reject(new Error('GM http ' + r.status));
          },
          onerror: function () { reject(new Error('GM network error')); }
        });
      });
    });
  }

  // fallbackName is gone on purpose. It answered a missing name with
  // image-<n>.jpg, and the name handed to an upload is the name the server
  // keeps from then on, so the one branch in this file whose cost was not time
  // was quietly destroying the user's file names. A name that cannot be
  // established stops the entry instead: see serverName.

  // Asked for at most once per plan, and only when the plan has no record to
  // read names from. Opening edit mode and closing it again asks for nothing.
  function planNames(p) {
    if (p.names) return p.names;
    if (p.base) return null;
    var reachable = p.entries.some(function (entry) {
      return typeof entry.thumb === 'string' && entry.thumb.indexOf('http') === 0;
    });
    if (!reachable) return null;
    p.names = namesByThumb(p.conv).catch(function (err) {
      dbg('planNames: names unavailable, falling back to image-<n>.jpg (' + err + ')');
      return null;
    });
    return p.names;
  }

  function serverName(p, entry) {
    var known = p.base && p.base[entry.index];
    if (known && typeof known[1] === 'string' && known[1]) return Promise.resolve(known[1]);
    var pending = planNames(p);
    // The name handed to the upload becomes the name the resent message carries
    // from then on, and no later pass puts the original back. So this is a
    // stop, not a report: the entry gets no fresh attachment, planIsReady stays
    // false, and Update never unlocks - the user keeps a message whose files
    // still have their own names instead of a resend that renamed them.
    //
    // Rejected rather than thrown: the caller invokes this directly rather than
    // from inside a then, so a synchronous throw would escape the per-entry
    // catch in freshenExisting and take the whole plan's freshen pass with it.
    if (!pending) {
      return Promise.reject(new Error('existing#' + entry.index
        + ': no record name, and no thumbnail this conversation can be asked about, '
        + 'so the original file name cannot be established'));
    }
    return pending.then(function (byThumb) {
      var found = byThumb && byThumb[thumbKey(entry.thumb)];
      if (!found) {
        throw new Error('existing#' + entry.index
          + ': the server reports no name for this thumbnail, so the original file '
          + 'name cannot be established');
      }
      return found;
    });
  }

  // Where every byte source in this pipeline meets the server: a refetched
  // thumbnail, a file the user dropped, and bytes read back out of the store
  // all arrive here. The mime goes out as what the bytes are, never as
  // blob.type, which is only what whoever produced them said they were - and
  // the entry adopts the bytes only once they have passed, so a bad set is not
  // kept to be re-sent on the next edit without a fetch.
  function uploadInto(entry, bytes, name, why) {
    return mustBeImageBytes(bytes, 'existing#' + entry.index + ' (' + name + ')')
      .then(function (mime) {
        dbg('freshen: existing#' + entry.index, why, bytes.size + 'B', mime);
        entry.bytes = bytes;
        return uploadFile(new File([bytes], name, { type: mime }));
      })
      .then(function (tuple) {
        entry.freshAttachment = tuple;
        dbg('freshen: existing#' + entry.index, 'fresh contrib ready');
      }).catch(function (err) {
        entry.freshPending = false;
        // Kept so the send that gives up on this entry can say which of the two
        // it is looking at: an upload still running is worth waiting for, one
        // that failed never becomes fast and the wait is spent for nothing.
        entry.freshError = String(err);
        say('warn', LOG_IMG, 'freshen failed for existing#' + entry.index + ':', err);
      });
  }

  // Which existing entries go out as they stand and which have to be
  // re-uploaded first, decided once and synchronously. With no record the
  // page's own list is the reference, and it is read at the send, where it
  // exists; with one, the record's tuple is reused when the server still
  // honours it. Returns the entries that need an upload.
  function settleExisting(p) {
    var uploads = [];
    p.entries.forEach(function (entry) {
      if (entry.kind !== 'existing' || entry.sendAsIs || entry.freshAttachment
        || entry.freshPending) return;
      if (!p.base || attReusable(p.base[entry.index])) {
        entry.sendAsIs = true;
        return;
      }
      uploads.push(entry);
    });
    return uploads;
  }

  function freshenExisting(p) {
    // Nothing is uploaded for a plan that cannot be sent. The re-uploads exist
    // to make the press possible, and this plan has no press to make possible.
    if (p.blocked) {
      dbg('freshen: message #' + p.index + ' is blocked, nothing is uploaded -', p.blocked);
      return;
    }
    var uploads = settleExisting(p);
    dbg('freshen: message #' + p.index + ',', p.entries.filter(function (entry) {
      return entry.kind === 'existing' && entry.sendAsIs;
    }).length, 'existing sent as they stand,', uploads.length, 'to re-upload',
    p.base ? '(from the record)' : '(no record: the page\'s own list is the reference)');
    uploads.forEach(function (entry) {
      entry.freshPending = true;

      serverName(p, entry).then(function (name) {
        var bytes = entry.bytes || (p.baseBlobs && p.baseBlobs[entry.index]) || null;
        if (bytes) return uploadInto(entry, bytes, name, 'uploading from the record,');

        dbg('freshen: existing#' + entry.index, 'no bytes held, refetching from',
          String(entry.thumb).slice(0, 60));
        noteFetchStart();
        return fetchBytes(entry.thumb, 'existing#' + entry.index).then(function (blob) {
          noteFetchEnd();
          return uploadInto(entry, blob, name, 'refetched,');
        });
      }).catch(function (err) {
        entry.freshPending = false;
        entry.freshError = String(err);
        say('warn', LOG_IMG, 'freshen failed for existing#' + entry.index + ':', err);
      }).then(function () {
        // §gate reads what this just settled, and the pass that would otherwise
        // carry it runs on DOM mutations - which an upload landing is not. The
        // press is answered from the plan either way, so what is stale without
        // this is only the look of the button, and it stays stale until
        // something unrelated happens to move the tree.
        syncUpdateGate(p);
      });
    });
  }

  // §apply ===================================================================
  // Whether the send being built is the resend of an edited message. Asked in
  // two places - before the list is written, and by the §resend route that owes
  // the record a truncation hold even when it has no list to write - so the
  // comparison itself lives in one, and the two cannot drift into disagreeing
  // about which sends a plan speaks for.
  function isEditResend(inner) {
    return inner[ACTION_INDEX] === ACTION_EDIT_RESEND;
  }

  // Gemini's own regenerate, plain or Pro. Both are answered the same way and
  // by the same reader, so the two values are compared in one place: see
  // §native-retry.
  function isNativeRetry(inner) {
    var action = inner[ACTION_INDEX];
    return action === ACTION_RETRY || action === ACTION_RETRY_PRO;
  }

  // Writes the plan into the outgoing prompt tuple. null means only that this
  // send is not the one the plan was made for; true that the attachment list
  // was written, false that it was backed out of - a send that is still an edit
  // resend, and still owes the record everything §commit gives one.
  //
  // The sentinel is not this function's to strip. rewrite() takes it off every
  // send that carries it, plan or no plan, which is the only rule that also
  // covers the retry of a message with no attachments; a second strip here
  // could only ever find nothing and read as though it were doing the work.
  function applyPlanTo(inner, p) {
    if (!isEditResend(inner)) {
      dbg('applyPlanTo: action is', JSON.stringify(inner[ACTION_INDEX]), '(not edit resend 2), skip');
      return null;
    }

    var tuple = inner[PROMPT_TUPLE];
    var listWritten = false;

    // The body's own list is what this message holds only while it has never
    // been resent; after that the record is, and the body carries the stale one.
    var base = p.base || tuple[ATTACHMENTS];
    dbg('applyPlanTo: body carries', attShape(tuple[ATTACHMENTS]));
    dbg('applyPlanTo: base =', p.base ? 'record' : 'body', '(' + attShape(base) + ')');
    dbg('applyPlanTo: plan wants', p.entries.map(function (e) {
      return e.kind === 'existing' ? 'existing#' + e.index : 'new:' + e.name;
    }).join(', '));

    // What each entry goes out as, verbatim. An existing entry sent as it
    // stands is the base's own tuple - the record's, or the page's for a
    // message never resent - tail and all: this is the page's own edit resend,
    // so the page's own form is right. One that was re-uploaded is the contrib
    // its upload minted, and a new entry likewise. Nothing is reshaped.
    var refs = p.entries.map(function (entry) {
      if (entry.kind !== 'existing') return entry.attachment || null;
      if (!entry.sendAsIs) return entry.freshAttachment || null;
      var held = Array.isArray(base) ? base[entry.index] : null;
      // Settled at plan time, and asked again here: a contrib's ttl can run
      // out between the two, and the page's list is only read now.
      return attReusable(held) ? held : null;
    });
    // What the list will be written from has to exist first. The count below
    // compares the base against the plan's original length, which says nothing
    // about an entry added since, and a new entry whose upload failed carries
    // no attachment at all.
    var missing = refs.filter(function (ref) { return !ref; }).length;
    var count = Array.isArray(base) ? base.length : 0;
    // Both of these used to leave the list untouched and let the send go. What
    // it went with was the page's list - the images from before this message
    // was last resent - so neither was leaving anything untouched: they were
    // replacing the user's images with older ones. There is no correct list to
    // write in either case, so there is nothing to send.
    if (missing) {
      refuseSend(missing + ' of the attachments for message #' + p.index
        + ' have nothing to be written from');
    } else if (count !== p.originalCount) {
      refuseSend('the record for message #' + p.index + ' holds ' + count
        + ' attachments against the ' + p.originalCount + ' the editor opened with, '
        + 'so which list to write cannot be established');
    } else {
      tuple[ATTACHMENTS] = refs;
      listWritten = true;
      dbg('applyPlanTo: wrote', attShape(tuple[ATTACHMENTS]));
    }

    return listWritten;
  }

  // §shape ===================================================================
  // There is one shape: the edit resend as the page built it. Measured on one
  // five-image message with one prompt, removing a single difference at a
  // time:
  //
  //   action  attachments              conversation tuple    time
  //   2       page's own references    present whole         88.3s
  //   null    mixed contrib, 9 elems   present whole         79.9s
  //   null    all contrib, 2 elems     present whole         58.0s
  //   null    all contrib, 2 elems     cleared               47.1s
  //   null    all contrib, 2 elems     cleared (native)      28.0s
  //   null    all contrib, 2 elems     id kept, resume null  24.2s
  //
  // Every row under the first loses the turn on message #0, and each was
  // shipped for a while because each was measured on a message with a parent.
  //
  // The action code is what makes the server file the send as a revision of
  // the edited turn. With it cleared the server appends a new turn instead,
  // under the same parent the edited message hangs from. On a message with a
  // parent that new turn is the one a reload shows, so the shape measured well
  // and looked right. On message #0 there is no parent: the reload shows the
  // original turn, and every image the resend generated is gone from the
  // conversation and from the library with it. The trace of 2026-09-10 - ten
  // sends against one conversation between 06:59 and 09:53, all of message #0
  // - shows the page's own body carrying action 2 every time, and this script
  // clearing it every time; the resume blob at inner[2][9] was there on some
  // of those sends and absent on others, the page sent action 2 either way,
  // and restoring the blob (3.65.0) changed nothing. Clearing the whole tuple
  // loses the turn differently: the server answers from a conversation of its
  // own, and this one never receives the turn.
  //
  // So nothing here chooses. The action stays 2, the tuple is not touched, an
  // existing image keeps the reference it holds (§freshen), and what is
  // guarded is that every attachment written is one the server honours - a
  // dead contrib fails the send outright, and a list that reaches here with
  // one means §freshen or §gate stopped holding.
  //
  // Answers whether the send may go out.
  function guardSendShape(inner, written, p) {
    var dead = Array.isArray(written)
      ? written.filter(function (att) { return !attReusable(att); }) : [];
    work.images = Array.isArray(written) ? written.length : 0;
    work.shape = 'edit resend';

    if (!Array.isArray(written) || !written.length || dead.length) {
      refuseSend('the attachment list for message #' + p.index + ' holds '
        + (dead.length || 'no') + ' reference' + (dead.length === 1 ? '' : 's')
        + (dead.length ? ' the server would not honour' : '') + ', which the editor should '
        + 'have made impossible: ' + attShape(written));
      return false;
    }
    if (inner[ACTION_INDEX] !== ACTION_EDIT_RESEND) {
      // applyPlanTo returns before writing anything for any other action, so
      // this is not reachable; it is stated so that no later route can clear
      // the action quietly and take the turn with it.
      refuseSend('the action for message #' + p.index + ' is '
        + JSON.stringify(inner[ACTION_INDEX]) + ', not the edit resend the plan was written for');
      return false;
    }

    var convTuple = inner[CONVERSATION_INDEX];
    var hasResume = Array.isArray(convTuple) && convTuple[RESUME_INDEX] != null
      && convTuple[RESUME_INDEX] !== '';
    dbg('guardSendShape: edit resend as the page built it, action', inner[ACTION_INDEX] + ',',
      hasResume ? 'resume blob present' : 'no resume blob', '| conversation',
      (Array.isArray(convTuple) && convTuple[0]) || '(none)', '|', attShape(written));
    return true;
  }

