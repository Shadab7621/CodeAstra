import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { Cart, Close } from './Icons';
import Panel, { Portal } from './Panel';
import { useToast } from './Toast';
import { Segmented } from './TopBar';

const COORDS = { mum: [19.076, 72.877], hyd: [17.385, 78.487], sin: [1.352, 103.82] };
const CART_PREFIX = 'cart-item:v1:';
const PRODUCTS = [
  { sku: 'sound-01', name: 'Wireless Headphones', category: 'Electronics', price: 2499, art: 'headphones' },
  { sku: 'home-02', name: 'Desk Lamp', category: 'Home', price: 1299, art: 'lamp' },
  { sku: 'travel-03', name: 'Travel Backpack', category: 'Accessories', price: 1899, art: 'backpack' },
  { sku: 'grocery-04', name: 'Coffee Beans', category: 'Grocery', price: 799, art: 'coffee' },
  { sku: 'daily-05', name: 'Steel Water Bottle', category: 'Lifestyle', price: 599, art: 'bottle' },
  { sku: 'care-06', name: 'First Aid Kit', category: 'Personal care', price: 499, art: 'kit' },
];

function cartItem(description) {
  if (!description?.startsWith(CART_PREFIX)) return null;
  try { return JSON.parse(description.slice(CART_PREFIX.length)); } catch { return null; }
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
  return <span className={`product-art art-${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{drawings[kind]}</svg></span>;
}

function Durability({ value }) {
  if (value === 'confirmed') return <span className="pill ok">Confirmed</span>;
  if (value === 'replicated') return <span className="pill info">Replicated</span>;
  if (value === 'local') return <span className="pill warn">Local only</span>;
  return <span className="muted">-</span>;
}

function AddToCart({ base, region, cartLines, onClose }) {
  const toast = useToast();
  const [quantities, setQuantities] = useState({});
  const [busySku, setBusySku] = useState('');
  const [added, setAdded] = useState({ count: 0, total: 0 });
  const [startingCart] = useState(() => ({
    count: cartLines.reduce((sum, { report }) => sum + report.severity, 0),
    total: cartLines.reduce((sum, { report, item }) => sum + item.price * report.severity, 0),
  }));

  const addProduct = async (product) => {
    const quantity = Number(quantities[product.sku] || 1);
    setBusySku(product.sku);
    try {
      await api.create(base, {
        // Each cart line is its own immutable event, so concurrent adds merge without
        // overwriting another region's cart update.
        incident_type: 'medical',
        severity: quantity,
        description: `${CART_PREFIX}${JSON.stringify({ sku: product.sku, name: product.name, category: product.category, price: product.price })}`,
        reporter: 'shopper',
        location: { lat: COORDS[region][0], lon: COORDS[region][1] },
      });
      setAdded((current) => ({
        count: current.count + quantity,
        total: current.total + product.price * quantity,
      }));
      toast(`Added ${quantity} × ${product.name} to the ${REGION[region].name} cart.`);
    } catch (err) {
      toast(`Could not add product: ${err.message}`, 'bad');
    } finally {
      setBusySku('');
    }
  };

  return (
    <Portal>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="modal product-modal"
        initial={{ opacity: 0, x: '-50%', y: '-46%', scale: 0.97 }}
        animate={{ opacity: 1, x: '-50%', y: '-50%', scale: 1 }}
        exit={{ opacity: 0, x: '-50%', y: '-48%' }}
        transition={{ duration: 0.22 }}
      >
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="product-modal-heading">
            <div className="product-store-label">CodeAstra Store</div>
            <h2>Shop products</h2>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Adding to the {REGION[region].name} cart</div>
          </div>
          <button type="button" className="icon-btn" style={{ flex: 'none' }} onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="product-grid">
          {PRODUCTS.map((product) => (
            <article className="product-card" key={product.sku}>
              <div className="product-card-main">
                <ProductArtwork kind={product.art} />
                <div className="product-card-copy">
                  <div className="product-category">{product.category}</div>
                  <h3>{product.name}</h3>
                </div>
              </div>
              <div className="product-card-buy">
                <div className="product-price">{money(product.price)}</div>
                <div className="product-buy-controls">
                  <label className="product-quantity">
                    <span>Qty</span>
                    <select aria-label={`Quantity for ${product.name}`} value={quantities[product.sku] || 1}
                      onChange={(e) => setQuantities((q) => ({ ...q, [product.sku]: e.target.value }))}>
                      {[1, 2, 3, 4, 5].map((qty) => <option key={qty} value={qty}>{qty}</option>)}
                    </select>
                  </label>
                  <button type="button" className="btn product-add"
                disabled={Boolean(busySku)} onClick={() => addProduct(product)}>
                    <Cart /><span className="product-add-label">{busySku === product.sku ? 'Adding...' : 'Add to cart'}</span>
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        <footer className="product-cart-summary">
          <span>Subtotal ({startingCart.count + added.count} {startingCart.count + added.count === 1 ? 'item' : 'items'})</span>
          <strong>{money(startingCart.total + added.total)}</strong>
        </footer>
      </motion.div>
    </Portal>
  );
}

export default function Reports({ nodes, urls, selected, onSelect }) {
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState({});
  const seen = useRef({});

  const node = nodes[selected];
  const reports = node && node.state === 'up' ? node.reports : null;
  const cartLines = reports?.map((report) => ({ report, item: cartItem(report.description) }))
    .filter(({ item }) => item) || [];
  const itemCount = cartLines.reduce((sum, { report }) => sum + report.severity, 0);

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
              <tr><th>Item</th><th>Unit price</th><th>Quantity</th><th>Total</th><th>Replication</th></tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {cartLines.map(({ report: r, item }) => (
                  <motion.tr
                    key={r.report_id} layout
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className={`cart-line ${flash[r.report_id] ? 'flash' : ''}`}
                  >
                    <td className="cart-item-cell">
                      <div className="cart-item-name">{item.name}</div>
                      <div className="cart-item-meta">{item.category}</div>
                    </td>
                    <td className="cart-number">{money(item.price)}</td>
                    <td><span className="cart-quantity">{r.severity}</span></td>
                    <td className="cart-number cart-line-total">{money(item.price * r.severity)}</td>
                    <td><Durability value={r.durability} /></td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
          </div>
          <footer className="cart-summary">
            <div className="cart-summary-note">{itemCount} {itemCount === 1 ? 'item' : 'items'} in {REGION[selected].name}</div>
            <div className="cart-summary-help">Cart items appear in other regions when the replication links are connected.</div>
          </footer>
        </div>
      )}

      <AnimatePresence>
        {creating && <AddToCart key="cart" base={urls[selected]} region={selected} cartLines={cartLines} onClose={() => setCreating(false)} />}
      </AnimatePresence>
    </Panel>
  );
}
