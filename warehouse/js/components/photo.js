import { h } from "../util/dom.js";
import { icon } from "../util/icons.js";
import { call } from "../api.js";
import { openModal } from "./modal.js";
import { toastErr } from "./toast.js";

const MAX_DIM = 1600;
const QUALITY = 0.8;

// photoField({ value, label }) -> { el, getFileId }
// Attach a photo by picking/taking a file, or (where supported) capturing from a webcam.
// Images are downscaled client-side then uploaded; only the returned fileId is kept.
export function photoField({ value = null, label = "Photo" } = {}) {
  let fileId = value;
  const preview = h("img", { alt: "", src: previewSrc(fileId), style: fileId ? "" : "display:none" });
  const status = h("span.muted", { style: "font-size:.82rem" });
  const input = h("input", { type: "file", accept: "image/*", style: "display:none" });
  input.setAttribute("capture", "environment");

  const pickBtn = h("button.btn.btn--sm", { type: "button" }, [icon("camera", 14), "Take / choose photo"]);
  const webcamBtn = h("button.btn.btn--sm", { type: "button" }, [icon("camera", 14), "Use webcam"]);
  const clearBtn = h("button.btn.btn--sm.btn--ghost", { type: "button", text: "Remove", style: fileId ? "" : "display:none" });

  async function attach({ base64, mime }, filename) {
    status.textContent = "Uploading…";
    try {
      const res = await call("uploadImage", { dataBase64: base64, mime, filename });
      fileId = res.fileId;
      preview.src = res.url || previewSrc(fileId);
      preview.style.display = "";
      clearBtn.style.display = "";
      status.textContent = "Attached";
    } catch (e) {
      toastErr("Image upload failed: " + e.message);
      status.textContent = "";
    }
  }

  pickBtn.addEventListener("click", () => input.click());
  webcamBtn.addEventListener("click", () => openWebcamCapture(async (shot) => {
    status.textContent = "Uploading…";
    await attach(shot, "webcam.jpg");
  }));
  clearBtn.addEventListener("click", () => {
    fileId = null; preview.style.display = "none"; clearBtn.style.display = "none"; status.textContent = "";
  });

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    status.textContent = "Processing…";
    try {
      await attach(await downscaleFile(file), file.name);
    } catch (e) {
      toastErr("Image upload failed: " + e.message);
      status.textContent = "";
    }
    input.value = "";
  });

  const el = h("div.field", [
    h("label", { text: label }),
    h("div.photo-field", [preview, pickBtn, webcamBtn, clearBtn, status, input]),
  ]);
  return { el, getFileId: () => fileId };
}

// Why the webcam might not be usable, as an actionable message (or null if it should work).
function webcamBlockReason() {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    if (!window.isSecureContext) {
      return "The webcam needs a secure page. Open the app at http://localhost:8000 on this computer, " +
        "or use the deployed HTTPS (GitHub Pages) URL. You appear to be on " + location.origin + ". " +
        "Meanwhile use “Take / choose photo”.";
    }
    return "This browser does not expose a webcam API. Use “Take / choose photo” instead.";
  }
  return null;
}

// ---- webcam capture modal ----
function openWebcamCapture(onCapture) {
  const reason = webcamBlockReason();
  if (reason) { toastErr(reason); return; }

  const video = h("video", { autoplay: true, muted: true,
    style: "width:100%;max-height:60vh;background:#000;border-radius:8px" });
  video.setAttribute("playsinline", "");
  video.muted = true;
  const info = h("div.muted", { style: "font-size:.82rem;margin-top:6px", text: "Starting camera…" });
  const body = h("div", [video, info]);

  let stream = null;
  const m = openModal({ title: "Capture from webcam", body, onClose: stopStream });

  const captureBtn = h("button.btn.btn--primary", { text: "Capture", disabled: true });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), captureBtn]);

  function stopStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
      video.srcObject = stream;
      await video.play().catch(() => {});
      info.textContent = "Point the camera at the item, then Capture.";
      captureBtn.disabled = false;
    } catch (e) {
      info.textContent = "";
      const name = e && e.name;
      const msg = name === "NotAllowedError" || name === "SecurityError"
        ? "Camera permission was denied. Allow camera access for this site in your browser settings and try again."
        : name === "NotFoundError" || name === "OverconstrainedError"
        ? "No camera was found on this device."
        : name === "NotReadableError"
        ? "The camera is in use by another app. Close it and try again."
        : "Could not start the camera" + (e && e.message ? " (" + e.message + ")." : ".");
      toastErr(msg);
      m.close();
    }
  })();

  captureBtn.addEventListener("click", () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { toastErr("Camera not ready yet."); return; }
    const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
    stopStream();
    m.close();
    onCapture({ base64: dataUrl.split(",")[1], mime: "image/jpeg" });
  });
}

function previewSrc(fileId) {
  if (!fileId) return "";
  if (String(fileId).startsWith("data:") || String(fileId).startsWith("http")) return fileId;
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w400`;
}

function downscaleFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, MAX_DIM / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
      resolve({ base64: dataUrl.split(",")[1], mime: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}
