import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { CART_PREFIX, COORDS, cartItem, lineQty, stockOf } from '../cart';
import { Arrow, Cart, Check, Close } from './Icons';
import Panel, { Portal } from './Panel';
import { useToast } from './Toast';
import { Segmented } from './TopBar';

const PRODUCTS = [
  { sku: 'sound-01', name: 'Wireless Headphones', category: 'Electronics', price: 2499, art: 'headphones' },
  { sku: 'home-02', name: 'Desk Lamp', category: 'Home', price: 1299, art: 'lamp' },
  { sku: 'travel-03', name: 'Travel Backpack', category: 'Accessories', price: 1899, art: 'backpack' },
  { sku: 'grocery-04', name: 'Coffee Beans', category: 'Grocery', price: 799, art: 'coffee' },
  { sku: 'daily-05', name: 'Steel Water Bottle', category: 'Lifestyle', price: 599, art: 'bottle' },
  { sku: 'care-06', name: 'First Aid Kit', category: 'Personal care', price: 499, art: 'kit' },
];

const DURABILITY_RANK = { local: 0, replicated: 1, confirmed: 2 };

/**
 * One row per product. Every "Add to cart" is its own record, so the same product added in two
 * regions while apart arrives as two records. Quantities add up, so no add is lost, and every
 * region shows the same row once it holds the same records.
 */
function mergeLines(cartLines) {
  const byProduct = new Map();
  for (const { report, item } of cartLines) {
    const row = byProduct.get(item.sku) || { sku: item.sku, item, quantity: 0, adds: 0, ids: [], durability: 'confirmed' };
    row.quantity += lineQty(report, item);
    row.adds += 1;
    row.ids.push(report.report_id);
    if ((DURABILITY_RANK[report.durability] ?? 0) < DURABILITY_RANK[row.durability]) row.durability = report.durability;
    byProduct.set(item.sku, row);
  }
  return [...byProduct.values()];
}

const money = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;

function ProductArtwork({ kind }) {
  const drawings = {
    headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="7" rx="2" /><rect x="17" y="13" width="4" height="7" rx="2" /></>,
    lamp: <><path d="M8 5h8l3 6H5z" /><path d="M12 11v7M8 20h8" /><path d="M9 3h6" /></>,
    backpack: <><path d="M7 8a5 5 0 0 1 10 0" /><rect x="5" y="7" width="14" height="15" rx="3" /><path d="M9 13h6v5H9zM5 13h3M16 13h3" /></>,
    coffee: <><path d="M5 7h12v9a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" /><path d="M17 9h2a2 2 0 0 1 0 4h-2M8 4v1M12 3v2M15 4v1" /></>,
    bottle: <><path d="M10 3h4v3l2 2v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V8l2-2z" /><path d="M9 12h6M10 3h4" /></>,
    kit: <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M9 8V5h6v3M12 11v6M9 14h6" /></>,
  };
  return <span className={`product-art art-${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{drawings[kind]}</svg></span>;
}

function Durability({ value }) {
  if (value === 'confirmed') return <span className="pill ok">Confirmed</span>;
  if (value === 'replicated') return <span className="pill info">Replicated</span>;
  if (value === 'local') return <span className="pill warn">Local only</span>;
  return <span className="muted">-</span>;
}

function AddToCart({ base, region, cartLines, reserve, onClose }) {
  const toast = useToast();
  const [quantities, setQuantities] = useState({});
  const [busySku, setBusySku] = useState('');
  const [addedSku, setAddedSku] = useState('');
  const [added, setAdded] = useState({ count: 0, total: 0 });
  const [addedBy, setAddedBy] = useState({});
  const [startBy] = useState(() => {
    const by = {};
    for (const { report, item } of cartLines) by[item.sku] = (by[item.sku] || 0) + lineQty(report, item);
    return by;
  });
  const [startingCart] = useState(() => ({
    count: cartLines.reduce((sum, { report, item }) => sum + lineQty(report, item), 0),
    total: cartLines.reduce((sum, { report, item }) => sum + item.price * lineQty(report, item), 0),
  }));

  // Units this region may still add of a product. While a link is down that is its reserved share.
  const roomFor = (sku) => {
    if (!reserve) return Math.max(0, stockOf(sku) - (startBy[sku] || 0) - (addedBy[sku] || 0));
    const optimistic = reserve.capFor(sku) - (startBy[sku] || 0) - (addedBy[sku] || 0);
    return Math.max(0, Math.min(reserve.roomFor(sku), optimistic));
  };

  const updateQty = (sku, delta) => {
    setQuantities((prev) => {
      const cur = prev[sku] || 1;
      const next = Math.max(1, Math.min(10, Math.max(1, roomFor(sku)), cur + delta));
      return { ...prev, [sku]: next };
    });
  };

  const addProduct = async (product) => {
    const quantity = Math.min(Number(quantities[product.sku] || 1), roomFor(product.sku));
    if (quantity < 1) return;
    setBusySku(product.sku);
    try {
      await api.create(base, {
        incident_type: 'medical',
        // The engine accepts severity 1-5 only, so the real quantity travels in the line itself.
        severity: Math.min(quantity, 5),
        description: `${CART_PREFIX}${JSON.stringify({ sku: product.sku, name: product.name, category: product.category, price: product.price, qty: quantity })}`,
        reporter: 'shopper',
        location: { lat: COORDS[region][0], lon: COORDS[region][1] },
      });
      setAddedBy((cur) => ({ ...cur, [product.sku]: (cur[product.sku] || 0) + quantity }));
      setQuantities((cur) => ({ ...cur, [product.sku]: 1 }));
      setAdded((current) => ({
        count: current.count + quantity,
        total: current.total + product.price * quantity,
      }));
      setAddedSku(product.sku);
      setTimeout(() => setAddedSku((prev) => (prev === product.sku ? '' : prev)), 2200);
      toast(`${quantity} × ${product.name} added to ${REGION[region].name} cart.`, 'ok', 'Item Added to Cart');
    } catch (err) {
      toast(`Could not add product: ${err.message}`, 'bad', 'Error Adding Item');
    } finally {
      setBusySku('');
    }
  };

  const totalItems = startingCart.count + added.count;
  const totalPrice = startingCart.total + added.total;

  return (
    <Portal>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="modal product-modal"
        initial={{ opacity: 0, x: '-50%', y: '-46%', scale: 0.96 }}
        animate={{ opacity: 1, x: '-50%', y: '-50%', scale: 1 }}
        exit={{ opacity: 0, x: '-50%', y: '-48%' }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="product-modal-head">
          <div className="product-modal-title-group">
            <div className="store-badge">
              <span className="store-badge-dot" />
              <span>CODEASTRA CATALOG</span>
            </div>
            <h2>Shop &amp; Add Products</h2>
            <div className="product-modal-sub">
              Active Store: <strong>{REGION[region].name}</strong> · Concurrent cart writes replicate across nodes
            </div>
          </div>
          <button type="button" className="icon-btn modal-close-btn" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </div>

        <div className="product-grid">
          {PRODUCTS.map((product) => {
            const currentQty = quantities[product.sku] || 1;
            const isBusy = busySku === product.sku;
            const isJustAdded = addedSku === product.sku;

            return (
              <article className="product-card" key={product.sku}>
                <div className="product-card-top">
                  <ProductArtwork kind={product.art} />
                  <div className="product-card-details">
                    <span className="product-category-tag">{product.category}</span>
                    <h3 className="product-title">{product.name}</h3>
                  </div>
                </div>

                <div className="product-card-bottom">
                  <div className="product-price-row">
                    <span className="product-price">{money(product.price)}</span>
                    <span className="product-price-unit">/ unit</span>
                    <span className="product-stock-pill">
                      {reserve && reserve.reserved
                        ? `${roomFor(product.sku)} reserved here`
                        : `${stockOf(product.sku)} units in stock`}
                    </span>
                  </div>

                  <div className="product-actions-row">
                    <div className="product-stepper" role="group" aria-label={`Quantity for ${product.name}`}>
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => updateQty(product.sku, -1)}
                        disabled={currentQty <= 1 || isBusy}
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="stepper-count">{currentQty}</span>
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => updateQty(product.sku, 1)}
                        disabled={currentQty >= Math.min(10, roomFor(product.sku)) || isBusy}
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>

                    <button
                      type="button"
                      className={`btn product-add-btn ${isJustAdded ? 'is-added' : ''}`}
                      disabled={Boolean(busySku) || roomFor(product.sku) < 1}
                      title={roomFor(product.sku) < 1 && reserve && reserve.reserved ? 'This region has used its reserved share. More becomes available when the links return.' : undefined}
                      onClick={() => addProduct(product)}
                    >
                      {isBusy ? (
                        <span>Adding...</span>
                      ) : isJustAdded ? (
                        <>
                          <Check />
                          <span>Added</span>
                        </>
                      ) : (
                        <>
                          <Cart />
                          <span>{roomFor(product.sku) < 1 ? 'Share used' : 'Add'}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <footer className="product-cart-summary">
          <div className="cart-summary-left">
            <span className="cart-pill-count">{totalItems} {totalItems === 1 ? 'item' : 'items'} in cart</span>
            <div className="cart-summary-price-box">
              <span className="cart-summary-label">Subtotal:</span>
              <strong className="cart-summary-price">{money(totalPrice)}</strong>
            </div>
          </div>
          <AnimatePresence>
            {addedSku && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="modal-inline-alert"
              >
                <span className="modal-alert-dot" />
                <span>Added to {REGION[region].name} cart!</span>
              </motion.div>
            )}
          </AnimatePresence>
          <button type="button" className="cart-done-btn" onClick={onClose}>
            <span>View Cart</span>
            <Arrow />
          </button>
        </footer>
      </motion.div>
    </Portal>
  );
}

export default function Reports({ nodes, urls, selected, onSelect, reserve }) {
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState({});
  const seen = useRef({});

  const node = nodes[selected];
  const reports = node && node.state === 'up' ? node.reports : null;
  const cartLines = reports?.map((report) => ({ report, item: cartItem(report.description) }))
    .filter(({ item }) => item) || [];
  const itemCount = cartLines.reduce((sum, { report, item }) => sum + lineQty(report, item), 0);
  const cartRows = mergeLines(cartLines);
  const toast = useToast();

  // Editing writes the new quantity into the line's first record. Two regions editing the same
  // line while apart produce a real conflict, which lands in the ledger.
  const changeQty = async (sku, delta) => {
    const lines = cartLines.filter(({ item }) => item.sku === sku);
    if (lines.length === 0) return;
    const { report, item } = lines[0];
    const total = cartRows.find((r) => r.sku === sku)?.quantity ?? 0;
    const cap = reserve ? reserve.capFor(sku) : stockOf(sku);
    if (delta > 0 && total >= cap) return;
    const next = Math.max(1, lineQty(report, item) + delta);
    if (next === lineQty(report, item)) return;
    try {
      await api.patch(urls[selected], report.report_id,
        { description: `${CART_PREFIX}${JSON.stringify({ ...item, qty: next })}` });
    } catch (err) {
      toast(`Could not change quantity: ${err.message}`, 'bad');
    }
  };

  // Briefly highlight rows that changed since the last poll.
  useEffect(() => {
    if (!reports) return undefined;
    const changed = {};
    for (const r of reports) {
      const sig = JSON.stringify([r.last_updated, r.durability, r.conflicts]);
      if (seen.current[r.report_id] !== undefined && seen.current[r.report_id] !== sig) changed[r.report_id] = true;
      seen.current[r.report_id] = sig;
    }
    if (Object.keys(changed).length === 0) return undefined;
    setFlash(changed);
    const t = setTimeout(() => setFlash({}), 1200);
    return () => clearTimeout(t);
  }, [reports]);

  useEffect(() => { seen.current = {}; }, [selected]);

  return (
    <Panel
      title="Your cart"
      hint={`Items added in ${REGION[selected].name}. Cart changes sync across connected regions.`}
      flush
      actions={(
        <>
          <Segmented id="region" label="Region to view" value={selected} onChange={onSelect}
            options={NODES.map((n) => ({ value: n, label: REGION[n].name }))} />
          <button className="btn btn-sm cart-browse-button" onClick={() => setCreating(true)} disabled={!node || node.state !== 'up'}>
            <Cart /> Continue shopping
          </button>
        </>
      )}
    >
      {reports === null ? (
        <div className="empty">
          {node && node.state === 'paused' ? `${REGION[selected].name} is paused.` : node ? `${REGION[selected].name} is unreachable.` : 'Connecting...'}
        </div>
      ) : cartLines.length === 0 ? (
        <div className="cart-empty">
          <div className="cart-empty-icon"><Cart /></div>
          <h3>Your cart is empty</h3>
          <p>Browse the demo store to add your first item.</p>
          <button className="btn cart-browse-button" onClick={() => setCreating(true)}>Browse products</button>
        </div>
      ) : (
        <div className="cart-content">
          <div className="table-wrap">
          <table className="cart-table">
            <thead>
              <tr><th>Item</th><th>Unit price</th><th>Total stock</th><th>Quantity</th><th>Total</th><th>Replication</th></tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {cartRows.map(({ sku, item, quantity, adds, ids, durability }) => (
                  <motion.tr
                    key={sku} layout
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className={`cart-line ${ids.some((id) => flash[id]) ? 'flash' : ''}`}
                  >
                    <td className="cart-item-cell">
                      <div className="cart-item-name">{item.name}</div>
                      <div className="cart-item-meta">
                        {item.category}{adds > 1 ? ` · ${adds} adds combined` : ''}
                      </div>
                    </td>
                    <td className="cart-number">{money(item.price)}</td>
                    <td className="cart-number">
                      {stockOf(sku)}
                      <div className="cart-item-meta">{quantity > stockOf(sku)
                        ? <span className="pill bad">Over stock by {quantity - stockOf(sku)}</span>
                        : `${stockOf(sku) - quantity} left after this cart`}</div>
                    </td>
                    <td>
                      <div className="product-stepper" role="group" aria-label={`Quantity for ${item.name}`}>
                        <button type="button" className="stepper-btn" aria-label="Decrease quantity"
                          disabled={quantity <= 1} onClick={() => changeQty(sku, -1)}>−</button>
                        <span className="stepper-count">{quantity}</span>
                        <button type="button" className="stepper-btn" aria-label="Increase quantity"
                          disabled={quantity >= (reserve ? reserve.capFor(sku) : stockOf(sku))} onClick={() => changeQty(sku, 1)}>+</button>
                      </div>
                    </td>
                    <td className="cart-number cart-line-total">{money(item.price * quantity)}</td>
                    <td><Durability value={durability} /></td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
          </div>
          <footer className="cart-summary">
            <div className="cart-summary-note">
              Total quantity in {REGION[selected].name}: <strong>{itemCount}</strong>
            </div>
            <div className="cart-summary-help">Cart items appear in other regions when the replication links are connected.</div>
          </footer>
        </div>
      )}

      <AnimatePresence>
        {creating && <AddToCart key="cart" base={urls[selected]} region={selected} cartLines={cartLines} reserve={reserve} onClose={() => setCreating(false)} />}
      </AnimatePresence>
    </Panel>
  );
}
