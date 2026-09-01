import { h } from "../util/dom.js";
import { openModal } from "./modal.js";

// confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean>
export function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const m = openModal({
      title,
      body: h("div", { text: message }),
      onClose: () => finish(false), // X button / Escape / scrim click
    });
    m.setFooter([
      h("button.btn", { text: "Cancel", onclick: () => { finish(false); m.close(); } }),
      h(`button.btn.${danger ? "btn--danger" : "btn--primary"}`, {
        text: confirmLabel,
        onclick: () => { finish(true); m.close(); }, // set result BEFORE close() triggers onClose
      }),
    ]);
  });
}
