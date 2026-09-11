  // §settings ================================================================
  var STORE_PRO = 'forceNbPro';
  var STORE_IMG = 'promptImageEditor';
  var STORE_USAGE = 'usageDisplay';
  // §recent's buffer (localStorage). Declared here rather than in 15-recent.js
  // because renderMenu() runs at boot, ahead of that part's own statements.
  var RECENT_STORE = 'gpieRecent';
  var RECENT_KEEP = 3;

  var hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  var forcePro = hasGM ? GM_getValue(STORE_PRO, true) : true;
  var imageEditor = hasGM ? GM_getValue(STORE_IMG, true) : true;
  var usageDisplay = hasGM ? GM_getValue(STORE_USAGE, true) : true;

  // The menu caption is the only status indicator a userscript has, so it
  // carries the current value and is re-rendered on every toggle.
  var menuIds = [];

  function renderMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (typeof GM_unregisterMenuCommand === 'function') {
      menuIds.forEach(function (id) { GM_unregisterMenuCommand(id); });
    }
    menuIds = [
      GM_registerMenuCommand('Force Nano Banana Pro: ' + (forcePro ? 'ON' : 'OFF'), function () {
        forcePro = !forcePro;
        if (hasGM) GM_setValue(STORE_PRO, forcePro);
        renderMenu();
        say('log', LOG_PRO, 'force =', forcePro ? 'ON' : 'OFF', '(applies to the next request)');
      }),
      GM_registerMenuCommand('Prompt Image Editor: ' + (imageEditor ? 'ON' : 'OFF'), function () {
        imageEditor = !imageEditor;
        if (hasGM) GM_setValue(STORE_IMG, imageEditor);
        if (!imageEditor) discardPlan();
        renderMenu();
        schedule();
      }),
      GM_registerMenuCommand('Usage Display: ' + (usageDisplay ? 'ON' : 'OFF'), function () {
        usageDisplay = !usageDisplay;
        if (hasGM) GM_setValue(STORE_USAGE, usageDisplay);
        // Turning it back on reads at once rather than waiting for the poll,
        // and turning it off drops the line, which brings Gemini's own text
        // back with it.
        if (usageDisplay) readUsage('menu toggle', true);
        else detachUsageLine();
        renderMenu();
        schedule();
      }),
      // An action rather than a toggle. It issues one request per conversation,
      // which is a thing to be asked for rather than to happen on a page visit.
      GM_registerMenuCommand('Sweep Original Keys', function () {
        sweepOrigins();
      }),
      // The last few generations, by the keys §recent kept as they landed.
      // Walks the download chain only; nothing is asked of the rpc, which is
      // what makes it answer for an image the conversation no longer shows.
      GM_registerMenuCommand('Recover Recent Generations (' + readRecent().length + ')',
        function () {
          recoverRecent();
        }),
      GM_registerMenuCommand('Debug Trace: ' + (debugTrace ? 'ON' : 'OFF'), function () {
        debugTrace = !debugTrace;
        if (hasGM) GM_setValue(STORE_DBG, debugTrace);
        renderMenu();
        info('debug trace =', debugTrace ? 'ON' : 'OFF');
      })
    ];
  }

