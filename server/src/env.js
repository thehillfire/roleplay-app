// Reads an integer setting; 0 is allowed, junk falls back to the default with a warning.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  console.warn(`${name}=${raw} is not a whole number; using ${fallback}`);
  return fallback;
}

module.exports = { envInt };
