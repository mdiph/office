import { h } from "../util/dom.js";

// buildForm(fields) where each field:
//   { name, label, type: text|number|date|select|textarea|checkbox|datalist,
//     required, options:[], value, min, placeholder, help, full, list }
// Returns { el, getValues, setError, validate, setValue, field(name) }
export function buildForm(fields) {
  const grid = h("form.formgrid");
  const controls = {};
  const errEls = {};

  fields.forEach((f) => {
    if (f.type === "hidden") { controls[f.name] = { _hidden: true, value: f.value }; return; }
    const wrap = h(`div.field${f.full ? ".full" : ""}`);
    const id = "f_" + f.name;
    wrap.appendChild(h("label", { for: id, text: f.label + (f.required ? " *" : "") }));

    let input;
    if (f.type === "select") {
      input = h("select", { id });
      (f.options || []).forEach((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        input.appendChild(h("option", { value: opt.value, text: opt.label }));
      });
      if (f.value !== undefined) input.value = f.value;
    } else if (f.type === "textarea") {
      input = h("textarea", { id, rows: f.rows || 3, placeholder: f.placeholder || "" });
      if (f.value) input.value = f.value;
    } else if (f.type === "checkbox") {
      input = h("input", { id, type: "checkbox" });
      input.checked = !!f.value;
    } else if (f.type === "datalist") {
      const listId = id + "_list";
      input = h("input", { id, type: "text", placeholder: f.placeholder || "", autocomplete: "off" });
      input.setAttribute("list", listId);
      const dl = h("datalist", { id: listId }, (f.options || []).map((o) => h("option", { value: o })));
      wrap.appendChild(dl);
      if (f.value) input.value = f.value;
    } else {
      input = h("input", { id, type: f.type || "text", placeholder: f.placeholder || "" });
      if (f.min !== undefined) input.min = f.min;
      if (f.step !== undefined) input.step = f.step;
      if (f.value !== undefined && f.value !== null) input.value = f.value;
    }
    input.dataset.field = f.name;
    if (f.onInput) input.addEventListener("input", () => f.onInput(readOne(f, input), api));
    if (f.onChange) input.addEventListener("change", () => f.onChange(readOne(f, input), api));
    controls[f.name] = input;
    wrap.appendChild(input);

    if (f.help) wrap.appendChild(h("div.muted", { style: "font-size:.8rem", text: f.help }));
    const e = h("div", { style: "color:var(--c-err);font-size:.8rem;display:none" });
    errEls[f.name] = e;
    wrap.appendChild(e);
    grid.appendChild(wrap);
  });

  function readOne(f, input) {
    if (f.type === "checkbox") return input.checked;
    if (f.type === "number") return input.value === "" ? null : Number(input.value);
    return input.value.trim ? input.value.trim() : input.value;
  }

  function getValues() {
    const out = {};
    fields.forEach((f) => {
      const c = controls[f.name];
      if (c && c._hidden) { out[f.name] = c.value; return; }
      out[f.name] = readOne(f, c);
    });
    return out;
  }

  function setError(name, msg) {
    const e = errEls[name];
    if (!e) return;
    e.textContent = msg || "";
    e.style.display = msg ? "block" : "none";
  }

  function validate() {
    let ok = true;
    fields.forEach((f) => {
      setError(f.name, "");
      if (!f.required) return;
      const v = getValues()[f.name];
      if (v === "" || v === null || v === undefined || (f.type === "checkbox" && v === false && f.requireTrue)) {
        setError(f.name, "Required");
        ok = false;
      }
    });
    return ok;
  }

  const api = {
    el: grid, getValues, setError, validate,
    setValue(name, val) {
      const c = controls[name];
      if (!c || c._hidden) return;
      if (c.type === "checkbox") c.checked = !!val; else c.value = val ?? "";
    },
    setOptions(name, options, keep) {
      const c = controls[name];
      if (!c) return;
      const cur = keep ? c.value : null;
      if (c.tagName === "SELECT") {
        c.innerHTML = "";
        options.forEach((o) => {
          const opt = typeof o === "string" ? { value: o, label: o } : o;
          c.appendChild(h("option", { value: opt.value, text: opt.label }));
        });
        if (cur) c.value = cur;
      } else {
        // datalist
        const dl = grid.querySelector(`#f_${name}_list`);
        if (dl) { dl.innerHTML = ""; options.forEach((o) => dl.appendChild(h("option", { value: o }))); }
      }
    },
    field(name) { return controls[name]; },
    disable(v) { grid.querySelectorAll("input,select,textarea").forEach((el) => (el.disabled = v)); },
  };
  return api;
}
