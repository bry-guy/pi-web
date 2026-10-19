// Hover hints for [data-tip] controls: shown after a short hover or on keyboard focus,
// and immediately when moving between controls while one is already visible. Not on touch.
const DELAY_MS = 500;
const WARM_MS = 300;

export function installHints(doc = document) {
  let el = null;
  let target = null;
  let timer = 0;
  let hiddenAt = 0;

  const hide = () => {
    clearTimeout(timer);
    if (el) { el.remove(); el = null; hiddenAt = Date.now(); }
    target = null;
  };
  const show = node => {
    if (!node.isConnected) return;
    el = doc.createElement("div");
    el.className = "hint";
    el.setAttribute("role", "tooltip");
    el.textContent = node.dataset.tip;
    doc.body.append(el);
    const r = node.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), doc.documentElement.clientWidth - w - 4);
    const top = r.top - h - 6 < 4 ? r.bottom + 6 : r.top - h - 6;
    Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
  };
  const arm = node => {
    if (node === target) return;
    hide();
    target = node;
    const warm = Date.now() - hiddenAt < WARM_MS;
    timer = setTimeout(() => show(node), warm ? 0 : DELAY_MS);
  };

  doc.addEventListener("pointerover", e => {
    if (e.pointerType === "touch") return;
    const node = e.target.closest?.("[data-tip]");
    if (node) arm(node);
    else if (target) hide();
  });
  doc.addEventListener("pointerout", e => {
    if (target && !target.contains(e.relatedTarget)) hide();
  });
  doc.addEventListener("focusin", e => {
    const node = e.target.closest?.("[data-tip]");
    if (node && node.matches(":focus-visible")) arm(node);
  });
  doc.addEventListener("focusout", hide);
  doc.addEventListener("pointerdown", hide, true);
  doc.addEventListener("scroll", hide, true);
}
