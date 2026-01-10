(function initDynamicTopbar() {
  const pill = document.getElementById("topbarPill");
  if (!pill) return;

  const scrollSource =
    document.querySelector(".sidebar-scroll") ||
    document.querySelector(".page-shell") ||
    window;

  let lastY = 0;
  let expanded = true;
  let ticking = false;

  function getScrollY() {
    if (scrollSource === window) return window.scrollY || 0;
    return scrollSource.scrollTop || 0;
  }

  function setExpanded(v) {
    expanded = v;
    pill.classList.toggle("is-compact", !expanded);
    pill.classList.toggle("is-expanded", expanded);
  }

  setExpanded(true);
  lastY = getScrollY();

  function onScroll() {
    const y = getScrollY();
    const delta = y - lastY;

    if (Math.abs(delta) < 6) {
      lastY = y;
      return;
    }

    if (delta > 0 && y > 20) setExpanded(false);
    if (delta < 0) setExpanded(true);

    lastY = y;
  }

  const target = (scrollSource === window) ? window : scrollSource;

  target.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        onScroll();
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  pill.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    setExpanded(true);
    pill.classList.add("pulse");
    window.setTimeout(() => pill.classList.remove("pulse"), 220);
  });

  pill.addEventListener("focusin", () => setExpanded(true));
})();
