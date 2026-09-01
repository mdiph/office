import { h, clear } from "../util/dom.js";

// openModal({ title, body: Node, footer: [Node], wide, onClose }) -> { close, setFooter, el }
export function openModal({ title, body, footer, wide, onClose }) {
  const footBar = h("div.modal__foot");
  const modal = h(`div.modal${wide ? ".modal--wide" : ""}`, [
    h("div.modal__head", [
      h("h3", { text: title || "" }),
      h("button.modal__x", { text: "×", type: "button", onclick: () => close() }),
    ]),
    h("div.modal__body", [body]),
    footBar,
  ]);
  const scrim = h("div.modal-scrim", [modal]);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });

  function setFooter(nodes) {
    clear(footBar);
    (nodes || []).forEach((n) => footBar.appendChild(n));
  }
  setFooter(footer);

  function key(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", key);

  function close() {
    document.removeEventListener("keydown", key);
    scrim.remove();
    onClose && onClose();
  }

  document.body.appendChild(scrim);
  const firstInput = modal.querySelector("input,select,textarea,button:not(.modal__x)");
  firstInput && firstInput.focus();
  return { close, setFooter, el: modal };
}
