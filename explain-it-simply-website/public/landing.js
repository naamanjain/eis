/* Landing page: the only dynamic thing here is an honest statement about the
   backend this site is pointed at. No fake counters, no fabricated testimonials. */
(function () {
  'use strict';

  const note = document.getElementById('privacy-note');

  function text(node, value) {
    if (node) node.textContent = value;
  }

  async function describe() {
    if (!note || typeof fetch !== 'function') return;
    try {
      const res = await fetch('api/catalog');
      if (!res.ok) throw new Error(String(res.status));
      const catalog = await res.json();
      const provider = (catalog.providers || []).find((item) => item.id === (catalog.selected && catalog.selected.providerId));
      text(note, `Powered by ${provider ? provider.name : 'a configured provider'} (${catalog.selected && catalog.selected.model}). `
        + `${catalog.streaming ? 'Answers stream in as the model writes them.' : 'Answers arrive complete.'} `
        + `Ask up to ${((catalog.limits && catalog.limits.maxQueryChars) || 0).toLocaleString()} characters per question.`);
    } catch (error) {
      text(note, 'The explanation backend is not reachable right now, so nothing would be sent. Try again shortly.');
    }
  }

  if (typeof document !== 'undefined' && document.readyState !== 'loading') describe();
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', describe);
})();
