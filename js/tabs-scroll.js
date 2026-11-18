// ==========================================================
// AlgoTrade — tabs-scroll.js
// Makes the top tab bar (#app-tabs) scrollable sideways (see css/tabs-scroll.css).
// Touch swiping and trackpads scroll it natively. This file adds what a desktop
// mouse needs, because the scrollbar is hidden:
//   - the mouse wheel scrolls the bar sideways while the pointer is over it
//   - click-and-drag scrolls it (a drag never triggers a tab click)
//   - the active tab is brought into view when it changes
// It does not switch tabs: that stays in tabs.js.
// ==========================================================
(function () {
  "use strict";

  const nav = document.getElementById("app-tabs");
  if (!nav) return;

  const overflowing = () => nav.scrollWidth > nav.clientWidth + 1;
  const activeTab = () => nav.querySelector(".app-tab.active");

  function markScrollable() { nav.classList.toggle("is-scrollable", overflowing()); }

  // Scroll the bar so the given tab sits in the middle (or as near as the ends allow).
  function showTab(btn, smooth) {
    if (!btn || !overflowing()) return;
    const nb = nav.getBoundingClientRect(), bb = btn.getBoundingClientRect();
    const target = nav.scrollLeft + (bb.left - nb.left) - (nav.clientWidth - bb.width) / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
  }

  // ---- mouse wheel: scroll the bar sideways (at either end, let the page scroll as usual) ----
  nav.addEventListener("wheel", (e) => {
    if (!overflowing()) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;          // already a sideways gesture: native handling
    const max = nav.scrollWidth - nav.clientWidth;
    if ((e.deltaY > 0 && nav.scrollLeft >= max - 1) || (e.deltaY < 0 && nav.scrollLeft <= 0)) return;
    nav.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // ---- click and drag with a mouse ----
  let startX = 0, startScroll = 0, dragging = false, moved = false;
  nav.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !overflowing()) return;
    startX = e.clientX; startScroll = nav.scrollLeft; dragging = true; moved = false;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 5) { moved = true; nav.classList.add("is-dragging"); }
    if (moved) nav.scrollLeft = startScroll - dx;
  }
  function onUp() {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    nav.classList.remove("is-dragging");
    if (moved) setTimeout(() => { moved = false; }, 0);           // the click that follows a drag is swallowed below
  }
  // A drag must never switch tabs: swallow the click that follows it (capture phase, before tabs.js sees it).
  nav.addEventListener("click", (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
  }, true);

  // ---- keep the active tab in view ----
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest(".app-tab") : null;
    if (btn) showTab(btn, true);
  });
  document.addEventListener("algotrade:tab-shown", () => showTab(activeTab(), true));

  // ---- the bar is hidden until login and its width changes with the screen ----
  function refresh() { markScrollable(); showTab(activeTab(), false); }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refresh).observe(nav);
  window.addEventListener("resize", refresh);
  window.addEventListener("load", refresh);
  refresh();
})();
