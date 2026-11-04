// Preserve editable state while rebuilding translated product chrome.
// The shell's own controls (account menu, scope search: [data-shell-panel]) are rebuilt with the new
// language and the current choices, so they are neither captured nor restored.
const editable = node => node.id !== 'locale-select' && node.type !== 'file' && node.type !== 'password' && !node.closest?.('[data-shell-panel]');
export function captureLocaleFormState(root) {
  const fields = [...root.querySelectorAll('input,textarea,select')].filter(editable);
  const records = fields.map((node, index) => ({ id: node.id, name: node.name, index, value: node.value, checked: node.checked, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd, focused: node === root.ownerDocument.activeElement }));
  return records;
}
export function restoreLocaleFormState(root, records) {
  const fields = [...root.querySelectorAll('input,textarea,select')].filter(editable);
  for (const record of records) {
    const node = record.id ? fields.find(field => field.id === record.id) : fields[record.index];
    if (!node || node.name !== record.name) continue;
    node.value = record.value;
    if (typeof record.checked === 'boolean') node.checked = record.checked;
    if (record.focused) { node.focus({ preventScroll: true }); if (typeof record.selectionStart === 'number') try { node.setSelectionRange(record.selectionStart, record.selectionEnd); } catch {} }
  }
}
