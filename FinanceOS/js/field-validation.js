/** Field-level validation UI — highlight only invalid fields */
import { $ } from './utils.js';

const FIELD_DOM = {
  supplier: { wrap: () => $('#fld-supplier')?.closest('.field'), input: () => $('#fld-supplier') },
  afm: { wrap: () => $('#fld-afm')?.closest('.field'), input: () => $('#fld-afm') },
  invoice_number: { wrap: () => $('#fld-invno')?.closest('.field'), input: () => $('#fld-invno') },
  invoice_date: { wrap: () => $('#fld-date')?.closest('.field'), input: () => $('#fld-date') },
  sap_doc_number: { wrap: () => $('#fld-sap-manual')?.closest('.field') || $('#fld-sap')?.closest('.field'), input: () => $('#fld-sap-manual') },
};

export function clearFieldValidation() {
  document.querySelectorAll('.field--error').forEach((el) => el.classList.remove('field--error'));
  document.querySelectorAll('.field-error-msg').forEach((el) => el.remove());
  const box = $('#validation-errors');
  if (box) box.hidden = true;
}

export function applyFieldValidation(errors = []) {
  clearFieldValidation();
  if (!errors.length) return;

  const box = $('#validation-errors');
  if (box) {
    box.innerHTML = '<div class="validation-errors-title">Διορθώστε τα σημειωμένα πεδία</div><ul></ul>';
    const ul = box.querySelector('ul');
    const seen = new Set();
    for (const err of errors) {
      if (seen.has(err.field)) continue;
      seen.add(err.field);
      const li = document.createElement('li');
      li.textContent = err.message;
      ul.appendChild(li);
      const meta = FIELD_DOM[err.field];
      const wrap = meta?.wrap?.();
      if (wrap) {
        wrap.classList.add('field--error');
        if (!wrap.querySelector('.field-error-msg')) {
          const hint = document.createElement('div');
          hint.className = 'field-error-msg';
          hint.textContent = err.message;
          wrap.appendChild(hint);
        }
      }
    }
    box.hidden = false;
  }
}

export function bindFieldValidationClear() {
  for (const meta of Object.values(FIELD_DOM)) {
    const input = meta.input?.();
    if (!input || input._valBound) continue;
    input._valBound = true;
    input.addEventListener('input', () => {
      const wrap = meta.wrap?.();
      if (wrap?.classList.contains('field--error')) {
        wrap.classList.remove('field--error');
        wrap.querySelector('.field-error-msg')?.remove();
      }
    });
    input.addEventListener('change', () => {
      const wrap = meta.wrap?.();
      wrap?.classList.remove('field--error');
      wrap?.querySelector('.field-error-msg')?.remove();
    });
  }
  const sapSel = $('#fld-sap');
  if (sapSel && !sapSel._valBound) {
    sapSel._valBound = true;
    sapSel.addEventListener('change', clearFieldValidation);
  }
}
