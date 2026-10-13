// Cart helpers shared by the cart table and the conflict ledger.
export const CART_PREFIX = 'cart-item:v1:';
export const COORDS = { mum: [19.076, 72.877], hyd: [17.385, 78.487], sin: [1.352, 103.82] };

// Units available per product. Catalog data: it lives in the dashboard, not in the engine.
export const STOCK = {
  'sound-01': 12, 'home-02': 8, 'travel-03': 6, 'grocery-04': 20, 'daily-05': 15, 'care-06': 10,
};
export const stockOf = (sku) => STOCK[sku] ?? Infinity;

/**
 * Reservations stop a cut-off region from overselling by limiting it to its share of the stock.
 * They are switched off so both regions can sell on their own view while apart: the oversell is
 * then detected after the reconnect, shown in the conflict ledger and trimmed by Auto resolve.
 * Set to true to prevent the oversell instead.
 */
export const RESERVATIONS_ENABLED = false;

export function cartItem(description) {
  if (!description?.startsWith(CART_PREFIX)) return null;
  try { return JSON.parse(description.slice(CART_PREFIX.length)); } catch { return null; }
}

/** A cart line's quantity: an edited line carries it in `qty`, a freshly added one in severity. */
export const lineQty = (report, item) => (Number.isFinite(item.qty) ? item.qty : report.severity);

/** Which region a line was written in, from the location the add was made at. */
function regionOf(report) {
  const { lat, lon } = report.location || {};
  if (!Number.isFinite(lat)) return null;
  let best = null;
  let bestD = Infinity;
  for (const [id, [la, lo]] of Object.entries(COORDS)) {
    const d = (la - lat) ** 2 + (lo - lon) ** 2;
    if (d < bestD) { best = id; bestD = d; }
  }
  return best;
}

/**
 * Products whose merged quantity is more than the stock. Each region checked stock on its own while
 * apart, so after the merge the total can pass it. Lines are listed oldest first.
 */
export function findStockIssues(reports) {
  const bySku = new Map();
  for (const report of reports || []) {
    const item = cartItem(report.description);
    if (!item) continue;
    const entry = bySku.get(item.sku) || { sku: item.sku, name: item.name, lines: [], requested: 0 };
    const qty = lineQty(report, item);
    entry.requested += qty;
    entry.lines.push({ report, item, qty, region: regionOf(report), at: report.last_updated?.wall ?? 0 });
    bySku.set(item.sku, entry);
  }
  return [...bySku.values()]
    .map((e) => ({ ...e, stock: stockOf(e.sku), over: e.requested - stockOf(e.sku),
      lines: e.lines.sort((a, b) => a.at - b.at) }))
    .filter((e) => e.over > 0);
}

/** Units of each product currently in one region's cart: { sku: quantity }. */
export function totalsBySku(reports) {
  const totals = {};
  for (const report of reports || []) {
    const item = cartItem(report.description);
    if (!item) continue;
    totals[item.sku] = (totals[item.sku] || 0) + lineQty(report, item);
  }
  return totals;
}

/** The edits that bring a product back within stock: newest lines are cut first. */
export function stockFixes(issue) {
  let excess = issue.over;
  const fixes = [];
  for (const line of [...issue.lines].reverse()) {
    if (excess <= 0) break;
    const cut = Math.min(line.qty, excess);
    fixes.push({ line, cut, to: line.qty - cut });
    excess -= cut;
  }
  return fixes;
}
