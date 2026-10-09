// Hands the OAuth redirect (code and state) back to the Facet tab that opened this window.
(function () {
  var msg = document.getElementById('msg');
  if (window.opener) {
    window.opener.postMessage({ type: 'facet-oauth', url: location.href }, location.origin);
    msg.textContent = "You're signed in. You can close this window.";
    setTimeout(function () { window.close(); }, 300);
  } else {
    msg.textContent = 'Return to Facet to finish signing in.';
  }
})();
