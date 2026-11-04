// Synthetically generated check digits for in-memory/local test fixtures only.
// These values never represent a verified person and must not seed production.
let sequence = 700000000;
export function syntheticFiscalDocument() {
  const digits = String(++sequence).padStart(9, '0').split('').map(Number);
  const digit = (weight) => { const rest = digits.reduce((sum, n, index) => sum + n * (weight - index), 0) % 11; return rest < 2 ? 0 : 11 - rest; };
  digits.push(digit(10)); digits.push(digit(11));
  return digits.join('');
}
