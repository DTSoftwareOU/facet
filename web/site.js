// Facet site — progressive enhancement only. No tracking, no external requests.
(() => {
  // Source repository. Placeholder: replace with the real repository URL before launch.
  const REPO_URL = 'https://github.com/dtsoftware/facet';

  document.querySelectorAll('[data-repo-path]').forEach((a) => {
    a.href = REPO_URL + a.getAttribute('data-repo-path');
  });
  document.querySelectorAll('[data-repo-text]').forEach((el) => {
    el.textContent = REPO_URL + (el.getAttribute('data-repo-text') || '');
  });

  // Hero gem: facets assemble once, light makes one full turn; hover or tap turns it again.
  const gem = document.querySelector('.hero-gem');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!gem || reduced.matches) return;

  let turning = false;
  const turn = () => {
    if (turning) return;
    turning = true;
    gem.classList.remove('is-turning');
    void gem.getBoundingClientRect(); // restart the animation
    gem.classList.add('is-turning');
    window.setTimeout(() => {
      gem.classList.remove('is-turning');
      turning = false;
    }, 1650);
  };

  gem.classList.add('is-assembling');
  window.setTimeout(() => {
    gem.classList.remove('is-assembling');
    turn();
  }, 1000);

  gem.addEventListener('pointerenter', turn);
  gem.addEventListener('click', turn);
})();
