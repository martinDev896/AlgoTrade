// ==========================================================
// AlgoTrade — tabs.js
// Switches between the top-level app sections (Manual Trader,
// Copy Trading, Bot Builder, ...). Only Manual Trader has real
// content right now — the others are placeholders until we build them.
// ==========================================================

const appTabButtons = document.querySelectorAll(".app-tab");

appTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    appTabButtons.forEach((b) => b.classList.toggle("active", b === btn));

    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.add("hidden");
    });

    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    if (target) target.classList.remove("hidden");
  });
});
