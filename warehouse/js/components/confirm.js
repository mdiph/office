import { h } from "../util/dom.js";
import { openModal } from "./modal.js";

// confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean>
export function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: h("div", { text: message }),
      onClose: () => resolve(false),
    });
    m.setFooter([
      h("button.btn", { text: "Cancel", onclick: () => { m.close(); resolve(false); } }),
      h(`button.btn.${danger ? "btn--danger" : "btn--primary"}`, {
        text: confirmLabel,
        onclick: () => { m.close(); resolve(true); },
      }),
    ]);
  });
}
