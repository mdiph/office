import { h } from "../util/dom.js";
import { icon } from "../util/icons.js";
import { call } from "../api.js";
import { toastErr } from "./toast.js";

// photoField({ value, onChange(fileId) }) -> { el, getFileId }
// Captures a photo (rear camera on mobile), downscales, uploads to backend,
// stores the returned fileId.
export function photoField({ value = null, label = "Photo" } = {}) {
  let fileId = value;
  const preview = h("img", { alt: "", src: previewSrc(fileId), style: fileId ? "" : "display:none" });
  const status = h("span.muted", { style: "font-size:.82rem" });
  const input = h("input", { type: "file", accept: "image/*", style: "display:none" });
  input.setAttribute("capture", "environment");

  const pickBtn = h("button.btn.btn--sm", { type: "button" }, [icon("camera", 14), "Take / choose photo"]);
  const clearBtn = h("button.btn.btn--sm.btn--ghost", { type: "button", text: "Remove", style: fileId ? "" : "display:none" });

  pickBtn.addEventListener("click", () => input.click());
  clearBtn.addEventListener("click", () => {
    fileId = null; preview.style.display = "none"; clearBtn.style.display = "none"; status.textContent = "";
  });

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    status.textContent = "Processing…";
    try {
      const { base64, mime } = await downscale(file, 1600, 0.8);
      status.textContent = "Uploading…";
      const res = await call("uploadImage", { dataBase64: base64, mime, filename: file.name });
      fileId = res.fileId;
      preview.src = res.url || previewSrc(fileId);
      preview.style.display = "";
      clearBtn.style.display = "";
      status.textContent = "Attached";
    } catch (e) {
      toastErr("Image upload failed: " + e.message);
      status.textContent = "";
    }
    input.value = "";
  });

  const el = h("div.field", [
    h("label", { text: label }),
    h("div.photo-field", [preview, pickBtn, clearBtn, status, input]),
  ]);
  return { el, getFileId: () => fileId };
}

function previewSrc(fileId) {
  if (!fileId) return "";
  if (String(fileId).startsWith("data:") || String(fileId).startsWith("http")) return fileId;
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w400`;
}

function downscale(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve({ base64: dataUrl.split(",")[1], mime: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}
