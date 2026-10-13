import { useRef } from 'react';
import { stockOf, totalsBySku } from './cart';
import { NODES } from './config';
import { regionMode } from './components/Regions';

/**
 * Stock reservations: how many units one region may still sell.
 *
 * While a region is fully connected it may sell anything that is left. The moment it loses a link
 * it can no longer see what the others sell, so it is limited to its reserved share: an equal
 * part of what was left when the link dropped. The shares add up to at most what was left, so
 * the regions cannot oversell between them, and nothing needs repairing after the merge.
 *
 * capFor(sku) is the most units the region's cart may hold of a product right now.
 */
export function useReservations(nodes, region) {
  const frozen = useRef({}); // region -> { sku: units in the cart when the link dropped }
  const { mode } = regionMode(nodes, region);
  const node = nodes[region];
  const totals = node && node.state === 'up' ? totalsBySku(node.reports) : null;

  // Keep the picture fresh while connected; keep it as it was the moment the link dropped.
  if (totals && (mode === 'normal' || !frozen.current[region])) frozen.current[region] = totals;

  const reserved = mode !== 'normal' && mode !== 'connecting' && Boolean(frozen.current[region]);

  const capFor = (sku) => {
    if (!reserved) return stockOf(sku);
    const atDrop = frozen.current[region][sku] || 0;
    const left = Math.max(0, stockOf(sku) - atDrop);
    return atDrop + Math.floor(left / NODES.length);
  };

  /** Units this region may still add of one product. */
  const roomFor = (sku) => Math.max(0, capFor(sku) - ((totals && totals[sku]) || 0));

  return { reserved, mode, capFor, roomFor };
}
