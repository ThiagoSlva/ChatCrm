'use strict';

// A small positive delay spreads automatic reads across tabs. It is neither a
// security decision nor a retry of a mutation; user actions still run directly.
window.ClPolling = Object.freeze({
  delay(base) { return base + 150 + Math.floor(Math.random() * 601); }
});
